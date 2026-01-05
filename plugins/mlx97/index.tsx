import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform } from "react-native";
import type { DeviceIdentity } from "../../constants/devices";
import type { DevicePlugin } from "../registry";
import { getBleManager } from "../../services/ble/bleManager";
import { monitor, write } from "../../services/ble/bleClient";
import {
  MLX97_SERVICE_UUID,
  MLX97_CHAR_CTRL,
  MLX97_CHAR_STREAM0,
  MLX97_CHAR_STREAM1,
  MLX97_CTRL_START,
  MLX97_CTRL_STOP,
  parseMLX97Sample,
  type MLX97Sample,
} from "../../services/ble/profiles/mlx97";

const Popup: React.FC<{ device: DeviceIdentity }> = ({ device }) => {
  const manager = getBleManager();
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [last0, setLast0] = useState<MLX97Sample | null>(null);
  const [last1, setLast1] = useState<MLX97Sample | null>(null);
  const sub0Ref = useRef<{ unsubscribe: () => void } | null>(null);
  const sub1Ref = useRef<{ unsubscribe: () => void } | null>(null);
  const count0 = useRef(0);
  const count1 = useRef(0);

  const unsubscribeAll = useCallback(() => {
    try { sub0Ref.current?.unsubscribe(); } catch {}
    try { sub1Ref.current?.unsubscribe(); } catch {}
    sub0Ref.current = null;
    sub1Ref.current = null;
  }, []);

  const start = useCallback(async () => {
    if (!manager) { setErr("BLE manager unavailable"); return; }
    if (running) return;
    setErr(null);
    setLoading(true);
    try {
      // Subscribe first to avoid missing initial packets
      count0.current = 0; count1.current = 0;
      sub0Ref.current = monitor(device.id, MLX97_SERVICE_UUID, MLX97_CHAR_STREAM0, (data) => {
        const s = parseMLX97Sample(data);
        if (s) { count0.current += 1; setLast0(s); }
      }, manager);
      sub1Ref.current = monitor(device.id, MLX97_SERVICE_UUID, MLX97_CHAR_STREAM1, (data) => {
        const s = parseMLX97Sample(data);
        if (s) { count1.current += 1; setLast1(s); }
      }, manager);
      await write(device.id, MLX97_SERVICE_UUID, MLX97_CHAR_CTRL, MLX97_CTRL_START, manager);
      setRunning(true);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      unsubscribeAll();
      setRunning(false);
    } finally {
      setLoading(false);
    }
  }, [device.id, manager, running, unsubscribeAll]);

  const stop = useCallback(async () => {
    if (!manager) { setErr("BLE manager unavailable"); return; }
    if (!running) return;
    setLoading(true);
    setErr(null);
    try {
      await write(device.id, MLX97_SERVICE_UUID, MLX97_CHAR_CTRL, MLX97_CTRL_STOP, manager);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      unsubscribeAll();
      setRunning(false);
      setLoading(false);
    }
  }, [device.id, manager, running, unsubscribeAll]);

  useEffect(() => {
    return () => {
      // Best-effort stop on unmount
      try { stop(); } catch {}
    };
  }, [stop]);

  const statusText = useMemo(() => running ? "Streaming" : "Idle", [running]);

  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>MLX97</Text>
          <View style={styles.subtitleRow}>
            <View style={[styles.dot, { backgroundColor: running ? '#16a34a' : '#9ca3af' }]} />
            <Text style={styles.subtitle}>{device.name} • {statusText}</Text>
          </View>
        </View>
        {running ? (
          <TouchableOpacity style={[styles.actionButton, styles.stop]} onPress={stop} disabled={loading}>
            <Text style={styles.actionText}>Stop</Text>
            {loading ? <ActivityIndicator size="small" style={{ marginLeft: 8 }} /> : null}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[styles.actionButton, styles.start]} onPress={start} disabled={loading}>
            <Text style={styles.actionText}>Start</Text>
            {loading ? <ActivityIndicator size="small" style={{ marginLeft: 8 }} /> : null}
          </TouchableOpacity>
        )}
      </View>

      {err ? (
        <View style={styles.errorCard}><Text style={styles.errorText}>{err}</Text></View>
      ) : null}

      <Text style={styles.sectionHeader}>Stream 0</Text>
      <View style={styles.card}>
        {last0 ? (
          <>
            <Text style={styles.metricLine}>t = {last0.t_ms} ms</Text>
            <Text style={styles.metricLine}>x = {last0.x}  y = {last0.y}  z = {last0.z}</Text>
            <Text style={styles.subtle}>stat1=0x{(last0.stat1 ?? 0).toString(16).padStart(2,'0')} stat2=0x{(last0.stat2 ?? 0).toString(16).padStart(2,'0')}</Text>
          </>
        ) : (
          <Text style={styles.subtle}>No data yet</Text>
        )}
      </View>

      <Text style={styles.sectionHeader}>Stream 1</Text>
      <View style={styles.card}>
        {last1 ? (
          <>
            <Text style={styles.metricLine}>t = {last1.t_ms} ms</Text>
            <Text style={styles.metricLine}>x = {last1.x}  y = {last1.y}  z = {last1.z}</Text>
            <Text style={styles.subtle}>stat1=0x{(last1.stat1 ?? 0).toString(16).padStart(2,'0')} stat2=0x{(last1.stat2 ?? 0).toString(16).padStart(2,'0')}</Text>
          </>
        ) : (
          <Text style={styles.subtle}>No data yet</Text>
        )}
      </View>
    </View>
  );
};

const plugin: DevicePlugin = {
  key: "mlx97",
  matches: (t) => t === "mlx97",
  Popup,
};

export default plugin;

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: 16,
    backgroundColor: '#f6f7f8',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#111827',
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  subtitle: {
    color: '#6b7280',
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  actionText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 16,
  },
  start: { backgroundColor: '#2563eb' },
  stop: { backgroundColor: '#ef4444' },
  sectionHeader: {
    marginTop: 12,
    marginBottom: 8,
    color: '#6b7280',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    marginBottom: 12,
    ...Platform.select({ ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8 }, android: { elevation: 1 }, default: {} }),
  },
  metricLine: {
    fontWeight: '600',
    color: '#111827',
  },
  subtle: {
    color: '#6b7280',
  },
  errorCard: {
    backgroundColor: '#fee2e2',
    borderRadius: 10,
    padding: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#fecaca',
    marginBottom: 8,
  },
  errorText: {
    color: '#b91c1c',
  },
});

