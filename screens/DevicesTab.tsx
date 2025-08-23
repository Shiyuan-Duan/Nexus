import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Button, Modal, FlatList, ActivityIndicator, Alert, Platform, RefreshControl, TouchableOpacity, Animated } from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { DeviceCard } from "../components/DeviceCard";
import { listConnected, listDiscovered, subscribe, startScan, stopScan, connectDiscovered, getStrength, isScanning, clearDiscovered, getScanError, restartScan, disconnectDevice } from "../state/devices.store";
import { getPluginForType } from "../plugins/registry";
import { getBleManager, ensureBluetoothOn } from "../services/ble/bleManager";
import { ensureAndroidBlePermissions } from "../services/ble/permissions";

export const DevicesTab: React.FC = () => {
  const [rev, setRev] = useState(0);
  const [modalId, setModalId] = useState<string | null>(null);
  const [scanModal, setScanModal] = useState(false);
  const [btState, setBtState] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  useEffect(() => {
    const unsub = subscribe(() => setRev((x) => x + 1));
    return unsub;
  }, []);

  const connected = useMemo(() => listConnected(), [rev]);
  const discovered = useMemo(() => {
    // Filter out unnamed devices; stable order by firstSeen
    return listDiscovered()
      .filter((d) => {
        const n = (d.name || d.adv.name || "").trim();
        return n.length > 0;
      })
      .sort((a, b) => a.firstSeen - b.firstSeen);
  }, [rev]);
  const manager = getBleManager();
  const scanError = useMemo(() => getScanError(), [rev]);

  // Pop up when native layer is busy due to frequent rescans
  const prevScanErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!scanError) {
      prevScanErrorRef.current = null;
      return;
    }
    const msg = String(scanError).toLowerCase();
    const isTooFrequent = msg.includes("cannot start scanning operation");
    if (isTooFrequent && prevScanErrorRef.current !== scanError) {
      prevScanErrorRef.current = scanError;
      Alert.alert(
        "Please Wait",
        "You may have scanned too often. Wait a few seconds, then try again.",
        [{ text: "OK" }]
      );
    }
  }, [scanError]);

  const current = connected.find((d) => d.id === modalId) || null;
  const plugin = current ? getPluginForType(current.type) : null;
  const Popup = plugin?.Popup;

  // Auto-start scanning when modal opens; stop when it closes
  useEffect(() => {
    let mounted = true;
    const run = async () => {
      if (!scanModal) return;
      const okPerms = await ensureAndroidBlePermissions();
      if (!okPerms) return;
      const btOn = await ensureBluetoothOn(manager);
      if (!btOn) {
        Alert.alert("Bluetooth Off", "Please turn on Bluetooth to scan.");
        return;
      }
      try {
        if ((manager as any)?.state) {
          const s = await (manager as any).state();
          if (mounted) setBtState(String(s));
        }
      } catch {}
      if (mounted) startScan(manager);
    };
    run();
    return () => {
      mounted = false;
      if (isScanning()) stopScan();
    };
  }, [scanModal]);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 18, fontWeight: "600" }}>Connected Devices</Text>
        <Button title="Add device" onPress={() => setScanModal(true)} />
      </View>

      <FlatList
        data={connected}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Swipeable
            friction={2}
            overshootRight={false}
            rightThreshold={64}
            renderRightActions={(progress) => {
              const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [120, 0] });
              const opacity = progress.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0, 1] });
              return (
                <Animated.View style={{ transform: [{ translateX }], opacity }}>
                  <View style={{ width: 120, backgroundColor: '#ef4444', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                    <TouchableOpacity
                      onPress={async () => {
                        if (manager) {
                          await disconnectDevice(item.id, manager);
                          if (modalId === item.id) setModalId(null);
                        }
                      }}
                      style={{ paddingVertical: 12, paddingHorizontal: 16 }}
                    >
                      <Text style={{ color: 'white', fontWeight: '600' }}>Disconnect</Text>
                    </TouchableOpacity>
                  </View>
                </Animated.View>
              );
            }}
          >
            <DeviceCard
              device={item}
              strength={getStrength(item.id)}
              onPress={() => setModalId(item.id)}
            />
          </Swipeable>
        )}
        ListEmptyComponent={<Text style={{ padding: 12, color: "#6b7280" }}>No devices connected</Text>}
      />

      <Modal visible={scanModal} animationType="slide" onRequestClose={() => setScanModal(false)}>
        <View style={{ flex: 1 }}>
          <View style={{ padding: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ fontSize: 18, fontWeight: "600" }}>Scan for devices</Text>
            <Button title="Close" onPress={() => { stopScan(); setScanModal(false); }} />
          </View>
          <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
            <Text style={{ color: "#6b7280", marginBottom: 6 }}>
              Manager: {manager ? "available" : "unavailable"} • BT: {btState ?? "unknown"}
            </Text>
            {Platform.OS === 'android' && (
              <Text style={{ color: '#6b7280' }}>Location services: unknown (enable in Settings if scan is empty)</Text>
            )}
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 6 }}>
              {isScanning() ? (
                <>
                  <ActivityIndicator size="small" style={{ marginRight: 8 }} />
                  <Text>Scanning... ({discovered.length})</Text>
                  <View style={{ marginLeft: 12 }}>
                    <Button title="Stop" onPress={() => stopScan()} />
                  </View>
                </>
              ) : (
              <Button title="Start scanning" onPress={async () => {
                const okPerms = await ensureAndroidBlePermissions();
                if (!okPerms) return;
                const btOn = await ensureBluetoothOn(manager);
                if (!btOn) {
                  Alert.alert("Bluetooth Off", "Please turn on Bluetooth to scan.");
                  return;
                }
                await restartScan(manager);
              }} />
            )}
            </View>
          </View>

          <View style={{ flex: 1 }}>
            <FlatList
              data={discovered}
              keyExtractor={(d) => d.id}
              renderItem={({ item: d }) => {
                const isConnecting = connectingId === d.id;
                return (
                  <View style={{ paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderColor: "#e5e7eb", flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <View>
                      <Text style={{ fontWeight: "600" }}>{d.name || d.adv.name || d.id}</Text>
                      <Text style={{ color: "#6b7280" }}>{d.rssi ?? "?"} dBm</Text>
                    </View>
                    {manager ? (
                      isConnecting ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                          <ActivityIndicator size="small" style={{ marginRight: 8 }} />
                          <Text>Connecting...</Text>
                        </View>
                      ) : (
                        <Button title="Connect" onPress={async () => {
                          try {
                            setConnectingId(d.id);
                            await connectDiscovered(d.id, manager);
                            stopScan();
                            setScanModal(false);
                          } finally {
                            setConnectingId(null);
                          }
                        }} />
                      )
                    ) : (
                      <Text style={{ color: "#6b7280" }}>Manager not available</Text>
                    )}
                  </View>
                );
              }}
              ListEmptyComponent={
                <View style={{ padding: 12 }}>
                  <Text style={{ color: "#6b7280" }}>
                    {isScanning()
                      ? "Searching nearby devices... Make sure Bluetooth is on, and on Android ensure Location services are enabled."
                      : "No devices yet. Start scanning."}
                  </Text>
                </View>
              }
              extraData={rev}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={async () => {
                    setRefreshing(true);
                    const okPerms = await ensureAndroidBlePermissions();
                    if (!okPerms) { setRefreshing(false); return; }
                    const btOn = await ensureBluetoothOn(manager);
                    if (!btOn) {
                      Alert.alert("Bluetooth Off", "Please turn on Bluetooth to scan.");
                      setRefreshing(false);
                      return;
                    }
                    await restartScan(manager);
                    setRefreshing(false);
                  }}
                />
              }
            />
          </View>
        </View>
      </Modal>

      <Modal visible={!!current} animationType="slide" onRequestClose={() => setModalId(null)}>
        <View style={{ flex: 1 }}>
          <View style={{ padding: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ fontSize: 18, fontWeight: "600" }}>{current?.name}</Text>
            <Button title="Close" onPress={() => setModalId(null)} />
          </View>
          {Popup && current ? (
            <Popup device={current} />
          ) : current ? (
            <View style={{ padding: 16 }}>
              <Text style={{ fontSize: 18, fontWeight: "600", marginBottom: 8 }}>Device</Text>
              <Text style={{ marginBottom: 4 }}>Name: {current.name}</Text>
              <Text style={{ color: "#6b7280" }}>Type: {current.type}</Text>
              <Text style={{ marginTop: 12, color: "#9ca3af" }}>
                No plugin available for this device type yet.
              </Text>
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
};

export default DevicesTab;

// Removed runtime location services probe to avoid optional dependency issues.
