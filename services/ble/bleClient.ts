import { Advertisement } from "../../constants/devices";
import { ConnectionStrength } from "./bleTypes";

// Minimal local interfaces to align with react-native-ble-plx without importing it here.
// This keeps compile safety in environments where the package is added via Expo config.
export interface PlxDeviceLike {
  id: string;
  name: string | null;
  rssi: number | null;
  manufacturerData?: string | null;
  serviceUUIDs?: string[] | null;
  serviceData?: Record<string, string> | null;
}

export interface SubscriptionLike { remove(): void }

export interface BleManagerLike {
  startDeviceScan(
    uuids: string[] | null,
    options: unknown | null,
    listener: (error: unknown, device: PlxDeviceLike | null) => void
  ): void;
  stopDeviceScan(): void;

  connectToDevice(id: string): Promise<PlxDeviceLike>;
  cancelDeviceConnection(id: string): Promise<void>;

  // Discovery APIs (present on react-native-ble-plx BleManager)
  discoverAllServicesAndCharacteristicsForDevice(id: string): Promise<PlxDeviceLike>;
  servicesForDevice(id: string): Promise<{ uuid: string }[]>;
  characteristicsForDevice(
    id: string,
    serviceUUID: string
  ): Promise<Array<{ uuid: string; isReadable?: boolean; isWritableWithResponse?: boolean; isNotifiable?: boolean }>>;

  readCharacteristicForDevice(
    id: string,
    serviceUUID: string,
    characteristicUUID: string
  ): Promise<{ value: string | null }>;
  readRSSIForDevice?: (id: string) => Promise<{ rssi: number | null }>;
  writeCharacteristicWithResponseForDevice(
    id: string,
    serviceUUID: string,
    characteristicUUID: string,
    base64: string
  ): Promise<{ value: string | null }>;
  monitorCharacteristicForDevice(
    id: string,
    serviceUUID: string,
    characteristicUUID: string,
    listener: (error: unknown, characteristic: { value: string | null } | null) => void
  ): SubscriptionLike;
}

export function estimateStrength(rssi?: number): ConnectionStrength {
  if (typeof rssi !== "number") return "disconnected";
  if (rssi >= -60) return "strong";
  if (rssi >= -75) return "medium";
  if (rssi >= -90) return "weak";
  return "disconnected";
}

