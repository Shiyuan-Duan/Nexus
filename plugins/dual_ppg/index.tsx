import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Line, Polyline } from "react-native-svg";
import type { DeviceIdentity } from "../../constants/devices";
import type { DevicePlugin } from "../registry";
import { getBleManager } from "../../services/ble/bleManager";
import { monitor, write } from "../../services/ble/bleClient";
import { getStrength, subscribe as subscribeDevices } from "../../state/devices.store";
import {
  DUAL_PPG_CHAR_CTRL,
  DUAL_PPG_CHAR_STREAM,
  DUAL_PPG_PACKET_BYTES,
  DUAL_PPG_CTRL_START,
  DUAL_PPG_CTRL_STOP,
  DUAL_PPG_SERVICE_UUID,
  parseDualPpgSample,
  type DualPpgSample,
} from "../../services/ble/profiles/dualPpg";
import { publishSample } from "../../services/data/dataBus";
import {
  getActiveRecordingId,
  isRecording,
  startRecording,
  stopRecording,
  subscribe as subscribeRecorder,
} from "../../services/data/recorder";

const WINDOW_MS = 5000;
type TimedPoint = { t: number; v: number };

function toHex(data: Uint8Array): string {
  return Array.from(data).map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function appendSeries(series: TimedPoint[], t: number, value: number): TimedPoint[] {
  const cutoff = t - WINDOW_MS;
  const next = series.filter((point) => point.t >= cutoff);
  next.push({ t, v: value });
  return next;
}

function toPolyline(points: TimedPoint[], width: number, height: number): string {
  if (points.length === 0) return "";
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (!Number.isFinite(p.v)) continue;
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return "";
  const span = Math.max(1, max - min);
  const t0 = points[0]?.t ?? 0;
  const t1 = points[points.length - 1]?.t ?? t0;
  const timeSpan = Math.max(1, t1 - t0);
  return points
    .map((p) => {
      const x = ((p.t - t0) / timeSpan) * width;
      const y = height - ((p.v - min) / span) * height;
      return `${x},${y}`;
    })
    .join(" ");
}

function formatHeldValue(value: number | null): string {
  return value == null ? "-" : String(value);
}

const Popup: React.FC<{ device: DeviceIdentity }> = ({ device }) => {
  const manager = getBleManager();
  const [rev, setRev] = useState(0);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [last, setLast] = useState<DualPpgSample | null>(null);
  const [lastValid0, setLastValid0] = useState<number | null>(null);
  const [lastValid1, setLastValid1] = useState<number | null>(null);
  const [series0, setSeries0] = useState<TimedPoint[]>([]);
  const [series1, setSeries1] = useState<TimedPoint[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<0 | 1>(0);
  const [recording, setRecording] = useState(isRecording());
  const [activeId, setActiveId] = useState<string | null>(getActiveRecordingId());
  const subRef = useRef<{ unsubscribe: () => void } | null>(null);

  useEffect(() => {
    const unsub = subscribeDevices(() => setRev((v) => v + 1));
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = subscribeRecorder(() => {
      setRecording(isRecording());
      setActiveId(getActiveRecordingId());
    });
    return () => unsub();
  }, []);

  const strength = useMemo(() => getStrength(device.id), [device.id, rev]);

  const strengthColor = useCallback((s?: string): string => {
    if (s === "strong") return "#22c55e";
    if (s === "medium" || s === "weak") return "#f59e0b";
    if (s === "disconnected") return "#ef4444";
    return "#9ca3af";
  }, []);

  const unsubscribeAll = useCallback(() => {
    try { subRef.current?.unsubscribe(); } catch {}
    subRef.current = null;
  }, []);

  const handleSample = useCallback((sample: DualPpgSample) => {
    setLast(sample);
    if ((sample.valid_mask & 0x01) !== 0) {
      setLastValid0(sample.sensor0_sample);
      setSeries0((prev) => appendSeries(prev, sample.t_ms, sample.sensor0_sample));
    }
    if ((sample.valid_mask & 0x02) !== 0) {
      setLastValid1(sample.sensor1_sample);
      setSeries1((prev) => appendSeries(prev, sample.t_ms, sample.sensor1_sample));
    }
    publishSample({
      deviceId: device.id,
      t: sample.t_ms,
      values: [
        (sample.valid_mask & 0x01) !== 0 ? sample.sensor0_sample : Number.NaN,
        (sample.valid_mask & 0x02) !== 0 ? sample.sensor1_sample : Number.NaN,
        sample.sensor0_tag,
        sample.sensor1_tag,
        sample.valid_mask,
      ],
      kind: "dual_ppg",
    });
  }, [device.id]);

  const start = useCallback(async (): Promise<boolean> => {
    if (!manager) {
      setErr("BLE manager unavailable");
      return false;
    }
    if (running) return true;
    setLoading(true);
    setErr(null);
    try {
      // eslint-disable-next-line no-console
      console.log("[DUAL_PPG][START] begin", { deviceId: device.id });
      if (typeof (manager as any).discoverAllServicesAndCharacteristicsForDevice === "function") {
        await (manager as any).discoverAllServicesAndCharacteristicsForDevice(device.id);
        // eslint-disable-next-line no-console
        console.log("[DUAL_PPG][START] discovery complete");
      }
      if (typeof (manager as any).servicesForDevice === "function") {
        const svcs = await (manager as any).servicesForDevice(device.id);
        // eslint-disable-next-line no-console
        console.log("[DUAL_PPG][START] services", (svcs || []).map((s: any) => String(s.uuid).toLowerCase()));
      }
      if (typeof (manager as any).characteristicsForDevice === "function") {
        const chars = await (manager as any).characteristicsForDevice(device.id, DUAL_PPG_SERVICE_UUID);
        // eslint-disable-next-line no-console
        console.log(
          "[DUAL_PPG][START] chars",
          (chars || []).map((c: any) => ({
            uuid: String(c.uuid).toLowerCase(),
            readable: !!c.isReadable,
            writable: !!c.isWritableWithResponse,
            notifiable: !!c.isNotifiable,
          }))
        );
      }
      subRef.current = monitor(
        device.id,
        DUAL_PPG_SERVICE_UUID,
        DUAL_PPG_CHAR_STREAM,
        (data) => {
          // eslint-disable-next-line no-console
          console.log("[DUAL_PPG][RAW]", {
            deviceId: device.id,
            len: data.length,
            expected: DUAL_PPG_PACKET_BYTES,
            hex: toHex(data),
          });
          const sample = parseDualPpgSample(data);
          if (!sample) {
            // eslint-disable-next-line no-console
            console.warn("[DUAL_PPG][DROP] failed to parse packet");
            return;
          }
          // eslint-disable-next-line no-console
          console.log("[DUAL_PPG][PARSED]", sample);
          handleSample(sample);
        },
        manager
      );
      // eslint-disable-next-line no-console
      console.log("[DUAL_PPG][START] monitor attached");
      await write(device.id, DUAL_PPG_SERVICE_UUID, DUAL_PPG_CHAR_CTRL, DUAL_PPG_CTRL_START, manager);
      // eslint-disable-next-line no-console
      console.log("[DUAL_PPG][START] ctrl write sent", { hex: toHex(DUAL_PPG_CTRL_START) });
      setRunning(true);
      return true;
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn("[DUAL_PPG][START] failed", e?.message ?? String(e));
      setErr(e?.message ?? String(e));
      unsubscribeAll();
      setRunning(false);
      return false;
    } finally {
      setLoading(false);
    }
  }, [device.id, handleSample, manager, running, unsubscribeAll]);

  const stop = useCallback(async () => {
    if (!manager || !running) return;
    setLoading(true);
    setErr(null);
    try {
      // eslint-disable-next-line no-console
      console.log("[DUAL_PPG][STOP] ctrl write sent", { deviceId: device.id, hex: toHex(DUAL_PPG_CTRL_STOP) });
      await write(device.id, DUAL_PPG_SERVICE_UUID, DUAL_PPG_CHAR_CTRL, DUAL_PPG_CTRL_STOP, manager);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn("[DUAL_PPG][STOP] failed", e?.message ?? String(e));
      setErr(e?.message ?? String(e));
    } finally {
      unsubscribeAll();
      setRunning(false);
      setLoading(false);
    }
  }, [device.id, manager, running, unsubscribeAll]);

  useEffect(() => {
    return () => {
      try { unsubscribeAll(); } catch {}
    };
  }, [unsubscribeAll]);

  const toggleRecording = useCallback(async () => {
    if (recording && activeId) {
      await stopRecording();
      return;
    }
    if (!running) {
      const ok = await start();
      if (!ok) return;
    }
    await startRecording("dual_ppg", ["Sensor0", "Sensor1"]);
  }, [activeId, recording, running, start]);

  const line0 = useMemo(() => toPolyline(series0, 320, 120), [series0]);
  const line1 = useMemo(() => toPolyline(series1, 320, 120), [series1]);
  const activeLine = selectedChannel === 0 ? line0 : line1;
  const activeColor = selectedChannel === 0 ? "#2563eb" : "#0f766e";
  const activeLabel = selectedChannel === 0 ? "Sensor 0" : "Sensor 1";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <View style={styles.heroTop}>
            <View>
              <Text style={styles.title}>Dual PPG</Text>
              <View style={styles.subtitleRow}>
                <View style={[styles.dot, { backgroundColor: strengthColor(strength) }]} />
                <Text style={styles.subtitle}>{device.name} • {running ? "Streaming" : "Idle"}</Text>
              </View>
            </View>
            <View style={[styles.pill, running ? styles.pillLive : styles.pillIdle]}>
              <Text style={styles.pillText}>{running ? "Live" : "Idle"}</Text>
            </View>
          </View>

          <View style={styles.actionRow}>
            {running ? (
              <TouchableOpacity style={[styles.button, styles.stop]} onPress={stop} disabled={loading}>
                <Text style={styles.buttonText}>Stop Stream</Text>
                {loading ? <ActivityIndicator size="small" color="#fff" style={styles.spinner} /> : null}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={[styles.button, styles.start]} onPress={start} disabled={loading}>
                <Text style={styles.buttonText}>Start Stream</Text>
                {loading ? <ActivityIndicator size="small" color="#fff" style={styles.spinner} /> : null}
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.button, recording ? styles.recordStop : styles.recordStart]}
              onPress={toggleRecording}
              disabled={loading}
            >
              <Text style={styles.buttonText}>{recording ? "Stop Rec" : "Record"}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {err ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{err}</Text>
          </View>
        ) : null}

        <View style={styles.chartCard}>
          <View style={styles.chartHeader}>
            <Text style={styles.chartTitle}>Live Raw Samples</Text>
            <Text style={styles.chartMeta}>{activeLabel} • 5s window • auto scale</Text>
          </View>
          <View style={styles.toggleRow}>
            <TouchableOpacity
              style={[styles.toggleButton, selectedChannel === 0 ? styles.toggleActiveBlue : null]}
              onPress={() => setSelectedChannel(0)}
            >
              <Text style={[styles.toggleText, selectedChannel === 0 ? styles.toggleTextActive : null]}>S0</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toggleButton, selectedChannel === 1 ? styles.toggleActiveGreen : null]}
              onPress={() => setSelectedChannel(1)}
            >
              <Text style={[styles.toggleText, selectedChannel === 1 ? styles.toggleTextActive : null]}>S1</Text>
            </TouchableOpacity>
          </View>
          <Svg width="100%" height={140} viewBox="0 0 320 140">
            <Line x1="0" y1="120" x2="320" y2="120" stroke="#d1d5db" strokeWidth="1" />
            {activeLine ? <Polyline points={activeLine} fill="none" stroke={activeColor} strokeWidth="2" /> : null}
          </Svg>
        </View>

        <View style={styles.statsCard}>
          <Text style={styles.statsTitle}>Latest Packet</Text>
          <Text style={styles.statsLine}>seq: {last?.seq ?? "-"}</Text>
          <Text style={styles.statsLine}>valid_mask: {last?.valid_mask ?? "-"}</Text>
          <Text style={styles.statsLine}>sensor0: {formatHeldValue(lastValid0)}</Text>
          <Text style={styles.statsLine}>sensor1: {formatHeldValue(lastValid1)}</Text>
          <Text style={styles.statsLine}>tag0/tag1: {last ? `${last.sensor0_tag}/${last.sensor1_tag}` : "-"}</Text>
          {recording ? <Text style={styles.recordHint}>Recording into current dataset.</Text> : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const plugin: DevicePlugin = {
  key: "dual_ppg",
  matches: (t) => t === "dual_ppg",
  Popup,
};

export default plugin;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f3f4f6" },
  screen: { flex: 1 },
  content: { padding: 16, gap: 16 },
  hero: {
    backgroundColor: "#111827",
    borderRadius: 20,
    padding: 18,
  },
  heroTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  title: { color: "#fff", fontSize: 24, fontWeight: "700" },
  subtitleRow: { flexDirection: "row", alignItems: "center", marginTop: 6 },
  subtitle: { color: "#d1d5db", fontSize: 14 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  pillLive: { backgroundColor: "#14532d" },
  pillIdle: { backgroundColor: "#374151" },
  pillText: { color: "#fff", fontWeight: "600" },
  actionRow: { flexDirection: "row", gap: 10 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flex: 1,
  },
  start: { backgroundColor: "#2563eb" },
  stop: { backgroundColor: "#dc2626" },
  recordStart: { backgroundColor: "#0f766e" },
  recordStop: { backgroundColor: "#7c2d12" },
  buttonText: { color: "#fff", fontWeight: "700" },
  spinner: { marginLeft: 8 },
  errorCard: { backgroundColor: "#fef2f2", borderRadius: 14, padding: 14 },
  errorText: { color: "#991b1b" },
  chartCard: { backgroundColor: "#fff", borderRadius: 18, padding: 16 },
  chartHeader: { marginBottom: 10 },
  chartTitle: { fontSize: 18, fontWeight: "700", color: "#111827" },
  chartMeta: { marginTop: 4, color: "#6b7280" },
  toggleRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  toggleButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "#e5e7eb",
  },
  toggleActiveBlue: { backgroundColor: "#2563eb" },
  toggleActiveGreen: { backgroundColor: "#0f766e" },
  toggleActiveAmber: { backgroundColor: "#d97706" },
  toggleActiveRed: { backgroundColor: "#dc2626" },
  toggleText: { color: "#374151", fontWeight: "700" },
  toggleTextActive: { color: "#fff" },
  statsCard: { backgroundColor: "#fff", borderRadius: 18, padding: 16, gap: 6 },
  statsTitle: { fontSize: 18, fontWeight: "700", color: "#111827", marginBottom: 4 },
  statsLine: { color: "#1f2937", fontSize: 14 },
  recordHint: { color: "#0f766e", marginTop: 8, fontWeight: "600" },
});
