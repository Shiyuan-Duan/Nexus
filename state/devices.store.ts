import { Advertisement, DeviceIdentity, classifyAdvertisement, deviceIconForType } from "../constants/devices";
import { estimateStrength, scan as bleScan, connect as bleConnect, disconnect as bleDisconnect, type BleManagerLike } from "../services/ble/bleClient";
import type { ConnectionStrength } from "../services/ble/bleTypes";

type DiscoveredItem = { id: string; name: string; adv: Advertisement; rssi?: number; lastSeen: number; firstSeen: number };

const discovered: DiscoveredItem[] = [];
const connected: DeviceIdentity[] = [];
const strengths: Record<string, ConnectionStrength> = {};
let scanStopper: { stop: () => void } | null = null;
const listeners = new Set<() => void>();
let lastScanError: string | null = null;
let restarting = false;
let lastStartTime = 0;
let lastStopTime = 0;
let scanEpoch = 0;

export function upsertDiscovered(item: { id: string; name?: string; adv: Advertisement; rssi?: number }): void {
  const idx = discovered.findIndex(d => d.id === item.id);
  const name = item.name ?? item.adv.name ?? "";
  const now = Date.now();
  const firstSeen = idx >= 0 ? discovered[idx].firstSeen : now;
  const next: DiscoveredItem = { id: item.id, name, adv: item.adv, rssi: item.rssi, lastSeen: now, firstSeen };
  if (idx >= 0) {
    discovered[idx] = { ...discovered[idx], ...next };
  } else {
    discovered.push(next);
  }
  if (typeof item.rssi === "number") {
    strengths[item.id] = estimateStrength(item.rssi);
  }
  emit();
}

export function classifyAndAddConnected(id: string): DeviceIdentity | null {
  const d = discovered.find(x => x.id === id);
  if (!d) return null;
  const result = classifyAdvertisement(d.adv);
  const type = result?.type ?? "unknown";
  const identity: DeviceIdentity = {
    id,
    name: d.name || "Unknown",
    type,
    icon: deviceIconForType(type),
  };
  const exists = connected.some(x => x.id === id);
  if (!exists) connected.push(identity);
  emit();
  return identity;
}

export function removeConnected(id: string): void {
  const idx = connected.findIndex(x => x.id === id);
  if (idx >= 0) connected.splice(idx, 1);
  emit();
}

export function setStrength(id: string, rssi?: number): void {
  strengths[id] = estimateStrength(rssi);
  emit();
}

export function listConnected(): DeviceIdentity[] {
  return connected.slice();
}

export function listDiscovered(): DiscoveredItem[] {
  return discovered.slice();
}

export function getStrength(id: string): ConnectionStrength | undefined {
  return strengths[id];
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const l of listeners) l();
}

export function startScan(manager?: BleManagerLike) {
  if (scanStopper) return; // already scanning
  lastScanError = null;
  const epoch = ++scanEpoch;
  lastStartTime = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[BLE] startScan epoch=${epoch}`);
  scanStopper = bleScan((adv) => {
    upsertDiscovered({ id: adv.id, name: adv.name, adv, rssi: adv.rssi });
  }, manager, (err) => {
    try {
      lastScanError = typeof err === 'string' ? err : (err?.message ?? String(err));
    } catch {
      lastScanError = 'Unknown scan error';
    }
    // eslint-disable-next-line no-console
    console.warn(`[BLE] scan error epoch=${epoch}:`, lastScanError);
    // Ensure scanning state is cleared after an error so the user can retry
    stopScan();
    emit();
  });
  emit();
}

export function stopScan() {
  if (scanStopper) {
    // eslint-disable-next-line no-console
    console.log("[BLE] stopScan");
    scanStopper.stop();
    scanStopper = null;
    lastStopTime = Date.now();
    emit();
  }
}

export function isScanning(): boolean {
  return !!scanStopper;
}

export function clearDiscovered() {
  discovered.splice(0, discovered.length);
  emit();
}

export function getScanError(): string | null {
  return lastScanError;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function restartScan(manager?: BleManagerLike): Promise<void> {
  if (restarting) return;
  restarting = true;
  try {
    const now = Date.now();
    if (isScanning()) {
      stopScan();
    }
    // Ensure a small gap after stop before starting
    const sinceStop = now - lastStopTime;
    const delay = sinceStop < 800 ? 800 - sinceStop : 0;
    if (delay > 0) await wait(delay);
    clearDiscovered();
    // Start a single scan; if it errors, the error handler will stop and UI can prompt the user.
    startScan(manager);
  } finally {
    restarting = false;
  }
}

export async function connectDiscovered(id: string, manager: BleManagerLike): Promise<DeviceIdentity | null> {
  await bleConnect(id, manager);
  const identity = classifyAndAddConnected(id);
  return identity;
}

export async function disconnectDevice(id: string, manager: BleManagerLike): Promise<void> {
  await bleDisconnect(id, manager);
  removeConnected(id);
}
