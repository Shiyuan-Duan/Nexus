import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, ActivityIndicator, Switch, Platform, KeyboardAvoidingView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Line, Polyline } from "react-native-svg";
import type { DeviceIdentity } from "../../constants/devices";
import type { DevicePlugin } from "../registry";
import { getBleManager } from "../../services/ble/bleManager";
import { monitor, read, write } from "../../services/ble/bleClient";
import {
  CSFG_SERVICE_UUID,
  CSFG_CHAR_SWITCH,
  CSFG_CHAR_CLEAR,
  CSFG_CHAR_APPEND,
  CSFG_CHAR_COMMIT,
  CSFG_CHAR_INFO,
  CSFG_MAX_ABS_MA,
  type CSFGBlock,
  buildAppendPacket,
  buildU8,
  clampAmpMa,
} from "../../services/ble/profiles/cs_fg";
import { getStrength, subscribe as subscribeDevices } from "../../state/devices.store";

type InfoState = {
  count: number;
  max: number;
  gen: number;
};

type UiBlock = CSFGBlock & { ampText: string; durText: string };

const DEFAULT_BLOCK: UiBlock = { ampMa: 0, durMs: 500, hold: false, ampText: "0", durText: "500" };

const Popup: React.FC<{ device: DeviceIdentity }> = ({ device }) => {
  const manager = getBleManager();
  const [rev, setRev] = useState(0);
  const [blocks, setBlocks] = useState<UiBlock[]>([DEFAULT_BLOCK]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [switchOn, setSwitchOn] = useState(false);
  const [info, setInfo] = useState<InfoState>({ count: 0, max: 64, gen: 0 });
  const scrollRef = useRef<ScrollView | null>(null);
  const blockLayoutRef = useRef<Record<number, number>>({});

  useEffect(() => {
    const unsub = subscribeDevices(() => setRev((v) => v + 1));
    return unsub;
  }, []);

  const strength = useMemo(() => getStrength(device.id), [device.id, rev]);

  const strengthColor = useCallback((s?: string): string => {
    if (s === "strong") return "#22c55e";
    if (s === "medium" || s === "weak") return "#f59e0b";
    if (s === "disconnected") return "#ef4444";
    return "#9ca3af";
  }, []);

  const readInfo = useCallback(async () => {
    if (!manager) return;
    try {
      if (typeof (manager as any).discoverAllServicesAndCharacteristicsForDevice === "function") {
        await (manager as any).discoverAllServicesAndCharacteristicsForDevice(device.id);
      }
      const data = await read(device.id, CSFG_SERVICE_UUID, CSFG_CHAR_INFO, manager);
      if (data.length >= 6) {
        const count = data[0] ?? 0;
        const max = data[1] ?? 0;
        const gen = (data[2] | (data[3] << 8) | (data[4] << 16) | (data[5] << 24)) >>> 0;
        setInfo({ count, max, gen });
      }
    } catch {}
  }, [device.id, manager]);

  const ensureCsfgChars = useCallback(async () => {
    if (!manager) return;
    if (typeof (manager as any).discoverAllServicesAndCharacteristicsForDevice === "function") {
      await (manager as any).discoverAllServicesAndCharacteristicsForDevice(device.id);
    }
    if (typeof (manager as any).servicesForDevice === "function") {
      const svcs = await (manager as any).servicesForDevice(device.id);
      const list = (svcs || []).map((s: any) => String(s.uuid).toLowerCase());
      const want = String(CSFG_SERVICE_UUID).toLowerCase();
      if (!list.includes(want)) {
        throw new Error("CS FG service not found on device.");
      }
    }
    if (typeof (manager as any).characteristicsForDevice === "function") {
      const chars = await (manager as any).characteristicsForDevice(device.id, CSFG_SERVICE_UUID);
      const set = new Set((chars || []).map((c: any) => String(c.uuid).toLowerCase()));
      const need = [
        CSFG_CHAR_SWITCH,
        CSFG_CHAR_CLEAR,
        CSFG_CHAR_APPEND,
        CSFG_CHAR_COMMIT,
        CSFG_CHAR_INFO,
      ].map((u) => String(u).toLowerCase());
      const missing = need.filter((u) => !set.has(u));
      if (missing.length > 0) {
        throw new Error(`Missing CS FG characteristic(s): ${missing.join(", ")}`);
      }
    }
  }, [device.id, manager]);

  useEffect(() => {
    readInfo();
  }, [readInfo]);

  useEffect(() => {
    if (!manager) return;
    const sub = monitor(device.id, CSFG_SERVICE_UUID, CSFG_CHAR_INFO, () => {
      readInfo();
    }, manager);
    return () => sub.unsubscribe();
  }, [device.id, manager, readInfo]);

  const updateAmpText = useCallback((idx: number, text: string) => {
    setBlocks((prev) => {
      const copy = [...prev];
      const b = { ...copy[idx], ampText: text };
      const trimmed = text.trim();
      const isPartial = trimmed === "" || trimmed === "-" || trimmed === "." || trimmed === "-.";
      const num = Number(trimmed);
      if (!isPartial && Number.isFinite(num)) {
        b.ampMa = clampAmpMa(num);
      }
      copy[idx] = b;
      return copy;
    });
  }, []);

  const updateDurText = useCallback((idx: number, text: string) => {
    setBlocks((prev) => {
      const copy = [...prev];
      const b = { ...copy[idx], durText: text };
      const trimmed = text.trim();
      const num = Number(trimmed);
      if (trimmed !== "" && Number.isFinite(num)) {
        b.durMs = Math.max(0, Math.round(num));
      }
      copy[idx] = b;
      return copy;
    });
  }, []);

  const updateHold = useCallback((idx: number, hold: boolean) => {
    setBlocks((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], hold };
      return copy;
    });
  }, []);

  const flipAmpSign = useCallback((idx: number) => {
    setBlocks((prev) => {
      const copy = [...prev];
      const b = { ...copy[idx] };
      b.ampMa = clampAmpMa(-b.ampMa);
      b.ampText = String(b.ampMa);
      copy[idx] = b;
      return copy;
    });
  }, []);

  const onBlockLayout = useCallback((idx: number, y: number) => {
    blockLayoutRef.current[idx] = y;
  }, []);

  const scrollToBlock = useCallback((idx: number) => {
    const y = blockLayoutRef.current[idx];
    if (typeof y !== "number") return;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 20), animated: true });
  }, []);

  const normalizeAmp = useCallback((idx: number) => {
    setBlocks((prev) => {
      const copy = [...prev];
      const b = { ...copy[idx] };
      b.ampMa = clampAmpMa(b.ampMa);
      b.ampText = String(b.ampMa);
      copy[idx] = b;
      return copy;
    });
  }, []);

  const normalizeDur = useCallback((idx: number) => {
    setBlocks((prev) => {
      const copy = [...prev];
      const b = { ...copy[idx] };
      b.durMs = Math.max(0, Math.round(b.durMs));
      b.durText = String(b.durMs);
      copy[idx] = b;
      return copy;
    });
  }, []);

  const addBlock = useCallback(() => {
    setBlocks((prev) => [...prev, { ...DEFAULT_BLOCK }]);
  }, []);

  const removeBlock = useCallback((idx: number) => {
    setBlocks((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const clearPattern = useCallback(async () => {
    if (!manager) return;
    setLoading(true);
    setErr(null);
    try {
      await ensureCsfgChars();
      await write(device.id, CSFG_SERVICE_UUID, CSFG_CHAR_CLEAR, buildU8(1), manager);
      await readInfo();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [device.id, ensureCsfgChars, manager, readInfo]);

  const sendPattern = useCallback(async () => {
    if (!manager) return;
    setLoading(true);
    setErr(null);
    try {
      await ensureCsfgChars();
      await write(device.id, CSFG_SERVICE_UUID, CSFG_CHAR_CLEAR, buildU8(1), manager);
      for (const b of blocks) {
        const pkt = buildAppendPacket({ ampMa: b.ampMa, durMs: b.durMs, hold: b.hold });
        await write(device.id, CSFG_SERVICE_UUID, CSFG_CHAR_APPEND, pkt, manager);
      }
      await write(device.id, CSFG_SERVICE_UUID, CSFG_CHAR_COMMIT, buildU8(1), manager);
      await readInfo();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [blocks, device.id, ensureCsfgChars, manager, readInfo]);

  const toggleSwitch = useCallback(async (on: boolean) => {
    if (!manager) return;
    setLoading(true);
    setErr(null);
    try {
      await ensureCsfgChars();
      await write(device.id, CSFG_SERVICE_UUID, CSFG_CHAR_SWITCH, buildU8(on ? 1 : 0), manager);
      setSwitchOn(on);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [device.id, ensureCsfgChars, manager]);

  const previewPoints = useMemo(() => {
    if (blocks.length === 0) return "";
    const total = blocks.reduce((acc, b) => acc + (b.hold ? 0 : (b.durMs || 0)), 0) || 1;
    let t = 0;
    const points: string[] = [];
    const height = 120;
    const width = 300;
    const toX = (ms: number) => (ms / total) * width;
    const toY = (amp: number) => height / 2 - (amp / CSFG_MAX_ABS_MA) * (height / 2 - 10);
    blocks.forEach((b) => {
      const dur = b.hold ? 0 : (b.durMs || 0);
      points.push(`${toX(t)},${toY(b.ampMa)}`);
      t += dur;
      points.push(`${toX(t)},${toY(b.ampMa)}`);
    });
    return points.join(" ");
  }, [blocks]);

  return (
    <SafeAreaView style={styles.safe} edges={['top','left','right','bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          ref={scrollRef}
          style={styles.screen}
          contentContainerStyle={styles.screenContent}
          keyboardShouldPersistTaps="handled"
        >
        <View style={styles.heroCard}>
          <View style={styles.heroTop}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>CS Function Generator</Text>
              <View style={styles.subtitleRow}>
                <View style={[styles.dot, { backgroundColor: strengthColor(strength) }]} />
                <Text style={styles.subtitle}>{device.name}</Text>
              </View>
            </View>
            <View style={styles.infoPill}>
              <Text style={styles.infoPillText}>Gen {info.gen}</Text>
            </View>
          </View>
          <View style={styles.heroControls}>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Output</Text>
              <Switch value={switchOn} onValueChange={toggleSwitch} />
            </View>
            <TouchableOpacity style={styles.primaryButton} onPress={sendPattern} disabled={loading}>
              <Text style={styles.primaryButtonText}>Commit Pattern</Text>
              {loading ? <ActivityIndicator size="small" style={{ marginLeft: 8 }} /> : null}
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryButton} onPress={clearPattern} disabled={loading}>
              <Text style={styles.secondaryButtonText}>Clear Device Pattern</Text>
            </TouchableOpacity>
          </View>
        </View>

        {err ? (
          <View style={styles.errorCard}><Text style={styles.errorText}>{err}</Text></View>
        ) : null}

        <View style={styles.previewCard}>
          <Text style={styles.sectionTitle}>Pattern Preview</Text>
          <View style={styles.previewWrap}>
            <Svg width={300} height={120}>
              <Line x1={0} y1={60} x2={300} y2={60} stroke="#e5e7eb" strokeWidth={1} />
              <Polyline points={previewPoints} fill="none" stroke="#111827" strokeWidth={2} />
            </Svg>
          </View>
          <Text style={styles.previewNote}>
            Blocks: {blocks.length} • Device count: {info.count}/{info.max}
          </Text>
        </View>

        <View style={styles.blocksHeader}>
          <Text style={styles.sectionTitle}>Pattern Blocks</Text>
          <TouchableOpacity style={styles.addButton} onPress={addBlock}>
            <Text style={styles.addButtonText}>Add Block</Text>
          </TouchableOpacity>
        </View>

        {blocks.map((b, idx) => (
          <View
            key={`blk-${idx}`}
            style={styles.blockCard}
            onLayout={(e) => onBlockLayout(idx, e.nativeEvent.layout.y)}
          >
            <View style={styles.blockHeader}>
              <Text style={styles.blockTitle}>Block {idx + 1}</Text>
              <TouchableOpacity onPress={() => removeBlock(idx)} disabled={blocks.length <= 1}>
                <Text style={[styles.removeText, blocks.length <= 1 && { opacity: 0.4 }]}>Remove</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.blockRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.inputLabel}>Amplitude (mA)</Text>
                <View style={styles.inputRow}>
                  <TextInput
                    value={b.ampText}
                    onChangeText={(v) => updateAmpText(idx, v)}
                    onBlur={() => normalizeAmp(idx)}
                    onFocus={() => scrollToBlock(idx)}
                    keyboardType={Platform.OS === "ios" ? "numbers-and-punctuation" : "numeric"}
                    inputMode="decimal"
                    style={[styles.input, styles.inputFlex]}
                  />
                  <TouchableOpacity style={styles.signButton} onPress={() => flipAmpSign(idx)}>
                    <Text style={styles.signButtonText}>{b.ampMa >= 0 ? "+/-" : "-/+"}</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.inputLabel}>Duration (ms)</Text>
                <TextInput
                  value={b.durText}
                  onChangeText={(v) => updateDurText(idx, v)}
                  onBlur={() => normalizeDur(idx)}
                  onFocus={() => scrollToBlock(idx)}
                  keyboardType="numeric"
                  style={styles.input}
                />
              </View>
            </View>
            <View style={styles.holdRow}>
              <Text style={styles.inputLabel}>Hold forever</Text>
              <Switch value={b.hold} onValueChange={(v) => updateHold(idx, v)} />
            </View>
          </View>
        ))}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const plugin: DevicePlugin = {
  key: "cs_fg",
  matches: (t) => t === "cs_fg",
  Popup,
};

export default plugin;

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#f6f7f8",
  },
  flex: {
    flex: 1,
  },
  screen: {
    flex: 1,
    padding: 16,
    backgroundColor: "#f6f7f8",
  },
  screenContent: {
    paddingBottom: 24,
  },
  heroCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e7eb",
    marginBottom: 12,
  },
  heroTop: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "#111827",
  },
  subtitleRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 4,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  subtitle: {
    color: "#6b7280",
  },
  infoPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#f3f4f6",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  infoPillText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#111827",
  },
  heroControls: {
    gap: 8,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  switchLabel: {
    fontWeight: "600",
    color: "#111827",
  },
  primaryButton: {
    backgroundColor: "#111827",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
  },
  primaryButtonText: {
    color: "#ffffff",
    fontWeight: "700",
  },
  secondaryButton: {
    backgroundColor: "#f3f4f6",
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: "center",
  },
  secondaryButtonText: {
    color: "#111827",
    fontWeight: "600",
  },
  errorCard: {
    backgroundColor: "#fee2e2",
    borderRadius: 10,
    padding: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#fecaca",
    marginBottom: 8,
  },
  errorText: {
    color: "#b91c1c",
  },
  previewCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e7eb",
    marginBottom: 12,
  },
  previewWrap: {
    alignItems: "center",
    paddingVertical: 10,
  },
  previewNote: {
    color: "#6b7280",
    fontSize: 12,
    marginTop: 4,
  },
  sectionTitle: {
    fontWeight: "700",
    color: "#111827",
    marginBottom: 8,
  },
  blocksHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  addButton: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  addButtonText: {
    color: "#ffffff",
    fontWeight: "700",
  },
  blockCard: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5e7eb",
    marginBottom: 12,
  },
  blockHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  blockTitle: {
    fontWeight: "700",
    color: "#111827",
  },
  removeText: {
    color: "#ef4444",
    fontWeight: "600",
  },
  blockRow: {
    flexDirection: "row",
    gap: 10,
  },
  inputLabel: {
    color: "#6b7280",
    fontSize: 12,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#ffffff",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  inputFlex: {
    flex: 1,
  },
  signButton: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#f3f4f6",
  },
  signButtonText: {
    fontWeight: "700",
    color: "#111827",
    fontSize: 12,
  },
  holdRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
});
