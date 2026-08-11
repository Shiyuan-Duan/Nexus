import { onSample, type Sample } from "./dataBus";
import { getItem, setItem, removeItem } from "../storage/storage";

export type RecordingEvent = {
  t: number;
  label: string;
};

export type RecordingMeta = {
  id: string;
  deviceId?: string;
  deviceType: string;
  name?: string;
  startedAt: number;
  endedAt?: number;
  sampleCount: number;
  columns: string[];
  eventNames: string[];
  events: RecordingEvent[];
  chunkCount: number;
};

export type ImportedRecordingParams = {
  deviceType: string;
  deviceId?: string;
  name?: string;
  startedAt?: number;
  endedAt?: number;
  columns: string[];
  rows: string[];
  sampleCount?: number;
  eventNames?: string[];
  events?: RecordingEvent[];
  onProgress?: (doneChunks: number, totalChunks: number) => void;
  shouldCancel?: () => boolean;
};

export type ImportRecordingSessionParams = {
  deviceType: string;
  deviceId?: string;
  name?: string;
  startedAt?: number;
  columns: string[];
  eventNames?: string[];
  events?: RecordingEvent[];
};

type ActiveRecording = {
  id: string;
  deviceType: string;
  deviceId?: string;
  name?: string;
  startedAt: number;
  sampleCount: number;
  columns: string[];
  eventNames: string[];
  events: RecordingEvent[];
  chunkIndex: number;
  buffer: string[];
};

type ImportRecordingSession = {
  id: string;
  deviceType: string;
  deviceId?: string;
  name: string;
  startedAt: number;
  columns: string[];
  eventNames: string[];
  events: RecordingEvent[];
  chunkIndex: number;
  sampleCount: number;
  buffer: string[];
};

const INDEX_KEY = "recordings:index";
const META_PREFIX = "recordings:meta:";
const DATA_PREFIX = "recordings:data:";
const MAX_LINES_PER_CHUNK = 200;
const PROGRESS_EMIT_MS = 500;

let loaded = false;
let recordings: Record<string, RecordingMeta> = {};
let active: ActiveRecording | null = null;
let sub: (() => void) | null = null;
let flushing = false;
let lastProgressEmitMs = 0;
const importSessions = new Map<string, ImportRecordingSession>();
const importWriteChains = new Map<string, Promise<void>>();

type Listener = () => void;
const listeners = new Set<Listener>();

function emitChange() {
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[recorder] listener error", e);
    }
  }
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const raw = await getItem(INDEX_KEY);
  if (!raw) return;
  try {
    const ids = JSON.parse(raw) as string[];
    const metaEntries = await Promise.all(
      ids.map(async (id) => {
        const m = await getItem(META_PREFIX + id);
        return m ? (JSON.parse(m) as RecordingMeta) : null;
      })
    );
    metaEntries.forEach((m) => {
      if (m) recordings[m.id] = m;
    });
  } catch {
    recordings = {};
  }
}

function nextId() {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `rec_${Date.now()}_${rnd}`;
}

function defaultName(deviceType: string, startedAt: number) {
  const ts = new Date(startedAt).toISOString().replace("T", " ").replace(/\..+/, "");
  return `${deviceType.toUpperCase()} ${ts}`;
}

async function withImportWriteLock<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
  const prev = importWriteChains.get(sessionId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(op);
  const settled = next.then(() => undefined, () => undefined);
  importWriteChains.set(sessionId, settled);
  try {
    return await next;
  } finally {
    if (importWriteChains.get(sessionId) === settled) {
      importWriteChains.delete(sessionId);
    }
  }
}

function uniqueName(preferred: string, excludeId?: string): string {
  const base = preferred.trim();
  if (!base) return base;
  const used = new Set(
    Object.values(recordings)
      .filter((m) => m.id !== excludeId)
      .map((m) => (m.name ?? "").trim())
      .filter((n) => n.length > 0)
  );
  if (!used.has(base)) return base;
  const c1 = `${base}_copy`;
  if (!used.has(c1)) return c1;
  let i = 2;
  while (used.has(`${base}_copy${i}`)) i += 1;
  return `${base}_copy${i}`;
}

function csvValue(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  return String(v);
}

function makeRow(tAbsMs: number, tDeviceMs: number, values: number[]): string {
  const row = [
    csvValue(tAbsMs),
    csvValue(tDeviceMs),
    csvValue(values[0]),
    csvValue(values[1]),
    csvValue(values[2]),
    csvValue(values[3]),
    csvValue(values[4]),
    csvValue(values[5]),
    csvValue(values[6]),
  ];
  return row.join(",");
}

async function persistIndex() {
  const ids = Object.keys(recordings);
  await setItem(INDEX_KEY, JSON.stringify(ids));
}

async function persistMeta(m: RecordingMeta) {
  await setItem(META_PREFIX + m.id, JSON.stringify(m));
}

