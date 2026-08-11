// ADS1299 EEG streaming profile.

export const ADS1299_SERVICE_UUID = "4f6a9b50-6d4a-4f26-8f6a-3a0b2c1b21a0";
export const ADS1299_CHAR_SWITCH = "4f6a9b51-6d4a-4f26-8f6a-3a0b2c1b21a0";
export const ADS1299_CHAR_CTRL = "4f6a9b52-6d4a-4f26-8f6a-3a0b2c1b21a0";
export const ADS1299_CHAR_STREAM = "4f6a9b53-6d4a-4f26-8f6a-3a0b2c1b21a0";
export const ADS1299_CHAR_FILE = "4f6a9b54-6d4a-4f26-8f6a-3a0b2c1b21a0";
export const ADS1299_CHAR_META = "4f6a9b55-6d4a-4f26-8f6a-3a0b2c1b21a0";
export const ADS1299_CHAR_DEBUG = "4f6a9b56-6d4a-4f26-8f6a-3a0b2c1b21a0";

// Keep these command values aligned with firmware enum.
export const ADS1299_CMD_REC_START = 0x10;
export const ADS1299_CMD_REC_STOP = 0x11;
export const ADS1299_CMD_LIST = 0x12;
export const ADS1299_CMD_READ = 0x13;
export const ADS1299_CMD_DELETE = 0x14;
export const ADS1299_CMD_FORMAT = 0x15;
export const ADS1299_CMD_ABORT = 0x16;
export const ADS1299_CMD_TIME_SYNC = 0x20;
export const ADS1299_CMD_STATUS = 0x21;
export const ADS1299_CMD_RECOVER = 0x30;

export const ADS1299_NAME_MAX = 24;
export const ADS1299_FRAME_BYTES = 27; // status(3) + 8ch * 3 bytes
export const ADS1299_CHANNELS = 8;

export type Ads1299ListEntry = {
  name: string;
  sampleCount: bigint;
  pageCount: number;
};

export type Ads1299DeviceStatus = {
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
    formatStage?: number;
    formatRc?: number;
    metaStage?: number;
    metaRc?: number;
    streamPhase?: number;
    streamLoop?: number;
    streamSw?: boolean;
    streamRecOpen?: boolean;
    streamWant?: boolean;
    streamLocalActive?: boolean;
    streamStartAttempts?: number;
    streamStartOk?: number;
    streamReadEnter?: number;
    streamReadOk?: number;
    streamNotifyOk?: number;
    streamNotifyFail?: number;
  };
};

export type Ads1299Ack = {
  cmd: number;
  status: number;
  nandReady?: boolean;
  rcRaw?: number;
  nandState?: number;
  nandStateText?: string;
  nandLastErr?: number;
  formatStage?: number;
  formatRc?: number;
  metaStage?: number;
  metaRc?: number;
};

export type Ads1299DecodedFrame = {
  status: number;
  channels: number[];
};

export type Ads1299DecodedTimeSync = {
  hostTimeMs: bigint;
  sampleIndex: bigint;
};

export function encodeSwitch(on: boolean): Uint8Array {
  return new Uint8Array([on ? 1 : 0]);
}

export function encodeCtrlNoArg(cmd: number): Uint8Array {
  return new Uint8Array([cmd & 0xff]);
}

export function encodeCtrlName(cmd: number, name: string): Uint8Array {
  const bytes = asciiToBytes(name || "").slice(0, ADS1299_NAME_MAX);
  const out = new Uint8Array(1 + bytes.length);
  out[0] = cmd & 0xff;
  out.set(bytes, 1);
  return out;
}

export function encodeTimeSync(hostTimeMs: bigint, sampleIndex: bigint): Uint8Array {
  const out = new Uint8Array(1 + 16);
  out[0] = ADS1299_CMD_TIME_SYNC;
  putU64LE(out, 1, hostTimeMs);
  putU64LE(out, 9, sampleIndex);
  return out;
}

export function parseAds1299StreamChunk(data: Uint8Array): number[][] {
  if (!data || data.length < ADS1299_FRAME_BYTES) return [];
  const frames: number[][] = [];
  const n = Math.floor(data.length / ADS1299_FRAME_BYTES);
  for (let i = 0; i < n; i += 1) {
    const base = i * ADS1299_FRAME_BYTES;
    const ch: number[] = [];
    for (let c = 0; c < ADS1299_CHANNELS; c += 1) {
      const p = base + 3 + c * 3;
      ch.push(int24be(data[p], data[p + 1], data[p + 2]));
    }
    frames.push(ch);
  }
  return frames;
}

