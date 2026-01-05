import { Advertisement, DeviceIdentity, classifyAdvertisement, deviceIconForType } from "../constants/devices";
import { getItem, setItem } from "../services/storage/storage";
import { estimateStrength, scan as bleScan, connect as bleConnect, disconnect as bleDisconnect, type BleManagerLike } from "../services/ble/bleClient";
import type { ConnectionStrength } from "../services/ble/bleTypes";

type DiscoveredItem = { id: string; name: string; adv: Advertisement; rssi?: number; lastSeen: number; firstSeen: number };

const discovered: DiscoveredItem[] = [];
const connected: DeviceIdentity[] = [];
const history: DeviceIdentity[] = [];
const HISTORY_STORAGE_KEY = "nexus:device-history";
let historyHydrated = false;
let historyHydrating: Promise<void> | null = null;
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
  upsertConnected(identity);
  emit();
  return identity;
}

function upsertConnected(identity: DeviceIdentity): void {
  const idx = connected.findIndex(x => x.id === identity.id);
  if (idx >= 0) {
    connected[idx] = identity;
  } else {
    connected.push(identity);
  }
  upsertHistory(identity);
}

export function removeConnected(id: string): void {
  const idx = connected.findIndex(x => x.id === id);
  if (idx >= 0) {
    connected.splice(idx, 1);
  }
  emit();
}

export function setStrength(id: string, rssi?: number): void {
  strengths[id] = estimateStrength(rssi);
  emit();
}

export function listConnected(): DeviceIdentity[] {
  return connected.slice();
}

export function listHistory(): DeviceIdentity[] {
  return history.slice();
}

export function removeHistory(id: string): void {
  const idx = history.findIndex(x => x.id === id);
  if (idx >= 0) {
    history.splice(idx, 1);
    void persistHistory();
    emit();
  }
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
  const d = discovered.find(x => x.id === id);
  if (d && typeof d.rssi === "number") {
    setStrength(id, d.rssi);
  }
  const identity = classifyAndAddConnected(id);
  return identity;
}

export async function connectKnown(id: string, manager: BleManagerLike): Promise<DeviceIdentity | null> {
  await bleConnect(id, manager);
  const existing = connected.find(x => x.id === id);
  if (existing) return existing;
  const fromHistory = history.find(x => x.id === id);
  if (fromHistory) {
    upsertConnected(fromHistory);
    emit();
    return fromHistory;
  }
  const d = discovered.find(x => x.id === id);
  if (d) {
    return classifyAndAddConnected(id);
  }
  const identity: DeviceIdentity = {
    id,
    name: "Unknown",
    type: "unknown",
    icon: deviceIconForType("unknown"),
  };
  upsertConnected(identity);
  emit();
  return identity;
}

function upsertHistory(identity: DeviceIdentity): void {
  const idx = history.findIndex(x => x.id === identity.id);
  if (idx >= 0) {
    history[idx] = identity;
  } else {
    history.push(identity);
  }
  void persistHistory();
}

export async function hydrateHistory(): Promise<void> {
  if (historyHydrated) return;
  if (historyHydrating) return historyHydrating;
  historyHydrating = (async () => {
    try {
      const raw = await getItem(HISTORY_STORAGE_KEY);
      if (!raw) {
        historyHydrated = true;
        return;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        history.length = 0;
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const id = String((item as any).id || "").trim();
          if (!id) continue;
          history.push({
            id,
            name: String((item as any).name || "Unknown"),
            type: String((item as any).type || "unknown"),
            icon: typeof (item as any).icon === "string" ? (item as any).icon : undefined,
          });
        }
      }
    } catch {
      // ignore corrupted history
    } finally {
      historyHydrated = true;
      emit();
    }
  })();
  return historyHydrating.finally(() => {
    historyHydrating = null;
  });
}

async function persistHistory(): Promise<void> {
  try {
    await setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // ignore storage errors
  }
}

export async function disconnectDevice(id: string, manager: BleManagerLike): Promise<void> {
  try {
    await bleDisconnect(id, manager);
  } catch {
    // Swallow disconnect errors (already disconnected, etc.)
  } finally {
    // Ensure UI updates regardless of underlying BLE state
    removeConnected(id);
  }
}
