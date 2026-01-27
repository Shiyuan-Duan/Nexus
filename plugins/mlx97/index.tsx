import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform, TextInput, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Line, Polyline } from "react-native-svg";
import type { DeviceIdentity } from "../../constants/devices";
import type { DevicePlugin } from "../registry";
import { getBleManager } from "../../services/ble/bleManager";
import { monitor, write } from "../../services/ble/bleClient";
import { getStrength, subscribe as subscribeDevices } from "../../state/devices.store";
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
import { publishSample } from "../../services/data/dataBus";
import {
  isRecording,
  getActiveRecordingId,
  markEvent,
  setEventNames as setRecorderEventNames,
  startRecording,
  stopRecording,
  subscribe as subscribeRecorder,
} from "../../services/data/recorder";

const Popup: React.FC<{ device: DeviceIdentity }> = ({ device }) => {
  const manager = getBleManager();
  const [rev, setRev] = useState(0);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [last0, setLast0] = useState<MLX97Sample | null>(null);
  const [last1, setLast1] = useState<MLX97Sample | null>(null);
  const [series0, setSeries0] = useState<[number[], number[], number[]]>([[], [], []]);
  const [series1, setSeries1] = useState<[number[], number[], number[]]>([[], [], []]);
  const [axis0, setAxis0] = useState<Axis>("x");
  const [axis1, setAxis1] = useState<Axis>("x");
  const [axisOpen0, setAxisOpen0] = useState(false);
  const [axisOpen1, setAxisOpen1] = useState(false);
  const [recording, setRecording] = useState(isRecording());
  const [activeId, setActiveId] = useState<string | null>(getActiveRecordingId());
  const [dotOn, setDotOn] = useState(false);
  const [eventNames, setEventNames] = useState<string[]>(() =>
    Array.from({ length: 6 }, (_, i) => `Event ${i + 1}`)
  );
  const sub0Ref = useRef<{ unsubscribe: () => void } | null>(null);
  const sub1Ref = useRef<{ unsubscribe: () => void } | null>(null);
  const count0 = useRef(0);
  const count1 = useRef(0);
  const last0Ref = useRef<MLX97Sample | null>(null);
  const last1Ref = useRef<MLX97Sample | null>(null);

  useEffect(() => {
    const unsub = subscribeDevices(() => setRev((v) => v + 1));
    return unsub;
  }, []);

  const strengthColor = useCallback((s?: string): string => {
    if (s === "strong") return "#22c55e";
    if (s === "medium" || s === "weak") return "#f59e0b";
    if (s === "disconnected") return "#ef4444";
    return "#9ca3af";
  }, []);

  const strength = useMemo(() => getStrength(device.id), [device.id, rev]);

  const publishCombined = useCallback(() => {
    const s0 = last0Ref.current;
    const s1 = last1Ref.current;
    if (!s0 || !s1) return;
    const t = Math.max(s0.t_ms ?? 0, s1.t_ms ?? 0);
    publishSample({
      deviceId: device.id,
      t,
      values: [s0.x, s0.y, s0.z, s1.x, s1.y, s1.z, Number.NaN],
      kind: "mlx97",
    });
  }, [device.id]);

  const unsubscribeAll = useCallback(() => {
    try { sub0Ref.current?.unsubscribe(); } catch {}
    try { sub1Ref.current?.unsubscribe(); } catch {}
    sub0Ref.current = null;
    sub1Ref.current = null;
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (!manager) { setErr("BLE manager unavailable"); return false; }
    if (running) return true;
    setErr(null);
    setLoading(true);
    try {
      // Ensure services/characteristics are discovered before monitor/write
      if (typeof (manager as any).discoverAllServicesAndCharacteristicsForDevice === "function") {
        await (manager as any).discoverAllServicesAndCharacteristicsForDevice(device.id);
      }
      if (typeof (manager as any).servicesForDevice === "function") {
        const svcs = await (manager as any).servicesForDevice(device.id);
        const list = (svcs || []).map((s: any) => String(s.uuid).toLowerCase());
        const want = String(MLX97_SERVICE_UUID).toLowerCase();
        if (!list.includes(want)) {
          throw new Error("Required MLX97 service not found on device.");
        }
      }
      if (typeof (manager as any).characteristicsForDevice === "function") {
        const chars = await (manager as any).characteristicsForDevice(device.id, MLX97_SERVICE_UUID);
        const set = new Set((chars || []).map((c: any) => String(c.uuid).toLowerCase()));
        const need = [
          MLX97_CHAR_STREAM0,
          MLX97_CHAR_STREAM1,
          MLX97_CHAR_CTRL,
        ].map((u) => String(u).toLowerCase());
        const missing = need.filter((u) => !set.has(u));
        if (missing.length > 0) {
          throw new Error(`Missing MLX97 characteristic(s): ${missing.join(", ")}`);
        }
      }
      // Subscribe first to avoid missing initial packets
      count0.current = 0; count1.current = 0;
      sub0Ref.current = monitor(device.id, MLX97_SERVICE_UUID, MLX97_CHAR_STREAM0, (data) => {
        const s = parseMLX97Sample(data);
        if (s) {
          count0.current += 1;
          last0Ref.current = s;
          setLast0(s);
          setSeries0((prev) => appendSeries(prev, s));
          publishCombined();
        }
      }, manager);
      sub1Ref.current = monitor(device.id, MLX97_SERVICE_UUID, MLX97_CHAR_STREAM1, (data) => {
        const s = parseMLX97Sample(data);
        if (s) {
          count1.current += 1;
          last1Ref.current = s;
          setLast1(s);
          setSeries1((prev) => appendSeries(prev, s));
          publishCombined();
        }
      }, manager);
      await write(device.id, MLX97_SERVICE_UUID, MLX97_CHAR_CTRL, MLX97_CTRL_START, manager);
      setRunning(true);
      return true;
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      unsubscribeAll();
      setRunning(false);
      return false;
    } finally {
      setLoading(false);
    }
  }, [device.id, manager, running, unsubscribeAll]);

  useEffect(() => {
    const unsub = subscribeRecorder(() => {
      setRecording(isRecording());
      setActiveId(getActiveRecordingId());
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!recording) {
      setDotOn(false);
      return;
    }
    const t = setInterval(() => setDotOn((v) => !v), 600);
    return () => clearInterval(t);
  }, [recording]);

  const toggleRecording = useCallback(async () => {
    if (recording && activeId) {
      await stopRecording();
      return;
    }
    if (!running) {
      const ok = await start();
      if (!ok) return;
    }
    await startRecording("mlx97", eventNames);
  }, [activeId, eventNames, recording, running, start]);

  const onChangeEventName = useCallback((idx: number, value: string) => {
    setEventNames((prev) => {
      const next = [...prev];
      next[idx] = value;
      if (recording) setRecorderEventNames(next);
      return next;
    });
  }, [recording]);

  const mark = useCallback(async (label: string) => {
    if (!recording) return;
    const clean = label.trim();
    if (!clean) return;
    await markEvent(clean);
  }, [recording]);

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
      last0Ref.current = null;
      last1Ref.current = null;
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
    <SafeAreaView style={styles.safe} edges={['top','left','right','bottom']}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
      <View style={styles.heroCard}>
        <View style={styles.heroTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>MLX97</Text>
            <View style={styles.subtitleRow}>
              <View style={[styles.dot, { backgroundColor: strengthColor(strength) }]} />
              <Text style={styles.subtitle}>{device.name} • {statusText}</Text>
            </View>
          </View>
          <View style={[styles.statusPill, running ? styles.statusLive : styles.statusIdle]}>
            <Text style={[styles.statusText, running ? styles.statusLiveText : styles.statusIdleText]}>
              {running ? "Live" : "Idle"}
            </Text>
          </View>
        </View>
        <View style={styles.actionRow}>
          {running ? (
            <TouchableOpacity style={[styles.primaryButton, styles.stop]} onPress={stop} disabled={loading}>
              <Text style={styles.primaryButtonText}>Stop Stream</Text>
              {loading ? <ActivityIndicator size="small" style={{ marginLeft: 8 }} /> : null}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.primaryButton, styles.start]} onPress={start} disabled={loading}>
              <Text style={styles.primaryButtonText}>Start Stream</Text>
              {loading ? <ActivityIndicator size="small" style={{ marginLeft: 8 }} /> : null}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.recordButton, recording ? styles.recordStop : styles.recordStart]}
            onPress={toggleRecording}
            disabled={loading}
          >
            <View style={[styles.recordDotMini, { opacity: recording ? (dotOn ? 1 : 0.2) : 0.2 }]} />
            <Text style={styles.recordButtonText}>{recording ? "Stop Rec" : "Record"}</Text>
          </TouchableOpacity>
        </View>
        {!running ? (
          <Text style={styles.helperText}>Recording will auto-start the stream.</Text>
        ) : null}
      </View>

      {err ? (
        <View style={styles.errorCard}><Text style={styles.errorText}>{err}</Text></View>
      ) : null}

      <View style={styles.recordCard}>
        <View style={styles.recordHeader}>
          <View style={styles.recordTitleRow}>
            <View
              style={[
                styles.recordDot,
                { opacity: recording ? (dotOn ? 1 : 0.2) : 0.2 },
              ]}
            />
            <Text style={styles.recordTitle}>Recording</Text>
          </View>
          <Text style={styles.recordStatus}>{recording ? "Active" : "Off"}</Text>
        </View>

        <Text style={styles.recordSubtitle}>Event labels</Text>
        {eventNames.map((name, idx) => (
          <View key={`${idx}`} style={styles.eventRow}>
            <TextInput
              value={name}
              onChangeText={(v) => onChangeEventName(idx, v)}
              placeholder={`Event ${idx + 1}`}
              placeholderTextColor="#9ca3af"
              style={styles.eventInput}
            />
            <TouchableOpacity
              onPress={() => mark(name)}
              disabled={!recording}
              style={[styles.eventButton, !recording && styles.eventButtonDisabled]}
            >
              <Text style={styles.eventButtonText}>Mark</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>

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
      <View style={styles.chartCard}>
        <View style={styles.chartHeaderRow}>
          <Text style={styles.chartTitle}>Live plot</Text>
          <View style={styles.dropdownWrap}>
            <TouchableOpacity
              style={styles.dropdownButton}
              onPress={() => setAxisOpen0((v) => !v)}
            >
              <Text style={styles.dropdownButtonText}>{axis0.toUpperCase()}</Text>
            </TouchableOpacity>
            {axisOpen0 ? (
              <View style={styles.dropdownMenu}>
                {AXES.map((a) => (
                  <TouchableOpacity
                    key={a}
                    style={styles.dropdownItem}
                    onPress={() => { setAxis0(a); setAxisOpen0(false); }}
                  >
                    <Text style={styles.dropdownItemText}>{a.toUpperCase()}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
          </View>
        </View>
        <SimpleLineChart series={[pickAxis(series0, axis0)]} colors={["#ef4444"]} height={140} />
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
      <View style={styles.chartCard}>
        <View style={styles.chartHeaderRow}>
          <Text style={styles.chartTitle}>Live plot</Text>
          <View style={styles.dropdownWrap}>
            <TouchableOpacity
              style={styles.dropdownButton}
              onPress={() => setAxisOpen1((v) => !v)}
            >
              <Text style={styles.dropdownButtonText}>{axis1.toUpperCase()}</Text>
            </TouchableOpacity>
            {axisOpen1 ? (
              <View style={styles.dropdownMenu}>
                {AXES.map((a) => (
                  <TouchableOpacity
                    key={a}
                    style={styles.dropdownItem}
                    onPress={() => { setAxis1(a); setAxisOpen1(false); }}
                  >
                    <Text style={styles.dropdownItemText}>{a.toUpperCase()}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
          </View>
        </View>
        <SimpleLineChart series={[pickAxis(series1, axis1)]} colors={["#2563eb"]} height={140} />
      </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const plugin: DevicePlugin = {
  key: "mlx97",
  matches: (t) => t === "mlx97",
  Popup,
};

export default plugin;

const MLX97_PLOT_MAX = 120;
const MLX97_PLOT_MIN = 6;
const AXES = ["x", "y", "z"] as const;
type Axis = (typeof AXES)[number];

const appendSeries = (
  prev: [number[], number[], number[]],
  s: MLX97Sample
): [number[], number[], number[]] => {
  const next0 = [...prev[0], s.x].slice(-MLX97_PLOT_MAX);
  const next1 = [...prev[1], s.y].slice(-MLX97_PLOT_MAX);
  const next2 = [...prev[2], s.z].slice(-MLX97_PLOT_MAX);
  return [next0, next1, next2];
};

const pickAxis = (series: [number[], number[], number[]], axis: Axis): number[] => {
  switch (axis) {
    case "y":
      return series[1];
    case "z":
      return series[2];
    case "x":
    default:
      return series[0];
  }
};

const SimpleLineChart: React.FC<{
  series: number[][];
  colors: string[];
  height: number;
}> = ({ series, colors, height }) => {
  const [width, setWidth] = useState(0);
  const count = Math.max(0, ...series.map((s) => s.length));

  const { min, max } = useMemo(() => {
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    series.forEach((s) => {
      s.forEach((v) => {
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      });
    });
    if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
      return { min: -1, max: 1 };
    }
    if (minV === maxV) {
      return { min: minV - 1, max: maxV + 1 };
    }
    return { min: minV, max: maxV };
  }, [series]);

  const toPoints = (data: number[]) => {
    if (width <= 0 || data.length < MLX97_PLOT_MIN) return "";
    const span = max - min;
    return data
      .map((v, i) => {
        const x = count <= 1 ? 0 : (i / (count - 1)) * width;
        const y = height - ((v - min) / span) * height;
        return `${x},${y}`;
      })
      .join(" ");
  };

  return (
    <View
      style={styles.chartWrap}
      onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))}
    >
      {count < MLX97_PLOT_MIN ? (
        <Text style={styles.chartEmpty}>Waiting for data…</Text>
      ) : (
        <Svg width={width} height={height}>
          <Line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="#e5e7eb" strokeWidth={1} />
          {series.map((s, idx) => (
            <Polyline
              key={idx}
              points={toPoints(s)}
              fill="none"
              stroke={colors[idx] ?? "#111827"}
              strokeWidth={2}
            />
          ))}
        </Svg>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: 16,
    backgroundColor: '#f6f7f8',
  },
  safe: {
    flex: 1,
    backgroundColor: '#f6f7f8',
  },
  screenContent: {
    paddingBottom: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#111827',
  },
  heroCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    marginBottom: 12,
    ...Platform.select({ ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 10 }, android: { elevation: 2 }, default: {} }),
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
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
  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusLive: {
    backgroundColor: '#dcfce7',
    borderColor: '#86efac',
  },
  statusIdle: {
    backgroundColor: '#f3f4f6',
    borderColor: '#e5e7eb',
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  statusLiveText: { color: '#15803d' },
  statusIdleText: { color: '#6b7280' },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  primaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  recordButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  recordButtonText: {
    color: '#111827',
    fontWeight: '700',
    fontSize: 14,
  },
  recordDotMini: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ef4444',
    marginRight: 8,
  },
  recordStart: {
    backgroundColor: '#ffffff',
    borderColor: '#e5e7eb',
  },
  recordStop: {
    backgroundColor: '#fee2e2',
    borderColor: '#fecaca',
  },
  helperText: {
    marginTop: 10,
    color: '#6b7280',
    fontSize: 12,
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
  recordCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    marginBottom: 12,
  },
  recordHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  recordTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  recordDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
    backgroundColor: '#ef4444',
  },
  recordTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  recordStatus: {
    color: '#6b7280',
    fontWeight: '600',
    fontSize: 12,
  },
  recordSubtitle: {
    color: '#6b7280',
    fontWeight: '600',
    marginBottom: 6,
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  eventInput: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    marginRight: 8,
  },
  eventButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#111827',
  },
  eventButtonDisabled: {
    backgroundColor: '#9ca3af',
  },
  eventButtonText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 12,
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
  chartCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    marginBottom: 12,
  },
  chartTitle: {
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  chartHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chartWrap: {
    width: '100%',
  },
  chartEmpty: {
    color: '#9ca3af',
    fontSize: 12,
    paddingVertical: 10,
    textAlign: 'center',
  },
  dropdownWrap: {
    alignItems: 'flex-end',
  },
  dropdownButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    backgroundColor: '#f3f4f6',
  },
  dropdownButtonText: {
    color: '#111827',
    fontWeight: '600',
    fontSize: 12,
    letterSpacing: 0.2,
  },
  dropdownMenu: {
    marginTop: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    overflow: 'hidden',
  },
  dropdownItem: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  dropdownItemText: {
    color: '#111827',
    fontWeight: '600',
    fontSize: 12,
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
