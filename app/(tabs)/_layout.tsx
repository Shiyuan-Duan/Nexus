import { Tabs } from 'expo-router';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';

export default function TabLayout() {
  return (
    <Tabs initialRouteName="devices/index">
      <Tabs.Screen
        name="devices/index"
        options={{
          title: 'Devices',
          tabBarLabel: 'Devices',
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name="devices" color={color} size={size ?? 24} />
          ),
        }}
      />
      <Tabs.Screen
        name="data/index"
        options={{
          title: 'Data',
          tabBarLabel: 'Data',
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name="insert-chart-outlined" color={color} size={size ?? 24} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings/index"
        options={{
          title: 'Settings',
          tabBarLabel: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name="settings" color={color} size={size ?? 24} />
          ),
        }}
      />
    </Tabs>
  );
}
