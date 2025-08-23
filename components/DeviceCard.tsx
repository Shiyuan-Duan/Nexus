import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import type { DeviceIdentity } from "../constants/devices";
import type { ConnectionStrength } from "../services/ble/bleTypes";

export interface DeviceCardProps {
  device: DeviceIdentity;
  strength?: ConnectionStrength;
  onPress?: () => void;
}

function strengthColor(s?: ConnectionStrength): string {
  if (s === "strong") return "#22c55e"; // green
  if (s === "medium" || s === "weak") return "#f59e0b"; // orange
  if (s === "disconnected") return "#ef4444"; // red
  return "#9ca3af"; // gray unknown
}

export const DeviceCard: React.FC<DeviceCardProps> = ({ device, strength, onPress }) => {
  return (
    <TouchableOpacity onPress={onPress} style={{ padding: 12, borderBottomWidth: 1, borderColor: "#e5e7eb", flexDirection: "row", alignItems: "center" }}>
      <View style={{ width: 36, height: 36, backgroundColor: "#e5e7eb", borderRadius: 6, alignItems: "center", justifyContent: "center", marginRight: 12 }}>
        <Text>{device.icon || "🔌"}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontWeight: "600" }}>{device.name}</Text>
        <Text style={{ color: "#6b7280" }}>{device.type}</Text>
      </View>
      <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: strengthColor(strength) }} />
    </TouchableOpacity>
  );
};

export default DeviceCard;
