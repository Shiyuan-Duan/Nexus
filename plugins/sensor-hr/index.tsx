import React from "react";
import { View, Text, Button } from "react-native";
import type { DeviceIdentity } from "../../constants/devices";
import type { DevicePlugin } from "../registry";

const Popup: React.FC<{ device: DeviceIdentity }> = ({ device }) => {
  return (
    <View style={{ padding: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: "600", marginBottom: 8 }}>Heart Rate Sensor</Text>
      <Text style={{ marginBottom: 12 }}>Device: {device.name}</Text>
      <View style={{ height: 120, backgroundColor: "#f0f0f0", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
        <Text>Graph placeholder</Text>
      </View>
      <View style={{ flexDirection: "row" }}>
        <View style={{ marginRight: 8 }}><Button title="Start Session" onPress={() => {}} /></View>
        <View><Button title="Stop & Save" onPress={() => {}} /></View>
      </View>
    </View>
  );
};

const plugin: DevicePlugin = {
  key: "sensor-hr",
  matches: (t) => t === "sensor-hr",
  Popup,
};

export default plugin;
