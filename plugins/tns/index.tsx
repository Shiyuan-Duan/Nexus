import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View, ActivityIndicator, Switch, StyleSheet, TouchableOpacity, Platform, ScrollView } from "react-native";
import Svg, { Line, Polyline } from "react-native-svg";
import type { DeviceIdentity } from "../../constants/devices";
import type { DevicePlugin } from "../registry";
import { getBleManager } from "../../services/ble/bleManager";
import { connect, monitor, read, write } from "../../services/ble/bleClient";
import { getStrength, setStrength, subscribe } from "../../state/devices.store";
import {
  TNS_SERVICE_UUID,
  TNS_CHAR_SWITCH,
  TNS_CHAR_AMPLITUDE,
  TNS_CHAR_FREQUENCY,
  TNS_CHAR_IMU,
} from "../../services/ble/profiles/tns";
import CircularDial from "../../components/CircularDial";

const IMU_MAX_SAMPLES = 120;
const IMU_SAMPLE_MIN = 2;
const RECONNECT_TIMEOUT_MS = 6000;

function strengthColor(s?: string): string {
  if (s === "strong") return "#22c55e";
  if (s === "medium" || s === "weak") return "#f59e0b";
  if (s === "disconnected") return "#ef4444";
  return "#9ca3af";
}

const u16le = (data: Uint8Array, offset: number): number =>
  (data[offset] | (data[offset + 1] << 8)) >>> 0;

const u32le = (data: Uint8Array, offset: number): number =>
  (data[offset] |
    (data[offset + 1] << 8) |
    (data[offset + 2] << 16) |
    (data[offset + 3] << 24)) >>> 0;

const i16le = (data: Uint8Array, offset: number): number => {
  const v = (data[offset] | (data[offset + 1] << 8)) & 0xffff;
  return v & 0x8000 ? v - 0x10000 : v;
};

type ImuSample = {
  tMs: number;
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
};

const parseImuSample = (data: Uint8Array): ImuSample | null => {
  if (data.length < 16) return null;
  return {
    tMs: u32le(data, 0),
    ax: i16le(data, 4),
    ay: i16le(data, 6),
    az: i16le(data, 8),
    gx: i16le(data, 10),
    gy: i16le(data, 12),
    gz: i16le(data, 14),
  };
};

