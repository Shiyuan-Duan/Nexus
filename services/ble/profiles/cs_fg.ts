// Cachexia current source function generator profile

export const CSFG_SERVICE_UUID = "a0a4c690-96be-4222-b41e-98ea76b0120c";
export const CSFG_CHAR_SWITCH = "a0a4c691-96be-4222-b41e-98ea76b0120c";
export const CSFG_CHAR_CLEAR  = "a0a4c692-96be-4222-b41e-98ea76b0120c";
export const CSFG_CHAR_APPEND = "a0a4c693-96be-4222-b41e-98ea76b0120c";
export const CSFG_CHAR_COMMIT = "a0a4c694-96be-4222-b41e-98ea76b0120c";
export const CSFG_CHAR_INFO   = "a0a4c695-96be-4222-b41e-98ea76b0120c";

export const CSFG_MAX_ABS_MA = 25;
export const CSFG_BLOCK_WIRE_LEN = 7;

export type CSFGBlock = {
  ampMa: number;
  durMs: number;
  hold: boolean;
};

export function clampAmpMa(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v > CSFG_MAX_ABS_MA) return CSFG_MAX_ABS_MA;
  if (v < -CSFG_MAX_ABS_MA) return -CSFG_MAX_ABS_MA;
  return Math.round(v * 100) / 100;
}

export function buildAppendPacket(block: CSFGBlock): Uint8Array {
  const ampMa = clampAmpMa(block.ampMa);
  const amp = Math.round(ampMa * 1000);
  const dur = block.hold ? 0xffffffff : Math.max(0, Math.round(block.durMs || 0));
  const out = new Uint8Array(CSFG_BLOCK_WIRE_LEN);
  out[0] = amp & 0xff;
  out[1] = (amp >> 8) & 0xff;
  out[2] = dur & 0xff;
  out[3] = (dur >> 8) & 0xff;
  out[4] = (dur >> 16) & 0xff;
  out[5] = (dur >> 24) & 0xff;
  out[6] = 0;
  return out;
}

export function buildU8(v: number): Uint8Array {
  return new Uint8Array([v ? 1 : 0]);
}
