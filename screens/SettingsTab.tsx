import React from "react";
import { View, Text } from "react-native";

export const SettingsTab: React.FC = () => {
  return (
    <View style={{ flex: 1, padding: 12 }}>
      <Text style={{ fontSize: 18, fontWeight: "600", marginBottom: 8 }}>Settings</Text>
      <Text>• BLE permissions</Text>
      <Text>• Data retention</Text>
      <Text>• API base URL</Text>
      <Text>• Debug</Text>
    </View>
  );
};

export default SettingsTab;

