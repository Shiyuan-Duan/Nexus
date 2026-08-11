export const MAX30003_SERVICE_UUID = "a0a4d780-96be-4222-b41e-98ea76b0120c";
export const MAX30003_CHAR_SWITCH = "a0a4d781-96be-4222-b41e-98ea76b0120c";
export const MAX30003_CHAR_STREAM = "a0a4d782-96be-4222-b41e-98ea76b0120c";
export const MAX30003_CHAR_CTRL = "a0a4d783-96be-4222-b41e-98ea76b0120c";
export const MAX30003_CHAR_FILE = "a0a4d784-96be-4222-b41e-98ea76b0120c";
export const MAX30003_CHAR_META = "a0a4d785-96be-4222-b41e-98ea76b0120c";

export const MAX30003_CMD_REC_START = 0x10;
export const MAX30003_CMD_REC_STOP = 0x11;
export const MAX30003_CMD_LIST = 0x12;
export const MAX30003_CMD_READ = 0x13;
export const MAX30003_CMD_DELETE = 0x14;
export const MAX30003_CMD_FORMAT = 0x15;
export const MAX30003_CMD_ABORT = 0x16;
export const MAX30003_CMD_TIME_SYNC = 0x20;
export const MAX30003_CMD_STATUS = 0x21;
export const MAX30003_CMD_RECOVER = 0x30;

export const MAX30003_NAME_MAX = 24;
export const MAX30003_SAMPLE_RATE = 512;
export const MAX30003_SAMPLE_PERIOD_MS = 1000 / MAX30003_SAMPLE_RATE;

export type Max30003ListEntry = {
  name: string;
  sampleCount: bigint;
  pageCount: number;
};

export type Max30003DeviceStatus = {
  streamActive: boolean;
  recordingActive: boolean;
  activeName: string;
  sampleCount: bigint;
  debug?: {
    activeIdx: number;
    acceptWrites: boolean;
    nextPage: number;
    queuedPages: number;
    droppedRecords: bigint;
    nandState?: number;
    nandStateText?: string;
    nandLastErr?: number;
    jedecId?: string;
    formatStage?: number;
    formatRc?: number;
    metaStage?: number;
    metaRc?: number;
  };
};

export type Max30003Ack = {
  cmd: number;
  status: number;
  nandReady?: boolean;
  rcRaw?: number;
  nandState?: number;
  nandStateText?: string;
  nandLastErr?: number;
  jedecId?: string;
  formatStage?: number;
  formatRc?: number;
  metaStage?: number;
  metaRc?: number;
};

export function encodeSwitch(on: boolean): Uint8Array {
  return new Uint8Array([on ? 1 : 0]);
}

export function encodeCtrlNoArg(cmd: number): Uint8Array {
  return new Uint8Array([cmd & 0xff]);
}

export function encodeCtrlName(cmd: number, name: string): Uint8Array {
  const bytes = asciiToBytes(name || "").slice(0, MAX30003_NAME_MAX);
  const out = new Uint8Array(1 + bytes.length);
  out[0] = cmd & 0xff;
  out.set(bytes, 1);
  return out;
}

export function encodeTimeSync(hostTimeMs: bigint, sampleIndex: bigint): Uint8Array {
  const out = new Uint8Array(1 + 16);
  out[0] = MAX30003_CMD_TIME_SYNC;
  putU64LE(out, 1, hostTimeMs);
  putU64LE(out, 9, sampleIndex);
  return out;
}

export function parseStreamSamples(data: Uint8Array): number[] {
  if (!data || data.length < 3) return [];
  const n = Math.floor(data.length / 3);
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = i * 3;
    out.push(int24be(data[p], data[p + 1], data[p + 2]));
  }
  return out;
}