const withTimeout = async <T,>(p: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
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
    if (width <= 0 || data.length < IMU_SAMPLE_MIN) return "";
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
      {count < IMU_SAMPLE_MIN ? (
        <Text style={styles.chartEmpty}>Waiting for IMU data…</Text>
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

const Popup: React.FC<{ device: DeviceIdentity }> = ({ device }) => {
  const manager = getBleManager();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [switchByte, setSwitchByte] = useState<number | null>(null);
  const [ampByte, setAmpByte] = useState<number | null>(null);
  const [freqHz, setFreqHz] = useState<number | null>(null);
  const [writingSwitch, setWritingSwitch] = useState(false);
  const [writingAmp, setWritingAmp] = useState(false);
  const [writingFreq, setWritingFreq] = useState(false);
  const [imuEnabled, setImuEnabled] = useState(false);
  const [imuSamples, setImuSamples] = useState<ImuSample[]>([]);
  const [scrollEnabled, setScrollEnabled] = useState(true);
  const [linkDown, setLinkDown] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const imuSubRef = useRef<{ unsubscribe: () => void } | null>(null);
  const wasLinkDownRef = useRef(false);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    const unsub = subscribe(() => setRev((v) => v + 1));
    return unsub;
  }, []);


  const readAll = useCallback(async () => {
    if (!manager) {
      setErr("BLE manager unavailable");
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      // Ensure services/characteristics are discovered before reading
      if (typeof (manager as any).discoverAllServicesAndCharacteristicsForDevice === 'function') {
        await (manager as any).discoverAllServicesAndCharacteristicsForDevice(device.id);
      }
      if (typeof (manager as any).servicesForDevice === 'function') {
        try {
          const svcs = await (manager as any).servicesForDevice(device.id);
          const list = (svcs || []).map((s: any) => String(s.uuid).toLowerCase());
          const want = String(TNS_SERVICE_UUID).toLowerCase();
          const has = list.includes(want);
          if (!has) {
            throw new Error("Required service not found on device.");
          }
        } catch {}
      }

      const sw = await read(device.id, TNS_SERVICE_UUID, TNS_CHAR_SWITCH, manager);
      setSwitchByte(sw.length > 0 ? sw[0] : null);

      const amp = await read(device.id, TNS_SERVICE_UUID, TNS_CHAR_AMPLITUDE, manager);
      const a = amp.length > 0 ? amp[0] : null;
      setAmpByte(typeof a === 'number' ? Math.max(0, Math.min(100, a)) : a);

      const freq = await read(device.id, TNS_SERVICE_UUID, TNS_CHAR_FREQUENCY, manager);
      if (freq.length >= 2) {
        setFreqHz(u16le(freq, 0));
      }
      setLinkDown(false);

    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setLinkDown(true);
    } finally {
      setLoading(false);
    }
  }, [device.id, manager]);

  useEffect(() => {
    // Auto-read once when opening
    readAll();
  }, [readAll]);

  const writeSwitch = useCallback(
    async (on: boolean) => {
      if (!manager) {
        setErr("BLE manager unavailable");
        return;
      }
      if (linkDown) return;
      setWritingSwitch(true);
      setErr(null);
      try {
        const value = new Uint8Array([on ? 1 : 0]);
        await write(device.id, TNS_SERVICE_UUID, TNS_CHAR_SWITCH, value, manager);
        setLinkDown(false);
      } catch (e: any) {
        setErr(e?.message ?? String(e));
        setLinkDown(true);
      } finally {
        // Read back to confirm
        try {
          const sw = await read(device.id, TNS_SERVICE_UUID, TNS_CHAR_SWITCH, manager);
          setSwitchByte(sw.length > 0 ? sw[0] : null);
        } catch (e: any) {
          setErr((prev) => prev ?? (e?.message ?? String(e)));
        }
        setWritingSwitch(false);
      }
    },
    [device.id, manager]
  );

  const writeAmp = useCallback(
    async (amp: number) => {
      if (!manager) {
        setErr("BLE manager unavailable");
        return;
      }
      if (linkDown) return;
      const clamped = Math.max(0, Math.min(100, Math.round(amp)));
      setWritingAmp(true);
      setErr(null);
      try {
        const value = new Uint8Array([clamped & 0xff]);
        await write(device.id, TNS_SERVICE_UUID, TNS_CHAR_AMPLITUDE, value, manager);
        setLinkDown(false);
      } catch (e: any) {
        setErr(e?.message ?? String(e));
        setLinkDown(true);
      } finally {
        // Read back to confirm
        try {
          const rv = await read(device.id, TNS_SERVICE_UUID, TNS_CHAR_AMPLITUDE, manager);
          const a2 = rv.length > 0 ? rv[0] : null;
          setAmpByte(typeof a2 === 'number' ? Math.max(0, Math.min(100, a2)) : a2);
        } catch (e: any) {
          setErr((prev) => prev ?? (e?.message ?? String(e)));
        }
        setWritingAmp(false);
      }
    },
    [device.id, manager]
  );

  const writeFrequency = useCallback(
    async (hz: number) => {
      if (!manager) {
        setErr("BLE manager unavailable");
        return;
      }
      if (linkDown) return;
      const clamped = Math.max(1, Math.min(1000, Math.round(hz)));
      setWritingFreq(true);
      setErr(null);
      try {
        const value = new Uint8Array([clamped & 0xff, (clamped >> 8) & 0xff]);
        await write(device.id, TNS_SERVICE_UUID, TNS_CHAR_FREQUENCY, value, manager);
        setLinkDown(false);
      } catch (e: any) {
        setErr(e?.message ?? String(e));
        setLinkDown(true);
      } finally {
        try {
          const rv = await read(device.id, TNS_SERVICE_UUID, TNS_CHAR_FREQUENCY, manager);
          if (rv.length >= 2) {
            setFreqHz(u16le(rv, 0));
          }
        } catch (e: any) {
          setErr((prev) => prev ?? (e?.message ?? String(e)));
        }
        setWritingFreq(false);
      }
    },
    [device.id, manager]
  );

  const amplitudeToCurrent = (a: number | null): number => {
    const pct = Math.max(0, Math.min(100, a ?? 0));
    return (pct * 25) / 100; // 0..25 mA
  };

  useEffect(() => {
    if (!manager || !imuEnabled) {
      imuSubRef.current?.unsubscribe();
      imuSubRef.current = null;
      return;
    }

    const sub = monitor(
      device.id,
      TNS_SERVICE_UUID,
      TNS_CHAR_IMU,
      (data) => {
        const sample = parseImuSample(data);
        if (!sample) return;
        setLinkDown(false);
        wasLinkDownRef.current = false;
        setImuSamples((prev) => {
          const next = prev.length >= IMU_MAX_SAMPLES ? prev.slice(prev.length - IMU_MAX_SAMPLES + 1) : prev.slice();
          next.push(sample);
          return next;
        });
      },
      manager
    );
    imuSubRef.current = sub;
    return () => {
      sub.unsubscribe();
      imuSubRef.current = null;
    };
  }, [device.id, imuEnabled, manager]);

  useEffect(() => {
    if (!manager) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const sw = await read(device.id, TNS_SERVICE_UUID, TNS_CHAR_SWITCH, manager);
        if (cancelled) return;
        setSwitchByte(sw.length > 0 ? sw[0] : null);
        setLinkDown(false);
        if (wasLinkDownRef.current) {
          wasLinkDownRef.current = false;
          readAll();
        }
        if (typeof (manager as any).readRSSIForDevice === "function") {
          try {
            const res = await (manager as any).readRSSIForDevice(device.id);
            if (!cancelled && typeof res?.rssi === "number") {
              setStrength(device.id, res.rssi);
            }
          } catch {}
        }
      } catch {
        if (cancelled) return;
        setLinkDown(true);
        wasLinkDownRef.current = true;
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [device.id, manager]);

  useEffect(() => {
    if (linkDown) {
      setStrength(device.id, undefined);
    }
  }, [device.id, linkDown]);

  const handleReconnect = useCallback(async () => {
    if (!manager) {
      setErr("BLE manager unavailable");
      return;
    }
    setReconnecting(true);
    setErr(null);
    try {
      await withTimeout(connect(device.id, manager), RECONNECT_TIMEOUT_MS, "Reconnect timed out");
      setLinkDown(false);
      wasLinkDownRef.current = false;
      await withTimeout(readAll(), RECONNECT_TIMEOUT_MS, "Sync timed out");
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setLinkDown(true);
      wasLinkDownRef.current = true;
    } finally {
      setReconnecting(false);
    }
  }, [device.id, manager, readAll]);

  const accelSeries = useMemo(() => {
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    imuSamples.forEach((s) => {
      xs.push(s.ax);
      ys.push(s.ay);
      zs.push(s.az);
    });
    return [xs, ys, zs];
  }, [imuSamples]);

  const gyroSeries = useMemo(() => {
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    imuSamples.forEach((s) => {
      xs.push(s.gx / 10);
      ys.push(s.gy / 10);
      zs.push(s.gz / 10);
    });
    return [xs, ys, zs];
  }, [imuSamples]);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.screenContent}
      scrollEnabled={scrollEnabled}
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>TNS</Text>
          <View style={styles.subtitleRow}>
            <View style={[styles.dot, { backgroundColor: linkDown ? "#ef4444" : strengthColor(getStrength(device.id)) }]} />
            <Text style={styles.subtitle}>{device.name}</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.syncButton} onPress={readAll} disabled={loading}>
          <Text style={[styles.syncText, loading && { opacity: 0.6 }]}>Sync</Text>
          {loading ? <ActivityIndicator size="small" style={{ marginLeft: 8 }} /> : null}
        </TouchableOpacity>
      </View>

      {err ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{err}</Text>
        </View>
      ) : null}

      {linkDown ? (
        <View style={styles.disconnectCard}>
          <View style={styles.rowBetween}>
            <Text style={styles.disconnectTitle}>Device disconnected</Text>
            <TouchableOpacity
              style={[styles.reconnectButton, reconnecting && { opacity: 0.6 }]}
              onPress={handleReconnect}
              disabled={reconnecting}
            >
              <Text style={styles.reconnectText}>{reconnecting ? "Reconnecting..." : "Reconnect"}</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.disconnectSubtle}>Controls are disabled until the device is back online.</Text>
        </View>
      ) : null}

      {/* Controls section */}
      <Text style={styles.sectionHeader}>Controls</Text>

      {/* Stimulation toggle card */}
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>Stimulation</Text>
          <View style={styles.rowCenter}>
            {writingSwitch ? <ActivityIndicator size="small" style={{ marginRight: 8 }} /> : null}
            <Switch
              value={!!(switchByte && switchByte !== 0)}
              onValueChange={(v) => {
                // Optimistic update; confirmed on read-back
                setSwitchByte(v ? 1 : 0);
                writeSwitch(v);
              }}
              disabled={linkDown || writingSwitch || reconnecting}
            />
          </View>
        </View>
        <Text style={styles.cardSubtle}>{switchByte ? 'On' : 'Off'}</Text>
      </View>

      {/* Intensity dial card */}
      <View style={[styles.card, styles.centered]}>
        <Text style={styles.cardTitle}>Intensity</Text>
        <View
          onTouchStart={() => setScrollEnabled(false)}
          onTouchEnd={() => setScrollEnabled(true)}
          onTouchCancel={() => setScrollEnabled(true)}
          onTouchMove={() => setScrollEnabled(false)}
        >
          <CircularDial
            value={Math.max(0, Math.min(100, ampByte ?? 0))}
            onChange={(v) => setAmpByte(Math.max(0, Math.min(100, Math.round(v))))}
            onComplete={(v) => writeAmp(v)}
            size={220}
            stroke={18}
            progressColor="#16a34a"
            handleColor="#16a34a"
            disabled={loading || writingAmp || linkDown || reconnecting}
          >
            <View style={{ alignItems: 'center' }}>
              {writingAmp ? <ActivityIndicator size="small" /> : null}
              <Text style={styles.bigNumber}>{amplitudeToCurrent(ampByte).toFixed(2)} <Text style={styles.unit}>mA</Text></Text>
              <Text style={styles.cardSubtle}>output</Text>
            </View>
          </CircularDial>
        </View>
        <Text style={[styles.cardSubtle, { marginTop: 6 }]}>{Math.max(0, Math.min(100, ampByte ?? 0))}%</Text>
      </View>

      {/* Frequency control */}
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>Frequency</Text>
          {writingFreq ? <ActivityIndicator size="small" /> : null}
        </View>
        <View style={styles.freqRow}>
          <TouchableOpacity
            style={styles.freqButton}
            onPress={() => {
              const next = Math.max(1, (freqHz ?? 5) - 1);
              setFreqHz(next);
              writeFrequency(next);
            }}
            disabled={writingFreq || linkDown || reconnecting}
          >
            <Text style={styles.freqButtonText}>-</Text>
          </TouchableOpacity>
          <Text style={styles.freqValue}>{freqHz ?? 5} Hz</Text>
          <TouchableOpacity
            style={styles.freqButton}
            onPress={() => {
              const next = Math.min(1000, (freqHz ?? 5) + 1);
              setFreqHz(next);
              writeFrequency(next);
            }}
            disabled={writingFreq || linkDown || reconnecting}
          >
            <Text style={styles.freqButtonText}>+</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.cardSubtle}>Default 5 Hz</Text>
      </View>

      {/* IMU streaming */}
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>IMU Streaming</Text>
          <Switch
            value={imuEnabled}
            onValueChange={(v) => {
              setImuEnabled(v);
              if (!v) setImuSamples([]);
            }}
            disabled={linkDown || reconnecting}
          />
        </View>
        <Text style={styles.cardSubtle}>{imuEnabled ? "On" : "Off"}</Text>
      </View>

      {imuEnabled ? (
        <View style={[styles.card, styles.imuCard]}>
          <Text style={styles.cardTitle}>IMU Live Plot</Text>
          <Text style={styles.chartLabel}>Accel (mg)</Text>
          <SimpleLineChart series={accelSeries} colors={["#0ea5e9", "#22c55e", "#f97316"]} height={140} />
          <Text style={styles.chartLabel}>Gyro (deg/s)</Text>
          <SimpleLineChart series={gyroSeries} colors={["#0ea5e9", "#22c55e", "#f97316"]} height={140} />
          <View style={styles.legendRow}>
            <View style={[styles.legendDot, { backgroundColor: "#0ea5e9" }]} />
            <Text style={styles.legendText}>X</Text>
            <View style={[styles.legendDot, { backgroundColor: "#22c55e" }]} />
            <Text style={styles.legendText}>Y</Text>
            <View style={[styles.legendDot, { backgroundColor: "#f97316" }]} />
            <Text style={styles.legendText}>Z</Text>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
};

const plugin: DevicePlugin = {
  key: "tns",
  matches: (t) => t === "tns",
  Popup,
};

export default plugin;

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: 16,
    backgroundColor: '#f6f7f8',
  },
  screenContent: {
    paddingBottom: 24,
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
  syncButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  syncText: {
    color: '#2563eb',
    fontWeight: '600',
    fontSize: 16,
  },
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
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 8,
      },
      android: {
        elevation: 1,
      },
      default: {},
    }),
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowCenter: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  centered: {
    alignItems: 'center',
  },
  cardTitle: {
    fontWeight: '600',
    fontSize: 16,
    color: '#111827',
  },
  cardSubtle: {
    color: '#6b7280',
    marginTop: 6,
  },
  bigNumber: {
    fontSize: 28,
    fontWeight: '700',
    color: '#111827',
  },
  unit: {
    fontSize: 16,
    color: '#6b7280',
  },
  freqRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  freqButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f9fafb',
  },
  freqButtonText: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
  },
  freqValue: {
    fontSize: 20,
    fontWeight: '600',
    color: '#111827',
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
  disconnectCard: {
    backgroundColor: '#fff7ed',
    borderRadius: 12,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#fed7aa',
    marginBottom: 10,
  },
  disconnectTitle: {
    color: '#9a3412',
    fontWeight: '700',
  },
  disconnectSubtle: {
    color: '#9a3412',
    marginTop: 6,
  },
  reconnectButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#9a3412',
  },
  reconnectText: {
    color: '#fff7ed',
    fontWeight: '600',
  },
  imuCard: {
    paddingBottom: 18,
  },
  chartWrap: {
    width: '100%',
    height: 140,
    marginTop: 8,
    backgroundColor: '#f9fafb',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  chartEmpty: {
    color: '#9ca3af',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 40,
  },
  chartLabel: {
    marginTop: 10,
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '600',
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  legendText: {
    marginRight: 12,
    color: '#6b7280',
    fontSize: 12,
  },
});