async function flushBuffer() {
  if (flushing || !active) return;
  if (active.buffer.length === 0) return;
  flushing = true;
  try {
    while (active && active.buffer.length > 0) {
      const lines = active.buffer.splice(0, MAX_LINES_PER_CHUNK);
      const key = `${DATA_PREFIX}${active.id}:${active.chunkIndex}`;
      await setItem(key, lines.join("\n"));
      active.chunkIndex += 1;
      const meta = recordings[active.id];
      if (meta) {
        meta.chunkCount = active.chunkIndex;
        await persistMeta(meta);
      }
      lastProgressEmitMs = Date.now();
      emitChange();
    }
  } finally {
    flushing = false;
  }
}

function handleSample(s: Sample) {
  if (!active) return;
  if (s.kind !== active.deviceType) return;
  if (!active.deviceId) active.deviceId = s.deviceId;
  const tAbs = Date.now();
  const row = makeRow(tAbs, s.t, s.values);
  active.buffer.push(row);
  active.sampleCount += 1;
  const meta = recordings[active.id];
  if (meta) {
    meta.sampleCount = active.sampleCount;
    meta.deviceId = active.deviceId;
  }
  if (active.buffer.length >= MAX_LINES_PER_CHUNK) {
    void flushBuffer();
  }
  const now = Date.now();
  if (now - lastProgressEmitMs >= PROGRESS_EMIT_MS) {
    lastProgressEmitMs = now;
    emitChange();
  }
}

export async function startRecording(deviceType: string, eventNames: string[]): Promise<string> {
  await ensureLoaded();
  if (active) return active.id;
  const id = nextId();
  const startedAt = Date.now();
  const name = defaultName(deviceType, startedAt);
  const columns = [
    "t_ms",
    "t_ms_device",
    "x0",
    "y0",
    "z0",
    "x1",
    "y1",
    "z1",
    "temp_c",
  ];
  const meta: RecordingMeta = {
    id,
    deviceType,
    name,
    startedAt,
    sampleCount: 0,
    columns,
    eventNames,
    events: [],
    chunkCount: 0,
  };
  recordings[id] = meta;
  await persistMeta(meta);
  await persistIndex();
  active = {
    id,
    deviceType,
    name,
    startedAt,
    sampleCount: 0,
    columns,
    eventNames,
    events: [],
    chunkIndex: 0,
    buffer: [columns.join(",")],
  };
  lastProgressEmitMs = Date.now();
  if (!sub) sub = onSample(handleSample);
  emitChange();
  return id;
}

export async function stopRecording(): Promise<void> {
  if (!active) return;
  await flushBuffer();
  const meta = recordings[active.id];
  if (meta) {
    meta.endedAt = Date.now();
    meta.sampleCount = active.sampleCount;
    meta.deviceId = active.deviceId;
    meta.name = active.name;
    meta.eventNames = active.eventNames;
    meta.events = active.events;
    await persistMeta(meta);
  }
  active = null;
  lastProgressEmitMs = Date.now();
  emitChange();
}

export function isRecording(): boolean {
  return !!active;
}

export function getActiveRecordingId(): string | null {
  return active?.id ?? null;
}

export async function markEvent(label: string): Promise<void> {
  if (!active) return;
  const t = Date.now();
  const evt: RecordingEvent = {
    t,
    label,
  };
  active.events.push(evt);
  const meta = recordings[active.id];
  if (meta) {
    meta.events = active.events;
    await persistMeta(meta);
  }
  emitChange();
}

export function setEventNames(names: string[]) {
  if (!active) return;
  active.eventNames = names;
  const meta = recordings[active.id];
  if (meta) {
    meta.eventNames = names;
    void persistMeta(meta);
  }
  emitChange();
}

export async function listRecordings(): Promise<RecordingMeta[]> {
  await ensureLoaded();
  return Object.values(recordings).sort((a, b) => b.startedAt - a.startedAt);
}

export async function getRecordingMeta(id: string): Promise<RecordingMeta | null> {
  await ensureLoaded();
  return recordings[id] ?? null;
}

export async function getRecordingCsv(id: string): Promise<string> {
  await ensureLoaded();
  const meta = recordings[id];
  if (!meta) return "";
  const parts: string[] = [];
  for (let i = 0; i < meta.chunkCount; i += 1) {
    const chunk = await getItem(`${DATA_PREFIX}${id}:${i}`);
    if (chunk) parts.push(chunk);
  }
  return parts.join("\n");
}

export async function forEachRecordingCsvChunk(
  id: string,
  onChunk: (chunk: string, index: number, total: number) => Promise<void> | void
): Promise<void> {
  await ensureLoaded();
  const meta = recordings[id];
  if (!meta) return;
  for (let i = 0; i < meta.chunkCount; i += 1) {
    const chunk = await getItem(`${DATA_PREFIX}${id}:${i}`);
    if (!chunk) continue;
    await onChunk(chunk, i, meta.chunkCount);
  }
}

export async function renameRecording(id: string, name: string): Promise<void> {
  await ensureLoaded();
  const meta = recordings[id];
  if (!meta) return;
  const desired = name.trim() || meta.id;
  meta.name = uniqueName(desired, id) || meta.id;
  if (active && active.id === id) active.name = meta.name;
  await persistMeta(meta);
  emitChange();
}

