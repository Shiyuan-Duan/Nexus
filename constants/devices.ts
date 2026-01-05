// Flexible device types and helpers for classification based on a JSON map.

export type DeviceTypeKey = string; // intentionally open; do not union-limit

export interface Advertisement {
  name?: string;
  serviceUUIDs?: string[];
  manufacturerId?: number;
  manufacturerDataHex?: string;
  serviceData?: Record<string, string>;
  rssi?: number;
}

export interface DeviceIdentity {
  id: string;
  name: string;
  type: DeviceTypeKey;
  icon?: string;
}

type DeviceTypeMap = Record<string, DeviceTypeKey>;

let cachedMap: DeviceTypeMap | null = null;

function normalizeUUID(u: string): string {
  return u.toLowerCase().replace(/[{}]/g, "");
}

export function loadDeviceTypeMap(): DeviceTypeMap {
  if (cachedMap) return cachedMap;
  // Import JSON once; assume resolveJsonModule is enabled in tsconfig.
  // Fallback to empty object if import fails at runtime.
  let raw: any = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    raw = require("./deviceTypeMap.json");
  } catch {
    raw = {};
  }
  const out: DeviceTypeMap = {};
  for (const k of Object.keys(raw || {})) {
    const nk = normalizeUUID(k);
    const v = String((raw as any)[k]);
    out[nk] = v;
  }
  cachedMap = out;
  return out;
}

function extract16FromBaseUUID(uuid: string): string | null {
  // Handle Bluetooth SIG base UUIDs like 0000xxxx-0000-1000-8000-00805f9b34fb
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(uuid);
  return m ? m[1] : null;
}

export function classifyAdvertisement(adv: Advertisement): { type: DeviceTypeKey; confidence: number } | null {
  const map = loadDeviceTypeMap();
  const uuids = (adv.serviceUUIDs || []).map(normalizeUUID);
  for (const u of uuids) {
    // direct match
    if (map[u]) return { type: map[u], confidence: 10 };
    // derived 16-bit from base uuid
    const short = extract16FromBaseUUID(u);
    if (short && map[short]) return { type: map[short], confidence: 10 };
  }

  // Optional heuristics with lower confidence
  if (adv.name) {
    const n = adv.name.toLowerCase();
    if (n.includes("tns")) return { type: "tns", confidence: 3 };
    if (n.startsWith("ecg")) return { type: "ecg-v1", confidence: 2 };
    if (n.includes("sensor")) return { type: "generic-sensor", confidence: 1 };
  }
  if (typeof adv.manufacturerId === "number") {
    if (adv.manufacturerId === 0x004c) return { type: "apple-device", confidence: 1 }; // example
  }
  if (adv.manufacturerDataHex) {
    const hex = adv.manufacturerDataHex.toLowerCase();
    if (hex.includes("beef")) return { type: "vendor-beef", confidence: 1 };
  }

  return null; // unknown
}

export function deviceIconForType(type: DeviceTypeKey): string {
  const t = type.toLowerCase();
  if (t.includes("stim")) return "bolt";
  if (t.includes("ecg")) return "ecg";
  if (t.includes("sensor")) return "sensor";
  return "";
}

export function listKnownServiceUUIDs(): string[] {
  const map = loadDeviceTypeMap();
  const out: string[] = [];
  for (const k of Object.keys(map)) {
    const nk = k.toLowerCase();
    if (/^[0-9a-f]{4}$/.test(nk)) {
      out.push(`0000${nk}-0000-1000-8000-00805f9b34fb`);
    } else {
      out.push(nk);
    }
  }
  return out;
}