// Minimal base64 helpers (no external deps)
const _b64abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytesToBase64(bytes: Uint8Array): string {
  let result = '', i: number;
  const l = bytes.length;
  for (i = 0; i < l - 2; i += 3) {
    result += _b64abc[bytes[i] >> 2];
    result += _b64abc[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
    result += _b64abc[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
    result += _b64abc[bytes[i + 2] & 63];
  }
  if (i < l) {
    result += _b64abc[bytes[i] >> 2];
    if (i === l - 1) {
      result += _b64abc[(bytes[i] & 3) << 4];
      result += '==';
    } else {
      result += _b64abc[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
      result += _b64abc[(bytes[i + 1] & 15) << 2];
      result += '=';
    }
  }
  return result;
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const len = clean.length;
  if (len === 0 || len % 4 !== 0) return new Uint8Array();
  const out: number[] = [];
  for (let i = 0; i < len; i += 4) {
    const c1 = _b64abc.indexOf(clean[i]);
    const c2 = _b64abc.indexOf(clean[i + 1]);
    const pad2 = clean[i + 2] === '=';
    const pad3 = clean[i + 3] === '=';
    const c3 = pad2 ? 0 : _b64abc.indexOf(clean[i + 2]);
    const c4 = pad3 ? 0 : _b64abc.indexOf(clean[i + 3]);
    if (c1 < 0 || c2 < 0 || c3 < 0 || c4 < 0) return new Uint8Array();
    const n = (c1 << 18) | (c2 << 12) | (c3 << 6) | c4;
    out.push((n >> 16) & 0xff);
    if (!pad2) out.push((n >> 8) & 0xff);
    if (!pad3) out.push(n & 0xff);
  }
  return new Uint8Array(out);
}

export async function connect(id: string, manager: BleManagerLike): Promise<void> {
  await manager.connectToDevice(id);
}

export async function disconnect(id: string, manager: BleManagerLike): Promise<void> {
  await manager.cancelDeviceConnection(id);
}

// Note: react-native-ble-plx uses base64 for characteristic values.
// These are placeholders; integrate proper base64 conversion as needed.
export async function read(
  id: string,
  service: string,
  char: string,
  manager: BleManagerLike
): Promise<Uint8Array> {
  const res = await manager.readCharacteristicForDevice(id, service, char);
  const v = res?.value ?? '';
  if (!v) return new Uint8Array();
  return base64ToBytes(v);
}

export async function write(
  id: string,
  service: string,
  char: string,
  _data: Uint8Array,
  manager: BleManagerLike
): Promise<void> {
  const base64 = bytesToBase64(_data);
  await manager.writeCharacteristicWithResponseForDevice(id, service, char, base64);
}

export function monitor(
  id: string,
  service: string,
  char: string,
  _onData: (data: Uint8Array) => void,
  manager: BleManagerLike
): { unsubscribe: () => void } {
  const sub = manager.monitorCharacteristicForDevice(id, service, char, (_e, _c) => {
    try {
      const v = _c?.value ?? '';
      if (v) _onData(base64ToBytes(v));
    } catch {}
  });
  return { unsubscribe: () => sub.remove() };
}

export function scan(
  onDiscovered: (adv: Advertisement & { id: string }) => void,
  manager?: BleManagerLike,
  onError?: (err: unknown) => void
): { stop: () => void } {
  if (manager) {
    // allowDuplicates gives continuous updates on iOS; LowLatency improves results on Android
    const options = { allowDuplicates: true, scanMode: 2 } as any;
    // eslint-disable-next-line no-console
    console.log("[BLE] startDeviceScan (native)", options);
    manager.startDeviceScan(null, options, (error, device) => {
      if (error) {
        // eslint-disable-next-line no-console
        console.warn("[BLE] scan error", error);
        if (onError) onError(error);
        return;
      }
      if (!device) return;
      const adv: Advertisement & { id: string } = {
        id: device.id,
        name: device.name ?? undefined,
        rssi: device.rssi ?? undefined,
        serviceUUIDs: device.serviceUUIDs ?? undefined,
        manufacturerDataHex: device.manufacturerData ?? undefined,
        serviceData: device.serviceData ?? undefined,
      };
      onDiscovered(adv);
    });
    return { stop: () => manager.stopDeviceScan() };
  }

  // Fallback mock if no manager is supplied (useful for tests/dev without BLE)
  let timer: any = null;
  let count = 0;
  // eslint-disable-next-line no-console
  console.log("[BLE] startDeviceScan (mock)");
  timer = setInterval(() => {
    count += 1;
    if (count === 1) {
      const adv = { id: "dev-known-1", name: "StimBasic", serviceUUIDs: ["fff0"], rssi: -58 } as Advertisement & { id: string };
      onDiscovered(adv);
    } else if (count === 2) {
      const adv = { id: "dev-unknown-1", name: "Random Gadget", serviceUUIDs: ["abcd"], rssi: -82 } as Advertisement & { id: string };
      onDiscovered(adv);
    } else if (count === 3) {
      const adv = { id: "dev-known-2", name: "HR Sensor", serviceUUIDs: ["0000180d-0000-1000-8000-00805f9b34fb"], rssi: -70 } as Advertisement & { id: string };
      onDiscovered(adv);
    } else if (count > 3) {
      clearInterval(timer);
    }
  }, 300);
  return { stop: () => timer && clearInterval(timer) };
}

// Enumerate characteristics for a given service UUID (after discovery)
export async function listCharacteristicsForService(
  id: string,
  serviceUUID: string,
  manager: BleManagerLike
): Promise<Array<{ uuid: string; readable: boolean; writable: boolean; notifiable: boolean }>> {
  // Ensure discovery completed
  await manager.discoverAllServicesAndCharacteristicsForDevice(id);
  const chars = await manager.characteristicsForDevice(id, serviceUUID);
  return (chars || []).map((c: any) => ({
    uuid: String(c.uuid).toLowerCase(),
    readable: !!c.isReadable,
    writable: !!c.isWritableWithResponse,
    notifiable: !!c.isNotifiable,
  }));
}
