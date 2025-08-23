import React from "react";
import { View, Text, Button } from "react-native";
import type { DeviceIdentity } from "../../constants/devices";
import type { DevicePlugin } from "../registry";

const Popup: React.FC<{ device: DeviceIdentity }> = ({ device }) => {
  return (
    <View style={{ padding: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: "600", marginBottom: 8 }}>Stimulator Basic</Text>
      <Text style={{ marginBottom: 12 }}>Device: {device.name}</Text>
      <View style={{ flexDirection: "row" }}>
        <View style={{ marginRight: 8 }}><Button title="Start" onPress={() => {}} /></View>
        <View style={{ marginRight: 8 }}><Button title="Stop" onPress={() => {}} /></View>
        <View><Button title="Pulse Test" onPress={() => {}} /></View>
      </View>
    </View>
  );
};

const plugin: DevicePlugin = {
  key: "stimulator-basic",
  matches: (t) => t === "stimulator-basic",
  Popup,
};

export default plugin;
