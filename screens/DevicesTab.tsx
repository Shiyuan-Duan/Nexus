import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Button, Modal, FlatList, ActivityIndicator, Alert, Platform, RefreshControl, TouchableOpacity, Animated, StyleSheet } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Swipeable } from "react-native-gesture-handler";
import { DeviceCard } from "../components/DeviceCard";
import { listConnected, listDiscovered, listHistory, subscribe, startScan, stopScan, connectDiscovered, connectKnown, getStrength, hydrateHistory, isScanning, clearDiscovered, getScanError, restartScan, disconnectDevice, setStrength, removeHistory } from "../state/devices.store";
import { isRecording } from "../services/data/recorder";
import { connect as bleConnect, estimateStrength } from "../services/ble/bleClient";
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
  const [connectName, setConnectName] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [historyConnectingId, setHistoryConnectingId] = useState<string | null>(null);
  const historyScanActiveRef = useRef(false);
  const DISCOVERY_STALE_MS = 15000;

  useEffect(() => {
    const unsub = subscribe(() => setRev((x) => x + 1));
    return unsub;
  }, []);

  useEffect(() => {
    hydrateHistory();
  }, []);

  const connected = useMemo(() => listConnected(), [rev]);
  const connectedActive = useMemo(
    () => connected.filter((d) => getStrength(d.id) !== "disconnected"),
    [connected, rev]
  );
  const history = useMemo(() => {
    const known = listHistory();
    const connectedIds = new Set(connectedActive.map((d) => d.id));
    return known.filter((d) => !connectedIds.has(d.id));
  }, [connectedActive, rev]);
  const discovered = useMemo(() => {
    // Filter out unnamed devices; stable order by firstSeen
    return listDiscovered()
      .filter((d) => {
        const n = (d.name || d.adv.name || "").trim();
        return n.length > 0;
      })
      .sort((a, b) => a.firstSeen - b.firstSeen);
  }, [rev]);
  const discoveredById = useMemo(() => {
    const items = listDiscovered();
    const map = new Map<string, (typeof items)[number]>();
    for (const item of items) {
      map.set(item.id, item);
    }
    return map;
  }, [rev]);
  const manager = getBleManager();
  const insets = useSafeAreaInsets();
  const scanError = useMemo(() => getScanError(), [rev]);
  const rssiRefreshRef = useRef(0);
  const reconnectRef = useRef<Record<string, number>>({});

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

  useEffect(() => {
    if (!manager || typeof (manager as any).readRSSIForDevice !== "function") return;
    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;
      const devices = listConnected();
      if (devices.length === 0) return;
      rssiRefreshRef.current += 1;
      for (const d of devices) {
        try {
          const res = await (manager as any).readRSSIForDevice(d.id);
          if (!cancelled && typeof res?.rssi === "number") {
            setStrength(d.id, res.rssi);
          } else if (!cancelled) {
            setStrength(d.id, undefined);
          }
        } catch {
          if (!cancelled) setStrength(d.id, undefined);
        }
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [manager]);

  useEffect(() => {
    if (!manager) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;
      const devices = listConnected();
      if (devices.length === 0) return;
      const now = Date.now();
      for (const d of devices) {
        const strength = getStrength(d.id);
        if (strength !== "disconnected") continue;
        const lastTry = reconnectRef.current[d.id] ?? 0;
        if (now - lastTry < 8000) continue;
        reconnectRef.current[d.id] = now;
        try {
          await bleConnect(d.id, manager);
          if (typeof (manager as any).readRSSIForDevice === "function") {
            try {
              const res = await (manager as any).readRSSIForDevice(d.id);
              if (!cancelled && typeof res?.rssi === "number") {
                setStrength(d.id, res.rssi);
              }
            } catch {}
          }
        } catch {
          if (!cancelled) setStrength(d.id, undefined);
        }
      }
    }, 6000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [manager]);

  useEffect(() => {
    if (!manager) return;
    let cancelled = false;
    const pulseScan = async () => {
      if (cancelled || scanModal) {
        if (historyScanActiveRef.current && isScanning()) {
          stopScan();
          historyScanActiveRef.current = false;
        }
        return;
      }
      if (isScanning()) return;
      const okPerms = await ensureAndroidBlePermissions();
      if (!okPerms) return;
      const btOn = await ensureBluetoothOn(manager);
      if (!btOn) return;
      historyScanActiveRef.current = true;
      startScan(manager);
      setTimeout(() => {
        if (cancelled) return;
        if (historyScanActiveRef.current && isScanning()) {
          stopScan();
          historyScanActiveRef.current = false;
        }
      }, 4000);
    };
    const interval = setInterval(pulseScan, 12000);
    pulseScan();
    return () => {
      cancelled = true;
      clearInterval(interval);
      if (historyScanActiveRef.current && isScanning()) {
        stopScan();
        historyScanActiveRef.current = false;
      }
    };
  }, [manager, scanModal]);

  const historyStrengthFor = useCallback(
    (id: string) => {
      const item = discoveredById.get(id);
      if (!item) return undefined;
      if (Date.now() - item.lastSeen > DISCOVERY_STALE_MS) return undefined;
      if (typeof item.rssi !== "number") return undefined;
      const s = estimateStrength(item.rssi);
      return s === "disconnected" ? undefined : s;
    },
    [discoveredById]
  );

  const current = connected.find((d) => d.id === modalId) || null;
  const plugin = current ? getPluginForType(current.type) : null;
  const Popup = plugin?.Popup;

  const requestCloseModal = useCallback(() => {
    if (isRecording()) {
      Alert.alert(
        "Recording in progress",
        "A recording is still running. You can safely close this page, but recording will continue.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Close", style: "destructive", onPress: () => setModalId(null) },
        ]
      );
      return;
    }
    setModalId(null);
  }, []);

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
    <SafeAreaView style={styles.screen} edges={['top','left','right','bottom']}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Devices</Text>
        <TouchableOpacity style={styles.addButton} onPress={() => setScanModal(true)}>
          <Text style={styles.addButtonText}>Add</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionHeader}>Connected</Text>

      <FlatList
        data={connectedActive}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 16, gap: 12 }}
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
                  <View style={styles.swipeDelete}>
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
        ListEmptyComponent={
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No devices connected</Text>
            <Text style={styles.emptySubtle}>Tap Add to pair a new device</Text>
          </View>
        }
      />

      <Text style={styles.sectionHeader}>History</Text>

      <FlatList
        data={history}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 16, gap: 12 }}
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
                  <View style={styles.swipeDelete}>
                    <TouchableOpacity
                      onPress={() => removeHistory(item.id)}
                      style={{ paddingVertical: 12, paddingHorizontal: 16 }}
                    >
                      <Text style={{ color: 'white', fontWeight: '600' }}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                </Animated.View>
              );
            }}
          >
            <DeviceCard
              device={item}
              strength={historyStrengthFor(item.id)}
              pulse={false}
              loading={historyConnectingId === item.id}
              onPress={async () => {
                if (!manager || historyConnectingId) return;
                setHistoryConnectingId(item.id);
                try {
                  await connectKnown(item.id, manager);
                  setModalId(item.id);
                } catch (e: any) {
                  Alert.alert("Connect Failed", e?.message ?? String(e));
                } finally {
                  setHistoryConnectingId(null);
                }
              }}
            />
          </Swipeable>
        )}
        ListEmptyComponent={
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>No history yet</Text>
            <Text style={styles.emptySubtle}>Connect a device to see it here later.</Text>
          </View>
        }
      />

      <Modal visible={scanModal} animationType="slide" onRequestClose={() => setScanModal(false)}>
        <SafeAreaView style={styles.modalScreen} edges={['top','left','right','bottom']}>
          <View style={styles.modalHeaderRow}>
            <Text style={styles.title}>Add Device</Text>
            <TouchableOpacity onPress={() => { stopScan(); setScanModal(false); }}>
              <Text style={styles.linkButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.modalContentTop}>
            {Platform.OS === 'android' && (
              <Text style={styles.infoSubtle}>If list is empty, enable Location Services in Settings.</Text>
            )}
            <View style={styles.scanStatusCard}>
              <View style={styles.scanStatusRow}>
                {isScanning() ? (
                  <>
                    <ActivityIndicator size="small" style={{ marginRight: 8 }} />
                    <Text style={styles.scanStatusText}>Scanning... ({discovered.length})</Text>
                    <TouchableOpacity style={[styles.secondaryButton, { marginLeft: 12 }]} onPress={() => stopScan()}>
                      <Text style={styles.secondaryButtonText}>Stop</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <TouchableOpacity
                    style={styles.addButton}
                    onPress={async () => {
                      const okPerms = await ensureAndroidBlePermissions();
                      if (!okPerms) return;
                      const btOn = await ensureBluetoothOn(manager);
                      if (!btOn) {
                        Alert.alert("Bluetooth Off", "Please turn on Bluetooth to scan.");
                        return;
                      }
                      await restartScan(manager);
                    }}
                  >
                    <Text style={styles.addButtonText}>Start Scan</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </View>

          <View style={{ flex: 1 }}>
            <FlatList
              data={discovered}
              keyExtractor={(d) => d.id}
              contentContainerStyle={{ padding: 12, paddingBottom: 16, gap: 12 }}
              renderItem={({ item: d }) => {
                const isConnecting = connectingId === d.id;
                return (
                  <View style={styles.deviceRowCard}>
                    <View>
                      <Text style={styles.deviceName}>{d.name || d.adv.name || d.id}</Text>
                      <Text style={styles.deviceSubtle}>{d.rssi ?? "?"} dBm</Text>
                    </View>
                    {manager ? (
                      isConnecting ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                          <ActivityIndicator size="small" style={{ marginRight: 8 }} />
                          <Text>Connecting...</Text>
                        </View>
                      ) : (
                        <TouchableOpacity
                          style={styles.connectButton}
                          onPress={async () => {
                            try {
                              setConnectError(null);
                              setConnectName(d.name || d.adv.name || d.id);
                              setConnectingId(d.id);
                              await connectDiscovered(d.id, manager);
                              stopScan();
                              setScanModal(false);
                            } catch (e: any) {
                              setConnectError(e?.message ?? String(e));
                            } finally {
                              setConnectingId(null);
                            }
                          }}
                        >
                          <Text style={styles.connectButtonText}>Connect</Text>
                        </TouchableOpacity>
                      )
                    ) : (
                      <Text style={{ color: "#6b7280" }}>Unavailable</Text>
                    )}
                  </View>
                );
              }}
              ListEmptyComponent={
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyTitle}>
                    {isScanning() ? 'Searching nearby devices...' : 'No devices yet'}
                  </Text>
                  <Text style={styles.emptySubtle}>
                    {isScanning() ? 'Make sure Bluetooth is on.' : 'Start scanning to find your device.'}
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
        </SafeAreaView>
      </Modal>

      {(connectingId || connectError) ? (
        <View style={styles.overlay} pointerEvents="auto">
          <View style={styles.overlayCard}>
            {connectError ? (
              <>
                <Text style={styles.overlayTitle}>Failed to connect</Text>
                <Text style={styles.overlayMessage}>{connectError}</Text>
                <TouchableOpacity style={[styles.secondaryButton, { marginTop: 12 }]} onPress={() => setConnectError(null)}>
                  <Text style={styles.secondaryButtonText}>Dismiss</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <ActivityIndicator size="small" style={{ marginBottom: 12 }} />
                <Text style={styles.overlayTitle}>Connecting</Text>
                <Text style={styles.overlayMessage}>{connectName ?? 'Device'}</Text>
                <TouchableOpacity
                  style={[styles.secondaryButton, { marginTop: 12 }]}
                  onPress={async () => {
                    try {
                      const id = connectingId;
                      if (id && manager) {
                        await manager.cancelDeviceConnection(id);
                      }
                    } catch {}
                    setConnectingId(null);
                  }}
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      ) : null}

      <Modal visible={!!current} animationType="slide" onRequestClose={requestCloseModal}>
        <SafeAreaView style={styles.modalScreen} edges={['top','left','right','bottom']}>
          <View style={[styles.modalHeader, { paddingTop: insets.top + 8 }]}>
            <Text style={{ fontSize: 18, fontWeight: "600" }}>{current?.name}</Text>
            <Button title="Close" onPress={requestCloseModal} />
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
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
};

export default DevicesTab;

// Removed runtime location services probe to avoid optional dependency issues.
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f6f7f8',
  },
  modalScreen: {
    flex: 1,
    backgroundColor: '#f6f7f8',
  },
  modalHeader: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerRow: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modalHeaderRow: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#111827',
  },
  linkButtonText: {
    color: '#2563eb',
    fontWeight: '600',
    fontSize: 16,
  },
  addButton: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  addButtonText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 16,
  },
  sectionHeader: {
    paddingHorizontal: 12,
    marginTop: 6,
    marginBottom: 8,
    color: '#6b7280',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  modalContentTop: {
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  infoSubtle: {
    color: '#6b7280',
    marginBottom: 8,
  },
  scanStatusCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
  },
  scanStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  scanStatusText: {
    fontWeight: '600',
    color: '#111827',
  },
  secondaryButton: {
    backgroundColor: '#eef2ff',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  secondaryButtonText: {
    color: '#3730a3',
    fontWeight: '600',
    fontSize: 16,
  },
  swipeDelete: {
    width: 120,
    backgroundColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100%',
    borderTopLeftRadius: 12,
    borderBottomLeftRadius: 12,
  },
  emptyCard: {
    marginHorizontal: 12,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    alignItems: 'center',
  },
  emptyTitle: {
    fontWeight: '600',
    color: '#111827',
    marginBottom: 4,
  },
  emptySubtle: {
    color: '#6b7280',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlayCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    minWidth: 260,
    maxWidth: 320,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    alignItems: 'center',
  },
  overlayTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 4,
  },
  overlayMessage: {
    color: '#6b7280',
    textAlign: 'center',
  },
  deviceRowCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  deviceName: {
    fontWeight: '600',
    color: '#111827',
  },
  deviceSubtle: {
    color: '#6b7280',
  },
  connectButton: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  connectButtonText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 16,
  },
});