export function parseMetaPacket(data: Uint8Array): { kind: string; text: string; entry?: Ads1299ListEntry; status?: Ads1299DeviceStatus; ack?: Ads1299Ack } {
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
    const debug: Ads1299DeviceStatus["debug"] | undefined = (debugOff + 21 <= data.length) ? {
      activeIdx: getU32LE(data, debugOff),
      acceptWrites: (data[debugOff + 4] ?? 0) !== 0,
      nextPage: getU32LE(data, debugOff + 5),
      queuedPages: getU32LE(data, debugOff + 9),
      droppedRecords: getU64LE(data, debugOff + 13),
      ...(debugOff + 27 <= data.length ? {
        nandState: data[debugOff + 21] ?? 0,
        nandStateText: nandStateText(data[debugOff + 21] ?? 0),
        nandLastErr: getI16LE(data, debugOff + 22),
      } : {}),
      ...(debugOff + 33 <= data.length ? {
        formatStage: data[debugOff + 27] ?? 0,
        formatRc: getI16LE(data, debugOff + 28),
        metaStage: data[debugOff + 30] ?? 0,
        metaRc: getI16LE(data, debugOff + 31),
      } : {}),
    } : undefined;
    if (debug && debugOff + 54 <= data.length) {
      const streamOff = debugOff + 21;
      debug.streamPhase = data[streamOff] ?? 0;
      debug.streamLoop = getU32LE(data, streamOff + 1);
      debug.streamSw = (data[streamOff + 5] ?? 0) !== 0;
      debug.streamRecOpen = (data[streamOff + 6] ?? 0) !== 0;
      debug.streamWant = (data[streamOff + 7] ?? 0) !== 0;
      debug.streamLocalActive = (data[streamOff + 8] ?? 0) !== 0;
      debug.streamStartAttempts = getU32LE(data, streamOff + 9);
      debug.streamStartOk = getU32LE(data, streamOff + 13);
      debug.streamReadEnter = getU32LE(data, streamOff + 17);
      debug.streamReadOk = getU32LE(data, streamOff + 21);
      debug.streamNotifyOk = getU32LE(data, streamOff + 25);
      debug.streamNotifyFail = getU32LE(data, streamOff + 29);
    }
    const debugText = debug
      ? ` active_idx=${debug.activeIdx} accept=${debug.acceptWrites ? 1 : 0} next_page=${debug.nextPage} queued=${debug.queuedPages} dropped=${debug.droppedRecords.toString()}${debug.nandStateText ? ` nand_state=${debug.nandStateText} nand_err=${debug.nandLastErr}` : ""}${debug.formatStage !== undefined ? ` fmt=${debug.formatStage}/${debug.formatRc} meta=${debug.metaStage}/${debug.metaRc}` : ""}${debug.streamPhase !== undefined ? ` stream_phase=${debug.streamPhase} loop=${debug.streamLoop} sw=${debug.streamSw ? 1 : 0} rec_open=${debug.streamRecOpen ? 1 : 0} want=${debug.streamWant ? 1 : 0} local_active=${debug.streamLocalActive ? 1 : 0} start=${debug.streamStartAttempts}/${debug.streamStartOk} read=${debug.streamReadEnter}/${debug.streamReadOk} notify=${debug.streamNotifyOk}/${debug.streamNotifyFail}` : ""}`
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
    const hasAckDebug = data.length >= 15;
    const nandState = hasAckDebug ? (data[6] ?? 0) : undefined;
    const nandStateTextValue = hasAckDebug ? nandStateText(nandState ?? 0) : undefined;
    const nandLastErr = hasAckDebug ? getI16LE(data, 7) : undefined;
    const formatStage = hasAckDebug ? (data[9] ?? 0) : undefined;
    const formatRc = hasAckDebug ? getI16LE(data, 10) : undefined;
    const metaStage = hasAckDebug ? (data[12] ?? 0) : undefined;
    const metaRc = hasAckDebug ? getI16LE(data, 13) : undefined;
    const ackDebugText = hasAckDebug ? ` nand_state=${nandStateTextValue} nand_err=${nandLastErr} fmt=${formatStage}/${formatRc} meta=${metaStage}/${metaRc}` : "";
    if (status === 0) {
      if (hasVerbose) {
        return {
          kind: "ack",
          text: `ack cmd=0x${toHex(cmd)} status=ok(0) nand=${nandReady ? "ready" : "off"} rc=${rcRaw}${ackDebugText}`,
          ack: { cmd: cmd ?? 0, status, nandReady, rcRaw, nandState, nandStateText: nandStateTextValue, nandLastErr, formatStage, formatRc, metaStage, metaRc },
        };
      }
      return { kind: "ack", text: `ack cmd=0x${toHex(cmd)} status=ok(0)`, ack: { cmd: cmd ?? 0, status } };
    }
    const info = decodeErrno(status);
    if (hasVerbose) {
      return {
        kind: "ack",
        text: `ack cmd=0x${toHex(cmd)} status=err(${status}) ${info.name}: ${info.desc} nand=${nandReady ? "ready" : "off"} rc=${rcRaw}${ackDebugText}`,
        ack: { cmd: cmd ?? 0, status, nandReady, rcRaw, nandState, nandStateText: nandStateTextValue, nandLastErr, formatStage, formatRc, metaStage, metaRc },
      };
    }
    return {
      kind: "ack",
      text: `ack cmd=0x${toHex(cmd)} status=err(${status}) ${info.name}: ${info.desc}`,
      ack: { cmd: cmd ?? 0, status },
    };
  }
  return { kind: "meta", text: `meta type=0x${toHex(t)} len=${data.length}` };
}