export function parseMetaPacket(data: Uint8Array): { kind: string; text: string; entry?: Max30003ListEntry; status?: Max30003DeviceStatus; ack?: Max30003Ack } {
  if (!data || data.length === 0) return { kind: "unknown", text: "empty meta packet" };
  const t = data[0];
  if (t === 0x01 && data.length >= 14) {
    const nameLen = data[1] ?? 0;
    const nameEnd = Math.min(2 + nameLen, data.length);
    const name = bytesToAscii(data.slice(2, nameEnd));
    const sampleOff = 2 + nameLen;
    if (sampleOff + 12 <= data.length) {
      const sampleCount = getU64LE(data, sampleOff);
      const pageCount = getU32LE(data, sampleOff + 8);
      return {
        kind: "list_entry",
        text: `${name} | samples=${sampleCount.toString()} pages=${pageCount}`,
        entry: { name, sampleCount, pageCount },
      };
    }
    return { kind: "list_entry", text: `${name} | malformed entry` };
  }
  if (t === 0x02) return { kind: "list_end", text: "list done" };
  if (t === 0x03) return { kind: "read_end", text: "read done" };
  if (t === 0x10 && data.length >= 12) {
    const streamActive = (data[1] ?? 0) !== 0;
    const recordingActive = (data[2] ?? 0) !== 0;
    const nameLen = data[3] ?? 0;
    const nameEnd = Math.min(4 + nameLen, data.length);
    const activeName = bytesToAscii(data.slice(4, nameEnd));
    const sampleOff = 4 + nameLen;
    const sampleCount = (sampleOff + 8 <= data.length) ? getU64LE(data, sampleOff) : 0n;
    const debugOff = sampleOff + 8;
    const debug = (debugOff + 21 <= data.length) ? {
      activeIdx: getU32LE(data, debugOff),
      acceptWrites: (data[debugOff + 4] ?? 0) !== 0,
      nextPage: getU32LE(data, debugOff + 5),
      queuedPages: getU32LE(data, debugOff + 9),
      droppedRecords: getU64LE(data, debugOff + 13),
      ...(debugOff + 27 <= data.length ? {
        nandState: data[debugOff + 21] ?? 0,
        nandStateText: nandStateText(data[debugOff + 21] ?? 0),
        nandLastErr: getI16LE(data, debugOff + 22),
        jedecId: `${toHex(data[debugOff + 24])}${toHex(data[debugOff + 25])}${toHex(data[debugOff + 26])}`,
      } : {}),
      ...(debugOff + 33 <= data.length ? {
        formatStage: data[debugOff + 27] ?? 0,
        formatRc: getI16LE(data, debugOff + 28),
        metaStage: data[debugOff + 30] ?? 0,
        metaRc: getI16LE(data, debugOff + 31),
      } : {}),
    } : undefined;
    const debugText = debug
      ? ` active_idx=${debug.activeIdx} accept=${debug.acceptWrites ? 1 : 0} next_page=${debug.nextPage} queued=${debug.queuedPages} dropped=${debug.droppedRecords.toString()}${debug.nandStateText ? ` nand_state=${debug.nandStateText} nand_err=${debug.nandLastErr} jedec=${debug.jedecId}` : ""}${debug.formatStage !== undefined ? ` fmt=${debug.formatStage}/${debug.formatRc} meta=${debug.metaStage}/${debug.metaRc}` : ""}`
      : "";
    return {
      kind: "status",
      text: `status stream=${streamActive ? 1 : 0} rec=${recordingActive ? 1 : 0} name=${activeName || "-"} samples=${sampleCount.toString()}${debugText}`,
      status: { streamActive, recordingActive, activeName, sampleCount, debug },
    };
  }
  if (t === 0xf0 && data.length >= 3) {
    const cmd = data[1];
    const status = data[2] ?? 0;
    const hasVerbose = data.length >= 6;
    const nandReady = hasVerbose ? ((data[3] ?? 0) !== 0) : undefined;
    const rcRaw = hasVerbose ? getI16LE(data, 4) : undefined;
    const hasNandDebug = data.length >= 12;
    const nandState = hasNandDebug ? (data[6] ?? 0) : undefined;
    const nandStateLabel = hasNandDebug ? nandStateText(nandState ?? 0) : undefined;
    const nandLastErr = hasNandDebug ? getI16LE(data, 7) : undefined;
    const jedecId = hasNandDebug && data.length < 15 ? `${toHex(data[9])}${toHex(data[10])}${toHex(data[11])}` : undefined;
    const hasAckDebug = data.length >= 15;
    const formatStage = hasAckDebug ? (data[9] ?? 0) : undefined;
    const formatRc = hasAckDebug ? getI16LE(data, 10) : undefined;
    const metaStage = hasAckDebug ? (data[12] ?? 0) : undefined;
    const metaRc = hasAckDebug ? getI16LE(data, 13) : undefined;
    const nandDebugText = hasNandDebug ? ` nand_state=${nandStateLabel} nand_err=${nandLastErr}${jedecId ? ` jedec=${jedecId}` : ""}${hasAckDebug ? ` fmt=${formatStage}/${formatRc} meta=${metaStage}/${metaRc}` : ""}` : "";
    if (status === 0) {
      return { kind: "ack", text: `ack cmd=0x${toHex(cmd)} status=ok(0)${hasVerbose ? ` nand=${nandReady ? "ready" : "off"} rc=${rcRaw}` : ""}${nandDebugText}`, ack: { cmd: cmd ?? 0, status, nandReady, rcRaw, nandState, nandStateText: nandStateLabel, nandLastErr, jedecId, formatStage, formatRc, metaStage, metaRc } };
    }
    return { kind: "ack", text: `ack cmd=0x${toHex(cmd)} status=err(${status})${hasVerbose ? ` nand=${nandReady ? "ready" : "off"} rc=${rcRaw}` : ""}${nandDebugText}`, ack: { cmd: cmd ?? 0, status, nandReady, rcRaw, nandState, nandStateText: nandStateLabel, nandLastErr, jedecId, formatStage, formatRc, metaStage, metaRc } };
  }
  return { kind: "meta", text: `meta type=0x${toHex(t)} len=${data.length}` };
}