export async function deleteRecording(id: string): Promise<void> {
  await ensureLoaded();
  if (active && active.id === id) return;
  const meta = recordings[id];
  if (!meta) return;
  for (let i = 0; i < meta.chunkCount; i += 1) {
    await removeItem(`${DATA_PREFIX}${id}:${i}`);
  }
  await removeItem(META_PREFIX + id);
  delete recordings[id];
  await persistIndex();
  emitChange();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function beginImportRecording(params: ImportRecordingSessionParams): Promise<string> {
  await ensureLoaded();
  const id = nextId();
  const startedAt = params.startedAt ?? Date.now();
  const requested = (params.name ?? defaultName(params.deviceType, startedAt)).trim() || id;
  const name = uniqueName(requested) || id;
  const columns = params.columns.length > 0 ? params.columns : ["t_ms", "t_ms_device"];
  const eventNames = params.eventNames ?? [];
  const events = params.events ?? [];
  const s: ImportRecordingSession = {
    id,
    deviceType: params.deviceType,
    deviceId: params.deviceId,
    name,
    startedAt,
    columns,
    eventNames,
    events,
    chunkIndex: 0,
    sampleCount: 0,
    buffer: [columns.join(",")],
  };
  importSessions.set(id, s);
  return id;
}

export async function appendImportRows(
  sessionId: string,
  rows: string[],
  onProgress?: (doneChunks: number, totalChunks: number) => void
): Promise<void> {
  await withImportWriteLock(sessionId, async () => {
    const s = importSessions.get(sessionId);
    if (!s || rows.length === 0) return;
    s.buffer.push(...rows);
    s.sampleCount += rows.length;
    while (s.buffer.length >= MAX_LINES_PER_CHUNK) {
      const lines = s.buffer.splice(0, MAX_LINES_PER_CHUNK);
      await setItem(`${DATA_PREFIX}${s.id}:${s.chunkIndex}`, lines.join("\n"));
      s.chunkIndex += 1;
      onProgress?.(s.chunkIndex, s.chunkIndex);
    }
  });
}

export async function finishImportRecording(
  sessionId: string,
  opts?: {
    endedAt?: number;
    startedAt?: number;
    sampleCount?: number;
  }
): Promise<string> {
  await ensureLoaded();
  return withImportWriteLock(sessionId, async () => {
    const s = importSessions.get(sessionId);
    if (!s) return sessionId;
    while (s.buffer.length > 0) {
      const lines = s.buffer.splice(0, MAX_LINES_PER_CHUNK);
      await setItem(`${DATA_PREFIX}${s.id}:${s.chunkIndex}`, lines.join("\n"));
      s.chunkIndex += 1;
    }
    const meta: RecordingMeta = {
      id: s.id,
      deviceId: s.deviceId,
      deviceType: s.deviceType,
      name: s.name,
      startedAt: opts?.startedAt ?? s.startedAt,
      endedAt: opts?.endedAt ?? Date.now(),
      sampleCount: opts?.sampleCount ?? s.sampleCount,
      columns: s.columns,
      eventNames: s.eventNames,
      events: s.events,
      chunkCount: s.chunkIndex,
    };
    recordings[s.id] = meta;
    await persistMeta(meta);
    await persistIndex();
    importSessions.delete(sessionId);
    emitChange();
    return s.id;
  });
}

export async function cancelImportRecording(sessionId: string): Promise<void> {
  await withImportWriteLock(sessionId, async () => {
    const s = importSessions.get(sessionId);
    if (!s) return;
    for (let i = 0; i < s.chunkIndex; i += 1) {
      await removeItem(`${DATA_PREFIX}${s.id}:${i}`);
    }
    importSessions.delete(sessionId);
  });
}

export async function importRecording(params: ImportedRecordingParams): Promise<string> {
  const id = await beginImportRecording({
    deviceType: params.deviceType,
    deviceId: params.deviceId,
    name: params.name,
    startedAt: params.startedAt,
    columns: params.columns,
    eventNames: params.eventNames,
    events: params.events,
  });
  const totalRows = params.rows.length;
  const totalChunks = Math.max(1, Math.ceil((totalRows + 1) / MAX_LINES_PER_CHUNK));
  for (let off = 0; off < totalRows; off += MAX_LINES_PER_CHUNK) {
    if (params.shouldCancel?.()) {
      await cancelImportRecording(id);
      throw new Error("import cancelled");
    }
    const lines = params.rows.slice(off, off + MAX_LINES_PER_CHUNK);
    await appendImportRows(id, lines);
    const done = Math.min(totalChunks, Math.ceil((off + lines.length + 1) / MAX_LINES_PER_CHUNK));
    params.onProgress?.(done, totalChunks);
  }
  return finishImportRecording(id, {
    endedAt: params.endedAt ?? Date.now(),
    startedAt: params.startedAt,
    sampleCount: params.sampleCount ?? totalRows,
  });
}