export function parseFilePacket(data: Uint8Array): {
  kind: "frame" | "time_sync" | "record";
  payloadLen: number;
  payload: Uint8Array;
  frame?: Ads1299DecodedFrame;
  timeSync?: Ads1299DecodedTimeSync;
} {
  const packets = parseFilePackets(data);
  if (packets.length > 0) return packets[0];
  return { kind: "record", payloadLen: 0, payload: new Uint8Array(0) };
}

export function parseFilePackets(data: Uint8Array): {
  kind: "frame" | "time_sync" | "record";
  payloadLen: number;
  payload: Uint8Array;
  frame?: Ads1299DecodedFrame;
  timeSync?: Ads1299DecodedTimeSync;
}[] {
  if (!data || data.length < 2) {
    return [];
  }
  const out: {
    kind: "frame" | "time_sync" | "record";
    payloadLen: number;
    payload: Uint8Array;
    frame?: Ads1299DecodedFrame;
    timeSync?: Ads1299DecodedTimeSync;
  }[] = [];
  let off = 0;
  while (off + 2 <= data.length) {
    const t = data[off] ?? 0;
    const payloadLen = data[off + 1] ?? 0;
    const end = off + 2 + payloadLen;
    if (end > data.length) {
      break;
    }
    const payload = data.slice(off + 2, end);
    if (t === 0x01) {
      let frame: Ads1299DecodedFrame | undefined;
      if (payload.length >= ADS1299_FRAME_BYTES) {
        const status = ((payload[0] ?? 0) << 16) | ((payload[1] ?? 0) << 8) | (payload[2] ?? 0);
        const channels: number[] = [];
        for (let c = 0; c < ADS1299_CHANNELS; c += 1) {
          const p = 3 + c * 3;
          channels.push(int24be(payload[p], payload[p + 1], payload[p + 2]));
        }
        frame = { status: status >>> 0, channels };
      }
      out.push({ kind: "frame", payloadLen, payload, frame });
    } else if (t === 0x02) {
      let timeSync: Ads1299DecodedTimeSync | undefined;
      if (payload.length >= 16) {
        timeSync = {
          hostTimeMs: getU64LE(payload, 0),
          sampleIndex: getU64LE(payload, 8),
        };
      }
      out.push({ kind: "time_sync", payloadLen, payload, timeSync });
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
  const u = (lo | (hi << 8)) & 0xffff;
  return (u & 0x8000) ? (u - 0x10000) : u;
}

function toHex(v: number): string {
  return (v & 0xff).toString(16).padStart(2, "0");
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

function asciiToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function bytesToAscii(data: Uint8Array): string {
  let s = "";
  for (let i = 0; i < data.length; i += 1) {
    const c = data[i] ?? 0;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function parseDebugText(data: Uint8Array): string {
  return bytesToAscii(data);
}

function decodeErrno(code: number): { name: string; desc: string } {
  switch (code & 0xff) {
    case 1: return { name: "EGENERIC", desc: "generic failure (older firmware only reported 0/1)" };
    case 2: return { name: "ENOENT", desc: "target not found (file/name)" };
    case 11: return { name: "EAGAIN", desc: "device is still initializing; retry shortly" };
    case 12: return { name: "ENOMEM", desc: "no free file entry/buffer" };
    case 16: return { name: "EBUSY", desc: "another recording is already active" };
    case 17: return { name: "EEXIST", desc: "name already exists" };
    case 19: return { name: "ENODEV", desc: "nand not ready/not present" };
    case 22: return { name: "EINVAL", desc: "invalid command or argument" };
    case 28: return { name: "ENOSPC", desc: "storage full" };
    case 95: return { name: "EOPNOTSUPP", desc: "operation not supported" };
    case 117: return { name: "EUCLEAN", desc: "metadata/checksum or NAND ECC error; format or recover required" };
    default: return { name: "EUNKNOWN", desc: "unmapped errno, check firmware logs" };
  }
}