export type Max30003FilePacket =
  | { kind: "frame"; sample: number; payloadLen: number; payload: Uint8Array }
  | { kind: "time_sync"; hostTimeMs: bigint; sampleIndex: bigint; payloadLen: number; payload: Uint8Array }
  | { kind: "record"; payloadLen: number; payload: Uint8Array };

export function parseFilePackets(data: Uint8Array): Max30003FilePacket[] {
  if (!data || data.length < 2) return [];
  const out: Max30003FilePacket[] = [];
  let off = 0;
  while (off + 2 <= data.length) {
    const t = data[off] ?? 0;
    const payloadLen = data[off + 1] ?? 0;
    const end = off + 2 + payloadLen;
    if (end > data.length) break;
    const payload = data.slice(off + 2, end);
    if (t === 0x01 && payload.length >= 3) {
      out.push({ kind: "frame", sample: int24be(payload[0], payload[1], payload[2]), payloadLen, payload });
    } else if (t === 0x02 && payload.length >= 16) {
      out.push({
        kind: "time_sync",
        hostTimeMs: getU64LE(payload, 0),
        sampleIndex: getU64LE(payload, 8),
        payloadLen,
        payload,
      });
    } else {
      out.push({ kind: "record", payloadLen, payload });
    }
    off = end;
  }
  return out;
}

function int24be(b0: number, b1: number, b2: number): number {
  const v = ((b0 & 0xff) << 16) | ((b1 & 0xff) << 8) | (b2 & 0xff);
  return (v & 0x800000) ? (v - 0x1000000) : v;
}

function putU64LE(out: Uint8Array, off: number, v: bigint) {
  let x = v < 0n ? 0n : v;
  for (let i = 0; i < 8; i += 1) {
    out[off + i] = Number(x & 0xffn);
    x >>= 8n;
  }
}

function getU64LE(data: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i -= 1) {
    v = (v << 8n) | BigInt(data[off + i] ?? 0);
  }
  return v;
}

function getU32LE(data: Uint8Array, off: number): number {
  return (
    ((data[off] ?? 0) |
      ((data[off + 1] ?? 0) << 8) |
      ((data[off + 2] ?? 0) << 16) |
      ((data[off + 3] ?? 0) << 24)) >>> 0
  );
}

function getI16LE(data: Uint8Array, off: number): number {
  const lo = data[off] ?? 0;
  const hi = data[off + 1] ?? 0;
  const v = (hi << 8) | lo;
  return (v & 0x8000) ? (v - 0x10000) : v;
}

function asciiToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) {
    out[i] = s.charCodeAt(i) & 0x7f;
  }
  return out;
}

function bytesToAscii(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 1) {
    if (b[i] === 0) break;
    out += String.fromCharCode(b[i]);
  }
  return out;
}

function toHex(v: number | undefined): string {
  return ((v ?? 0) & 0xff).toString(16).padStart(2, "0");
}

function nandStateText(v: number): string {
  switch (v) {
    case 0: return "init";
    case 1: return "dev_not_ready";
    case 2: return "spi_not_ready";
    case 3: return "jedec_failed";
    case 4: return "fs_failed";
    case 5: return "ready";
    default: return `unknown_${v}`;
  }
}
