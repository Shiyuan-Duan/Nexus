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

const INDEX_KEY = "recordings:index";
const META_PREFIX = "recordings:meta:";
const DATA_PREFIX = "recordings:data:";
const MAX_LINES_PER_CHUNK = 200;

let loaded = false;
let recordings: Record<string, RecordingMeta> = {};
let active: ActiveRecording | null = null;
let sub: (() => void) | null = null;
let flushing = false;

type Listener = () => void;
const listeners = new Set<Listener>();

function emitChange() {
  for (const l of listeners) l();
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
  emitChange();
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

export async function renameRecording(id: string, name: string): Promise<void> {
  await ensureLoaded();
  const meta = recordings[id];
  if (!meta) return;
  meta.name = name.trim() || meta.id;
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
