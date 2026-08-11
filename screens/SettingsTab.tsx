import React, { useRef, useState } from "react";
import { View, Text, Switch, Alert, StyleSheet, Platform, TextInput, TouchableOpacity, Modal } from "react-native";
import { SafeAreaView } from 'react-native-safe-area-context';
import { appendImportRows, beginImportRecording, cancelImportRecording, finishImportRecording } from "../services/data/recorder";
import { MAX30003_SAMPLE_PERIOD_MS } from "../services/ble/profiles/max30003";

const DEFAULT_SIM_SAMPLES = "19270131";

function toCsvField(v: string | number | bigint | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return String(v);
}

export const SettingsTab: React.FC = () => {
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [simSamples, setSimSamples] = useState(DEFAULT_SIM_SAMPLES);
  const [simRunning, setSimRunning] = useState(false);
  const [simProgress, setSimProgress] = useState(0);
  const [simStepText, setSimStepText] = useState("");
  const [simName, setSimName] = useState("");
  const cancelRef = useRef(false);

  const triggerMaxReadSim = async () => {
    if (simRunning) return;
    const n = Number((simSamples || "").trim());
    if (!Number.isFinite(n) || n <= 0) {
      Alert.alert("Invalid sample count", "Please enter a positive integer sample count.");
      return;
    }
    const samples = Math.max(1, Math.floor(n));
    const startedAt = Date.now();
    const name = `sim_${samples}_${startedAt}`;
    setSimName(name);
    setSimRunning(true);
    setSimProgress(0);
    setSimStepText(`Step 1/3 Receiving simulated data... 0/${samples} samples`);
    cancelRef.current = false;

    let importId = "";
    try {
      importId = await beginImportRecording({
        deviceType: "max30003",
        deviceId: "sim:max30003",
        name: `${name}_nand`,
        startedAt,
        columns: ["t_ms", "time", "t_ms_device", "biov", "emg", "anchor_host_ms", "anchor_sample_idx"],
        eventNames: ["time_sync"],
      });

      const pendingRows: string[] = [];
      let frameCount = 0;
      let hpPrevX = 0;
      let hpPrevY = 0;
      let emgLp = 0;

      const batch = 4096;
      let i = 0;
      while (i < samples && !cancelRef.current) {
        const count = Math.min(batch, samples - i);
        for (let j = 0; j < count; j += 1) {
          const idx = i + j;
          const sample = (((idx % 2000) - 1000) * 3000) | 0;
          const tDeviceMs = frameCount * MAX30003_SAMPLE_PERIOD_MS;
          const tAbsMs = startedAt + tDeviceMs;
          const hpA = 0.8;
          const hp = hpA * (hpPrevY + sample - hpPrevX);
          hpPrevX = sample;
          hpPrevY = hp;
          const emgA = 0.15;
          emgLp = emgLp + emgA * (Math.abs(hp) - emgLp);
          pendingRows.push([
            toCsvField(tAbsMs),
            toCsvField(Math.trunc(tAbsMs)),
            toCsvField(tDeviceMs),
            toCsvField(sample),
            toCsvField(emgLp),
            "",
            "",
          ].join(","));
          frameCount += 1;
          if (pendingRows.length >= 4096) {
            const chunk = pendingRows.splice(0, pendingRows.length);
            await appendImportRows(importId, chunk);
          }
        }

        i += count;
        if ((i % 65536) === 0 || i >= samples) {
          const ratio = Math.max(0, Math.min(1, i / samples));
          setSimProgress((p) => Math.max(p, ratio * 0.78));
          setSimStepText(`Step 1/3 Receiving simulated data... ${i}/${samples} samples`);
        }
      }

      if (cancelRef.current) {
        await cancelImportRecording(importId);
        return;
      }

      setSimStepText("Step 2/3 Processing data...");
      setSimProgress((p) => Math.max(p, 0.82));
      if (pendingRows.length > 0) {
        const tail = pendingRows.splice(0, pendingRows.length);
        await appendImportRows(importId, tail);
      }

      if (cancelRef.current) {
        await cancelImportRecording(importId);
        return;
      }

      setSimStepText("Step 3/3 Importing to Data tab...");
      setSimProgress((p) => Math.max(p, 0.86));
      const id = await finishImportRecording(importId, {
        startedAt,
        endedAt: Date.now(),
        sampleCount: frameCount,
      });
      setSimProgress(1);
      setSimStepText("Done");
      Alert.alert("Simulation complete", `Imported to DataTab: ${id}`);
    } catch (e: any) {
      if (importId) {
        try { await cancelImportRecording(importId); } catch {}
      }
      Alert.alert("Simulation failed", e?.message ?? String(e));
    } finally {
      setTimeout(() => {
        setSimRunning(false);
        setSimProgress(0);
        setSimStepText("");
      }, 120);
    }
  };

  const requestCancelSim = () => {
    if (!simRunning) return;
    Alert.alert(
      "Cancel simulation?",
      "This will stop the current simulated download.",
      [
        { text: "No", style: "cancel" },
        { text: "Yes, Cancel", style: "destructive", onPress: () => { cancelRef.current = true; } },
      ]
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, padding: 12, backgroundColor: '#f6f7f8' }} edges={['top','left','right','bottom']}>
      <Text style={{ fontSize: 18, fontWeight: "600", marginBottom: 8 }}>Settings</Text>
      <View style={styles.card}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View>
            <Text style={{ fontWeight: '600', color: '#111827' }}>Debug Mode</Text>
            <Text style={{ color: '#6b7280', marginTop: 2 }}>Advanced developer features</Text>
          </View>
          <Switch
            value={debugEnabled}
            onValueChange={(v) => {
              if (v) {
                setDebugEnabled(true);
                setTimeout(() => {
                  setDebugEnabled(false);
                  Alert.alert('No Permission', 'You do not have permission to enable Debug.');
                }, 150);
              } else {
                setDebugEnabled(false);
              }
            }}
          />
        </View>
      </View>
      <View style={[styles.card, { marginTop: 12 }]}>
        <Text style={styles.sectionTitle}>MAX30003 Read Simulation</Text>
        <Text style={styles.sectionSub}>Simulate FILE notify stream without BLE transfer.</Text>
        <TextInput
          style={styles.input}
          value={simSamples}
          onChangeText={setSimSamples}
          keyboardType="number-pad"
          placeholder={DEFAULT_SIM_SAMPLES}
          placeholderTextColor="#9ca3af"
        />
        <TouchableOpacity style={styles.primaryBtn} onPress={() => { void triggerMaxReadSim(); }}>
          <Text style={styles.primaryBtnText}>Start Simulated Read</Text>
        </TouchableOpacity>
      </View>
      <Modal transparent visible={simRunning} animationType="fade" onRequestClose={requestCancelSim}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Simulating MAX30003 Read</Text>
            <Text style={styles.modalSub}>{simName || "-"}</Text>
            <Text style={styles.modalStep} numberOfLines={1}>{simStepText}</Text>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.max(2, Math.min(100, Math.round(simProgress * 100)))}%` }]} />
            </View>
            <Text style={styles.modalPct}>{Math.round(simProgress * 100)}%</Text>
            <TouchableOpacity style={styles.cancelBtn} onPress={requestCancelSim}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

export default SettingsTab;

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 8,
      },
      android: { elevation: 1 },
      default: {},
    }),
  },
  sectionTitle: {
    fontWeight: "700",
    color: "#111827",
    marginBottom: 4,
  },
  sectionSub: {
    color: "#6b7280",
    fontSize: 12,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: "#111827",
    marginBottom: 8,
  },
  primaryBtn: {
    backgroundColor: "#111827",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  primaryBtnText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 12,
  },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(17,24,39,0.36)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { width: "100%", maxWidth: 360, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#e5e7eb", padding: 14 },
  modalTitle: { fontSize: 16, fontWeight: "700", color: "#111827" },
  modalSub: { color: "#6b7280", fontSize: 12, marginTop: 2 },
  modalStep: { marginTop: 8, color: "#374151", fontSize: 12, minHeight: 16, fontVariant: ["tabular-nums"] },
  progressTrack: { marginTop: 10, height: 10, borderRadius: 999, backgroundColor: "#e5e7eb", overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: "#2563eb" },
  modalPct: { marginTop: 8, color: "#111827", fontWeight: "700", fontVariant: ["tabular-nums"] },
  cancelBtn: { marginTop: 12, alignSelf: "flex-end", paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: "#fecaca", backgroundColor: "#fef2f2" },
  cancelBtnText: { color: "#b91c1c", fontWeight: "700", fontSize: 12 },
});
