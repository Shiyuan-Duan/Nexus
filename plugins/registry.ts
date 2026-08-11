import type { DeviceIdentity } from "../constants/devices";
import StimulatorBasic from "./stimulator-basic";
import SensorHr from "./sensor-hr";
import Tns from "./tns";
import Mlx97 from "./mlx97";
import DualPpg from "./dual_ppg";
import CsFg from "./cs_fg";
import Ads1299 from "./ads1299";
import Max30003 from "./max30003";

export interface DevicePlugin {
  key: string;
  matches: (type: string) => boolean;
  Popup: React.ComponentType<{ device: DeviceIdentity }>;
  CardExtras?: React.ComponentType<{ device: DeviceIdentity }>;
}

const registry: DevicePlugin[] = [StimulatorBasic, SensorHr, Tns, Mlx97, DualPpg, CsFg, Ads1299, Max30003];

export function getPluginForType(type: string): DevicePlugin | null {
  for (const p of registry) if (p.matches(type)) return p;
  return null;
}

export function listPlugins(): DevicePlugin[] {
  return registry.slice();
}
