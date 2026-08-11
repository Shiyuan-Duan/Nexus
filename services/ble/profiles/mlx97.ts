// MLX97 profile: service, characteristics, and sample parser

export const MLX97_SERVICE_UUID = "a0a4e690-96be-4222-b41e-98ea76b0120c";

export const MLX97_CHAR_STREAM = "a0a4e691-96be-4222-b41e-98ea76b0120c";
export const MLX97_CHAR_CTRL   = "a0a4e692-96be-4222-b41e-98ea76b0120c";
export const MLX97_CHAR_IMU    = "a0a4e693-96be-4222-b41e-98ea76b0120c";

export type MLX97Sample = {
  t_ms: number;
  x: number;
  y: number;
  z: number;
  stat1: number;
  stat2: number;
};

export type MLX97ImuSample = {
  t_ms: number;
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
};

export function parseMLX97Sample(data: Uint8Array): MLX97Sample | null {
  if (!data || data.length < 12) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const t_ms = view.getUint32(0, true);
  const x = view.getInt16(4, true);
  const y = view.getInt16(6, true);
  const z = view.getInt16(8, true);
  const stat1 = view.getUint8(10);
  const stat2 = view.getUint8(11);
  return { t_ms, x, y, z, stat1, stat2 };
}

export function parseMLX97ImuSample(data: Uint8Array): MLX97ImuSample | null {
  if (!data || data.length < 16) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    t_ms: view.getUint32(0, true),
    ax: view.getInt16(4, true),
    ay: view.getInt16(6, true),
    az: view.getInt16(8, true),
    gx: view.getInt16(10, true),
    gy: view.getInt16(12, true),
    gz: view.getInt16(14, true),
  };
}

export const MLX97_CTRL_START = new Uint8Array([1]);
export const MLX97_CTRL_STOP  = new Uint8Array([0]);
