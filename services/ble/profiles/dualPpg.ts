export const DUAL_PPG_SERVICE_UUID = "a0a4f690-96be-4222-b41e-98ea76b0120c";
export const DUAL_PPG_CHAR_STREAM = "a0a4f691-96be-4222-b41e-98ea76b0120c";
export const DUAL_PPG_CHAR_CTRL = "a0a4f692-96be-4222-b41e-98ea76b0120c";

export const DUAL_PPG_CTRL_START = new Uint8Array([1]);
export const DUAL_PPG_CTRL_STOP = new Uint8Array([0]);

export type DualPpgSample = {
  t_ms: number;
  seq: number;
  valid_mask: number;
  sensor0_tag: number;
  sensor0_sample: number;
  sensor1_tag: number;
  sensor1_sample: number;
};

export const DUAL_PPG_PACKET_BYTES = 17;

export function parseDualPpgSample(data: Uint8Array): DualPpgSample | null {
  if (!data || data.length < DUAL_PPG_PACKET_BYTES) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    t_ms: view.getUint32(0, true),
    seq: view.getUint16(4, true),
    valid_mask: view.getUint8(6),
    sensor0_tag: view.getUint8(7),
    sensor0_sample: view.getUint32(8, true),
    sensor1_tag: view.getUint8(12),
    sensor1_sample: view.getUint32(13, true),
  };
}
