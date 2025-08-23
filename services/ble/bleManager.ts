// Lazy singleton factory for react-native-ble-plx BleManager.
// In Expo Dev/Prod builds where the module is available, this returns a real instance.
// In environments without native module, it returns undefined to allow mock flows.

import type { BleManagerLike } from "./bleClient";
import { listKnownServiceUUIDs } from "../../constants/devices";

let instance: BleManagerLike | undefined;

export function getBleManager(): BleManagerLike | undefined {
  if (instance) return instance;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BleManager } = require("react-native-ble-plx");
    // Pass restoreStateFunction on iOS to regain visibility into OS-held connections after reloads
    try {
      instance = new BleManager({
        restoreStateFunction: (_restored: any) => {
          // Intentionally no-op; we will actively query connectedDevices in dev cleanup.
        },
      } as any);
    } catch {
      instance = new BleManager();
    }
    return instance as unknown as BleManagerLike;
  } catch {
    return undefined;
  }
}

// Wait until Bluetooth state is PoweredOn before scanning/connecting.
export async function ensureBluetoothOn(manager?: any): Promise<boolean> {
  if (!manager) return false;
  try {
    if (typeof manager.state === "function") {
      const s = await manager.state();
      if (s === "PoweredOn") return true;
    }
  } catch {}
  return await new Promise<boolean>((resolve) => {
    try {
      const sub = manager.onStateChange((state: string) => {
        if (state === "PoweredOn") {
          sub.remove();
          resolve(true);
        }
      }, true);
      // Safety timeout in case no callback
      setTimeout(() => {
        try { sub.remove(); } catch {}
        resolve(false);
      }, 5000);
    } catch {
      resolve(false);
    }
  });
}

// Development helper: on JS reloads during development, the OS may keep BLE links open
// because the JS instance is torn down without a clean disconnect. This helper proactively
// disconnects any peripherals connected at the OS level for known services so peripherals
// resume advertising promptly.
export async function devCleanupLingeringConnections(): Promise<void> {
  // Only run in dev to avoid surprising users in production.
  if (!(global as any).__DEV__) return;
  const manager = getBleManager() as any;
  if (!manager || typeof manager.connectedDevices !== "function") return;
  try {
    const uuids = listKnownServiceUUIDs();
    if (uuids.length === 0) return;
    const devices = await manager.connectedDevices(uuids);
    for (const d of devices || []) {
      try {
        await manager.cancelDeviceConnection(d.id);
        // eslint-disable-next-line no-console
        console.log("[BLE] Dev cleanup: disconnected lingering device", d.id);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[BLE] Dev cleanup: failed to disconnect", d?.id, e);
      }
    }
  } catch {
    // ignore
  }
}
