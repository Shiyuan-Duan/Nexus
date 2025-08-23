import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { devCleanupLingeringConnections, getBleManager } from '../services/ble/bleManager';

export default function RootLayout() {
  useEffect(() => {
    // Initialize BLE manager early and perform dev cleanup of lingering connections.
    getBleManager();
    devCleanupLingeringConnections();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
      </Stack>
    </GestureHandlerRootView>
  );
}
