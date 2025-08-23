import type { DeviceIdentity } from "../constants/devices";
import StimulatorBasic from "./stimulator-basic";
import SensorHr from "./sensor-hr";
import Tns from "./tns";

export interface DevicePlugin {
  key: string;
  matches: (type: string) => boolean;
  Popup: React.ComponentType<{ device: DeviceIdentity }>;
  CardExtras?: React.ComponentType<{ device: DeviceIdentity }>;
}

const registry: DevicePlugin[] = [StimulatorBasic, SensorHr, Tns];

export function getPluginForType(type: string): DevicePlugin | null {
  for (const p of registry) if (p.matches(type)) return p;
  return null;
}

export function listPlugins(): DevicePlugin[] {
  return registry.slice();
}
