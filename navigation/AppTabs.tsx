import React, { useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import DevicesTab from "../screens/DevicesTab";
import DataTab from "../screens/DataTab";
import SettingsTab from "../screens/SettingsTab";

type TabKey = "devices" | "data" | "settings";

export const AppTabs: React.FC = () => {
  const [tab, setTab] = useState<TabKey>("devices");

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        {tab === "devices" && <DevicesTab />}
        {tab === "data" && <DataTab />}
        {tab === "settings" && <SettingsTab />}
      </View>
      <View style={{ flexDirection: "row", borderTopWidth: 1, borderColor: "#e5e7eb" }}>
        <TabButton label="Devices" active={tab === "devices"} onPress={() => setTab("devices")} />
        <TabButton label="Data" active={tab === "data"} onPress={() => setTab("data")} />
        <TabButton label="Settings" active={tab === "settings"} onPress={() => setTab("settings")} />
      </View>
    </View>
  );
};

const TabButton: React.FC<{ label: string; active?: boolean; onPress: () => void }> = ({ label, active, onPress }) => (
  <TouchableOpacity onPress={onPress} style={{ flex: 1, padding: 12, alignItems: "center" }}>
    <Text style={{ color: active ? "#111827" : "#6b7280", fontWeight: active ? "600" : "400" }}>{label}</Text>
  </TouchableOpacity>
);

export default AppTabs;

