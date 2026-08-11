import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Polyline } from "react-native-svg";
import type { DeviceIdentity } from "../../constants/devices";
import { getBleManager } from "../../services/ble/bleManager";
import { monitor, write } from "../../services/ble/bleClient";
import { appendImportRows, beginImportRecording, cancelImportRecording, finishImportRecording } from "../../services/data/recorder";
import { getStrength, setScanSuppressed, stopScan, subscribe as subscribeDevices } from "../../state/devices.store";

const MAX_POINTS = 240;
const FLUSH_ROWS = 512;
const STATUS_POLL_MS = 2000;
const START_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 20000;

export type ExgListEntry = {
  name: string;
  sampleCount: bigint;
  pageCount: number;
};

export type ExgStatus = {
  streamActive: boolean;
  recordingActive: boolean;
  activeName: string;
  sampleCount: bigint;
  debug?: {
    acceptWrites?: boolean;
    nextPage?: number;
    queuedPages?: number;
    droppedRecords?: bigint;
    nandStateText?: string;
    nandLastErr?: number;
  };
};

export type ExgAck = {
  cmd: number;
  status: number;
  nandReady?: boolean;
  rcRaw?: number;
};

export type ExgMetaPacket = {
  kind: string;
  text: string;
  entry?: ExgListEntry;
  status?: ExgStatus;
  ack?: ExgAck;
};

export type ExgFileEvent =
  | { kind: "sample"; sample: number; values: number[]; status?: number }
  | { kind: "time_sync"; hostTimeMs: bigint; sampleIndex: bigint };

export type ExgRecorderConfig = {
  key: string;
  title: string;
  deviceType: string;
  sampleRateHz: number;
  channelCount: number;
  defaultPrefix: string;
  serviceUuid: string;
  switchChar: string;
  ctrlChar: string;
  streamChar: string;
  fileChar: string;
  metaChar: string;
  debugChar?: string;
  commands: {
    recStart: number;
    recStop: number;
    list: number;
    read: number;
    del: number;
    format: number;
    abort: number;
    status: number;
    timeSync: number;
    recover: number;
  };
  encodeSwitch(on: boolean): Uint8Array;
  encodeNoArg(cmd: number): Uint8Array;
  encodeName(cmd: number, name: string): Uint8Array;
  encodeTimeSync(hostTimeMs: bigint, sampleIndex: bigint): Uint8Array;
  parseMeta(data: Uint8Array): ExgMetaPacket;
  parseStream(data: Uint8Array): number[][];
  parseFile(data: Uint8Array): ExgFileEvent[];
  parseDebug?: (data: Uint8Array) => string;
};

type DownloadState = {
  active: boolean;
  fileName: string;
  importId: string;
  expected: number;
  rows: string[];
  samples: number;
  anchors: { sampleIndex: bigint; hostTimeMs: bigint }[];
  startedAt: number;
};

function fmt2(n: number): string {
  return String(n).padStart(2, "0");
}

function makeDefaultName(prefix: string): string {
  const d = new Date();
  return `${prefix}_${d.getFullYear()}-${fmt2(d.getMonth() + 1)}-${fmt2(d.getDate())}_${fmt2(d.getHours())}-${fmt2(d.getMinutes())}-${fmt2(d.getSeconds())}`;
}

function csv(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return String(v);
}

function parseStartMs(name: string, prefix: string): number | null {
  const m = new RegExp(`^${prefix}_(\\d{4})-(\\d{2})-(\\d{2})_(\\d{2})-(\\d{2})-(\\d{2})$`).exec(name);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), 0).getTime();
  return Number.isFinite(t) ? t : null;
}

function errText(ack: ExgAck, label: string): string {
  if (ack.status === 0) return "";
  if (ack.status === 2) return `${label} failed: file not found`;
  if (ack.status === 11) return `${label} failed: device busy initializing`;
  if (ack.status === 16) return `${label} failed: recording already active`;
  if (ack.status === 17) return `${label} failed: file already exists`;
  if (ack.status === 19) return `${label} failed: NAND not ready`;
  if (ack.status === 22) return `${label} failed: invalid argument`;
  if (ack.status === 28) return `${label} failed: storage full`;
  if (ack.status === 117) return `${label} failed: metadata/checksum error; format or recover required`;
  return `${label} failed: status=${ack.status} rc=${ack.rcRaw ?? "?"}`;
}

function strengthColor(s?: string): string {
  if (s === "strong") return "#16a34a";
  if (s === "medium" || s === "weak") return "#d97706";
  if (s === "disconnected") return "#dc2626";
  return "#6b7280";
}

function Graph({ points }: { points: number[] }) {
  const path = useMemo(() => {
    if (points.length < 2) return "";
    let min = Math.min(...points);
    let max = Math.max(...points);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    return points.map((v, i) => {
      const x = (i / Math.max(1, points.length - 1)) * 320;
      const y = 92 - ((v - min) / (max - min)) * 84;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }, [points]);

  return (
    <View style={styles.graph}>
      <Svg width="100%" height="100%" viewBox="0 0 320 100">
        <Polyline points={path} fill="none" stroke="#2563eb" strokeWidth="1.8" />
      </Svg>
    </View>
  );
}

export function ExgRecorderPopup({ device, config }: { device: DeviceIdentity; config: ExgRecorderConfig }) {
  const manager = getBleManager();
  const [, setRev] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [name, setName] = useState(() => makeDefaultName(config.defaultPrefix));
  const [channel, setChannel] = useState(0);
  const [points, setPoints] = useState<number[]>([]);
  const [status, setStatus] = useState<ExgStatus | null>(null);
  const [entries, setEntries] = useState<ExgListEntry[]>([]);
  const [selected, setSelected] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [downloadText, setDownloadText] = useState("");
  const [downloadActive, setDownloadActive] = useState(false);
  const [downloadSamples, setDownloadSamples] = useState(0);
  const channelRef = useRef(channel);
  const writeChain = useRef(Promise.resolve());
  const pendingAcks = useRef(new Map<number, (ack: ExgAck) => void>());
  const commandBusy = useRef(false);
  const statusRef = useRef<ExgStatus | null>(null);
  const downloadRef = useRef<DownloadState>({
    active: false,
    fileName: "",
    importId: "",
    expected: 0,
    rows: [],
    samples: 0,
    anchors: [],
    startedAt: 0,
  });

  useEffect(() => { channelRef.current = channel; }, [channel]);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => subscribeDevices(() => setRev((v) => v + 1)), []);

  useEffect(() => {
    setScanSuppressed(true);
    stopScan();
    const t = setInterval(stopScan, 500);
    return () => {
      clearInterval(t);
      setScanSuppressed(false);
    };
  }, []);

  const strength = getStrength(device.id);

  const pushLog = useCallback((line: string) => {
    setLog((prev) => [`${new Date().toLocaleTimeString()} ${line}`, ...prev].slice(0, 60));
  }, []);

  const discover = useCallback(async () => {
    if (!manager) throw new Error("BLE manager unavailable");
    const m = manager as any;
    if (typeof m.isDeviceConnected === "function" && !(await m.isDeviceConnected(device.id))) {
      await m.connectToDevice(device.id);
    }
    if (typeof m.discoverAllServicesAndCharacteristicsForDevice === "function") {
      await m.discoverAllServicesAndCharacteristicsForDevice(device.id);
    }
  }, [device.id, manager]);

  const rawWrite = useCallback((payload: Uint8Array) => {
    const run = writeChain.current.then(async () => {
      if (!manager) throw new Error("BLE manager unavailable");
      await discover();
      await write(device.id, config.serviceUuid, config.ctrlChar, payload, manager);
    });
    writeChain.current = run.catch(() => {});
    return run;
  }, [config.ctrlChar, config.serviceUuid, device.id, discover, manager]);

  const writeAndWait = useCallback(async (cmd: number, payload: Uint8Array, label: string, timeoutMs: number) => {
    if (commandBusy.current) throw new Error("Another command is still running");
    setBusy(label);
    setError("");
    commandBusy.current = true;
    try {
      const ackPromise = new Promise<ExgAck>((resolve, reject) => {
        const t = setTimeout(() => {
          pendingAcks.current.delete(cmd);
          reject(new Error(`${label} timeout`));
        }, timeoutMs);
        pendingAcks.current.set(cmd, (ack) => {
          clearTimeout(t);
          resolve(ack);
        });
      });
      await rawWrite(payload);
      const ack = await ackPromise;
      if (ack.status !== 0) throw new Error(errText(ack, label));
      return ack;
    } finally {
      commandBusy.current = false;
      setBusy("");
    }
  }, [rawWrite]);

  const requestStatus = useCallback(async () => {
    if (!manager) return;
    if (commandBusy.current) return;
    if (downloadRef.current.active) return;
    try {
      await rawWrite(config.encodeNoArg(config.commands.status));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [config, manager, rawWrite]);

  const flushDownloadRows = useCallback(async (force: boolean) => {
    const d = downloadRef.current;
    if (!d.importId || d.rows.length === 0) return;
    while (d.rows.length >= FLUSH_ROWS || (force && d.rows.length > 0)) {
      const rows = d.rows.splice(0, force ? d.rows.length : FLUSH_ROWS);
      await appendImportRows(d.importId, rows);
    }
  }, []);

  const finishDownload = useCallback(async () => {
    const d = downloadRef.current;
    if (!d.active) return;
    d.active = false;
    setDownloadActive(false);
    setDownloadText("Saving...");
    try {
      await flushDownloadRows(true);
      const id = await finishImportRecording(d.importId, {
        startedAt: d.startedAt || Date.now(),
        endedAt: Date.now(),
        sampleCount: d.samples,
      });
      setDownloadText(`Saved ${d.samples} samples to Data (${id})`);
      pushLog(`download complete: ${d.fileName}, ${d.samples} samples`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      if (d.importId) await cancelImportRecording(d.importId);
    }
  }, [flushDownloadRows, pushLog]);

  const failDownload = useCallback(async (message: string) => {
    const d = downloadRef.current;
    if (!d.active) return;
    d.active = false;
    setDownloadActive(false);
    setDownloadText("Download failed");
    setError(message);
    if (d.importId) {
      await cancelImportRecording(d.importId);
    }
  }, []);

  const handleFileData = useCallback((data: Uint8Array) => {
    const d = downloadRef.current;
    if (!d.active) return;
    const events = config.parseFile(data);
    const periodMs = 1000 / config.sampleRateHz;
    for (const ev of events) {
      if (ev.kind === "time_sync") {
        d.anchors.push({ sampleIndex: ev.sampleIndex, hostTimeMs: ev.hostTimeMs });
        if (Number(ev.sampleIndex) === 0) d.startedAt = Number(ev.hostTimeMs);
        continue;
      }
      const i = d.samples;
      const t = d.startedAt ? d.startedAt + i * periodMs : Date.now();
      d.rows.push([csv(Math.trunc(t)), csv(i), csv(ev.status), ...ev.values.map(csv)].join(","));
      d.samples += 1;
      if ((d.samples % 64) === 0) {
        setDownloadSamples(d.samples);
        setDownloadText(`Receiving ${d.fileName}: ${d.samples}/${d.expected || "?"}`);
      }
      if (d.rows.length >= FLUSH_ROWS) void flushDownloadRows(false);
    }
  }, [config, flushDownloadRows]);

  const handleMetaData = useCallback((data: Uint8Array) => {
    const m = config.parseMeta(data);
    if (m.kind === "status" && m.status) {
      setStatus(m.status);
      if ((m.status.debug?.droppedRecords ?? 0n) > 0n) {
        setError(`Device dropped ${m.status.debug!.droppedRecords!.toString()} records`);
      } else if (m.status.debug?.nandLastErr) {
        setError(`NAND error ${m.status.debug.nandLastErr}`);
      }
      if (m.status.recordingActive && !m.status.streamActive && manager) {
        void write(device.id, config.serviceUuid, config.switchChar, config.encodeSwitch(true), manager);
      }
      return;
    }
    if (m.kind === "list_entry" && m.entry) {
      setEntries((prev) => prev.some((e) => e.name === m.entry!.name) ? prev : [...prev, m.entry!]);
      return;
    }
    if (m.kind === "list_end") {
      pushLog("list complete");
      return;
    }
    if (m.kind === "read_end") {
      void finishDownload();
      return;
    }
    if (m.kind === "ack" && m.ack) {
      const cb = pendingAcks.current.get(m.ack.cmd);
      if (cb) {
        pendingAcks.current.delete(m.ack.cmd);
        cb(m.ack);
      }
      if (m.ack.status !== 0) {
        pushLog(m.text);
        if (m.ack.cmd === config.commands.read || m.ack.cmd === config.commands.recover) {
          void failDownload(errText(m.ack, m.ack.cmd === config.commands.recover ? "RECOVER" : "READ"));
        }
      }
    }
  }, [config, device.id, failDownload, finishDownload, manager, pushLog]);

  useEffect(() => {
    if (!manager) return;
    let streamSub: { unsubscribe(): void } | undefined;
    let fileSub: { unsubscribe(): void } | undefined;
	    let metaSub: { unsubscribe(): void } | undefined;
	    let debugSub: { unsubscribe(): void } | undefined;
	    let cancelled = false;
	    const onMonitorError = (e: unknown) => {
	      if (cancelled) return;
	      const msg = e instanceof Error ? e.message : String(e);
	      pushLog(`BLE monitor error: ${msg}`);
	      if (downloadRef.current.active) {
	        void failDownload(`BLE disconnected during download: ${msg}`);
	      } else {
	        setError(`BLE disconnected: ${msg}`);
	      }
	    };
	    const run = async () => {
	      try {
	        await discover();
	        if (cancelled) return;
	        streamSub = monitor(device.id, config.serviceUuid, config.streamChar, (data) => {
          const frames = config.parseStream(data);
          if (frames.length === 0) return;
          const ch = Math.max(0, Math.min(config.channelCount - 1, channelRef.current));
          setPoints((prev) => {
            const next = prev.concat(frames.map((f) => f[ch] ?? 0));
	            return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
	          });
	        }, manager, onMonitorError);
	        fileSub = monitor(device.id, config.serviceUuid, config.fileChar, handleFileData, manager, onMonitorError);
	        metaSub = monitor(device.id, config.serviceUuid, config.metaChar, handleMetaData, manager, onMonitorError);
	        if (config.debugChar && config.parseDebug) {
	          debugSub = monitor(device.id, config.serviceUuid, config.debugChar, (data) => pushLog(config.parseDebug!(data)), manager, onMonitorError);
	        }
        await requestStatus();
        await rawWrite(config.encodeNoArg(config.commands.list));
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    };
    void run();
    const poll = setInterval(requestStatus, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
      streamSub?.unsubscribe();
      fileSub?.unsubscribe();
      metaSub?.unsubscribe();
      debugSub?.unsubscribe();
    };
	  }, [config, device.id, discover, failDownload, handleFileData, handleMetaData, manager, pushLog, rawWrite, requestStatus]);

  const setStream = useCallback(async (on: boolean) => {
    if (!manager) return;
    if (commandBusy.current || downloadRef.current.active) return;
    if (!on && statusRef.current?.recordingActive) {
      Alert.alert("Recording active", "Stop recording before turning stream off.");
      return;
    }
    setBusy(on ? "stream on" : "stream off");
    try {
      await discover();
      await write(device.id, config.serviceUuid, config.switchChar, config.encodeSwitch(on), manager);
      await requestStatus();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy("");
    }
  }, [config, device.id, discover, manager, requestStatus]);

  const startRecording = useCallback(async () => {
    if (commandBusy.current || downloadRef.current.active) return;
    const file = name.trim() || makeDefaultName(config.defaultPrefix);
    if (statusRef.current?.recordingActive || statusRef.current?.streamActive) return;
    const hostTimeMs = BigInt(Date.now());
    await writeAndWait(config.commands.timeSync, config.encodeTimeSync(hostTimeMs, 0n), "TIME SYNC", 3000);
    await writeAndWait(config.commands.recStart, config.encodeName(config.commands.recStart, file), "REC START", START_TIMEOUT_MS);
    await requestStatus();
  }, [config, name, requestStatus, writeAndWait]);

  const stopRecording = useCallback(async () => {
    if (commandBusy.current || downloadRef.current.active) return;
    if (!statusRef.current?.recordingActive && !statusRef.current?.streamActive) return;
    await writeAndWait(config.commands.recStop, config.encodeNoArg(config.commands.recStop), "REC STOP", STOP_TIMEOUT_MS);
    await requestStatus();
    setEntries([]);
    await rawWrite(config.encodeNoArg(config.commands.list));
    setName(makeDefaultName(config.defaultPrefix));
  }, [config, rawWrite, requestStatus, writeAndWait]);

  const listFiles = useCallback(async () => {
    if (commandBusy.current || downloadRef.current.active) return;
    setEntries([]);
    setSelected("");
    await rawWrite(config.encodeNoArg(config.commands.list));
  }, [config, rawWrite]);

  const startDownload = useCallback(async (recover: boolean) => {
    if (commandBusy.current || downloadRef.current.active) return;
    let importId = "";
    try {
      const file = recover ? `recover_${Date.now()}` : selected;
      if (!recover && !file) {
        setError("Select a file first.");
        return;
      }
      const expected = recover ? 0 : Number(entries.find((e) => e.name === file)?.sampleCount ?? 0n);
      const columns = ["t_ms", "sample_index", "status"];
      for (let i = 0; i < config.channelCount; i += 1) columns.push(`ch${i + 1}`);
      importId = await beginImportRecording({
        deviceType: config.deviceType,
        deviceId: device.id,
        name: `${file}_nand`,
        startedAt: parseStartMs(file, config.defaultPrefix) ?? Date.now(),
        columns,
        eventNames: ["time_sync"],
      });
      downloadRef.current = {
        active: true,
        fileName: file,
        importId,
        expected,
        rows: [],
        samples: 0,
        anchors: [],
        startedAt: parseStartMs(file, config.defaultPrefix) ?? 0,
      };
      setDownloadActive(true);
      setDownloadSamples(0);
      setDownloadText(recover ? "Recovering raw NAND..." : `Receiving ${file}: 0/${expected || "?"}`);
      const cmd = recover ? config.commands.recover : config.commands.read;
      await rawWrite(recover ? config.encodeNoArg(cmd) : config.encodeName(cmd, file));
    } catch (e: any) {
      downloadRef.current.active = false;
      setDownloadActive(false);
      if (importId) await cancelImportRecording(importId);
      setError(e?.message ?? String(e));
    }
  }, [config, device.id, entries, rawWrite, selected]);

  const abortDownload = useCallback(async () => {
    if (commandBusy.current) return;
    const d = downloadRef.current;
    d.active = false;
    setDownloadActive(false);
    setDownloadText("Cancelled");
    if (d.importId) await cancelImportRecording(d.importId);
    try {
      await rawWrite(config.encodeNoArg(config.commands.abort));
    } catch {}
  }, [config, rawWrite]);

  const deleteSelected = useCallback(async () => {
    if (commandBusy.current || downloadRef.current.active) return;
    if (!selected) return;
    await writeAndWait(config.commands.del, config.encodeName(config.commands.del, selected), "DELETE", 5000);
    await listFiles();
  }, [config, listFiles, selected, writeAndWait]);

  const format = useCallback(() => {
    if (commandBusy.current || downloadRef.current.active) return;
    Alert.alert("Format device storage", "This clears the device file list and starts new recordings at the beginning of NAND.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Format",
        style: "destructive",
        onPress: () => {
          void (async () => {
            await writeAndWait(config.commands.format, config.encodeNoArg(config.commands.format), "FORMAT", 20000);
            setEntries([]);
            setSelected("");
            await requestStatus();
          })().catch((e: any) => setError(e?.message ?? String(e)));
        },
      },
    ]);
  }, [config, requestStatus, writeAndWait]);

  const rec = status?.recordingActive ?? false;
  const stream = status?.streamActive ?? false;
  const canStop = rec || stream;
  const nandReady = status?.debug?.nandStateText ? status.debug.nandStateText === "ready" : !!status;
  const ready = !!status && nandReady;
  const disabled = !!busy || downloadActive;

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>{config.title}</Text>
            <Text style={styles.sub}>{device.name || device.id}</Text>
          </View>
          <View style={[styles.dot, { backgroundColor: strengthColor(strength) }]} />
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {busy ? <Text style={styles.busy}>{busy}</Text> : null}

        <View style={styles.panel}>
          <View style={styles.row}>
            <Text style={styles.label}>Stream</Text>
            <Switch value={stream || rec} onValueChange={setStream} disabled={disabled || rec} />
          </View>
          <Graph points={points} />
          {config.channelCount > 1 ? (
            <View style={styles.channels}>
              {Array.from({ length: config.channelCount }).map((_, i) => (
                <TouchableOpacity key={i} style={[styles.chip, channel === i && styles.chipOn]} onPress={() => setChannel(i)}>
                  <Text style={[styles.chipText, channel === i && styles.chipTextOn]}>{i + 1}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
        </View>

        <View style={styles.panel}>
          <View style={styles.recHeader}>
            <Text style={styles.panelTitle}>Recording</Text>
            <Text style={[styles.recBadge, rec ? styles.recOn : styles.recOff]}>{rec ? "REC" : "IDLE"}</Text>
          </View>
          <TextInput style={styles.input} value={name} onChangeText={setName} editable={!rec && !disabled} placeholder="record name" />
          <View style={styles.buttons}>
            <Button label="Start" onPress={() => void startRecording().catch((e: any) => setError(e?.message ?? String(e)))} disabled={disabled || !ready || rec || stream} primary />
            <Button label="Stop" onPress={() => void stopRecording().catch((e: any) => setError(e?.message ?? String(e)))} disabled={disabled || !canStop} danger />
          </View>
          <Text style={styles.status}>
            file={status?.activeName || "-"} samples={status?.sampleCount?.toString() ?? "0"} nand={status?.debug?.nandStateText || (status?.debug ? "ready" : "-")}
          </Text>
        </View>

        <View style={styles.panel}>
          <View style={styles.recHeader}>
            <Text style={styles.panelTitle}>Files</Text>
            <Button label="List" onPress={() => void listFiles().catch((e: any) => setError(e?.message ?? String(e)))} disabled={disabled} />
          </View>
          {entries.length === 0 ? <Text style={styles.empty}>No files listed</Text> : entries.map((e) => (
            <TouchableOpacity key={e.name} style={[styles.file, selected === e.name && styles.fileOn]} onPress={() => setSelected(e.name)}>
              <Text style={styles.fileName}>{e.name}</Text>
              <Text style={styles.fileMeta}>{e.sampleCount.toString()} samples · {e.pageCount} pages</Text>
            </TouchableOpacity>
          ))}
          <View style={styles.buttons}>
            <Button label="Read" onPress={() => void startDownload(false)} disabled={disabled || !selected || rec} primary />
            <Button label="Recover" onPress={() => void startDownload(true)} disabled={disabled || rec} />
            <Button label="Delete" onPress={() => void deleteSelected().catch((e: any) => setError(e?.message ?? String(e)))} disabled={disabled || !selected || rec} />
            <Button label="Format" onPress={format} disabled={disabled || rec} danger />
          </View>
          {downloadText ? (
            <View style={styles.download}>
              <Text style={styles.downloadText}>{downloadText}{downloadActive ? ` · ${downloadSamples}` : ""}</Text>
              {downloadActive ? <Button label="Abort" onPress={() => void abortDownload()} danger /> : null}
            </View>
          ) : null}
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Log</Text>
          {log.slice(0, 12).map((l, i) => <Text key={`${i}-${l}`} style={styles.log}>{l}</Text>)}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Button({ label, onPress, disabled, primary, danger }: { label: string; onPress(): void; disabled?: boolean; primary?: boolean; danger?: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.button, primary && styles.buttonPrimary, danger && styles.buttonDanger, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.buttonText, (primary || danger) && styles.buttonTextInvert]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f8fafc" },
  content: { padding: 16, gap: 12 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 22, fontWeight: "800", color: "#0f172a" },
  sub: { marginTop: 2, color: "#64748b", fontSize: 12 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  panel: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 8, padding: 12, gap: 10 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { color: "#334155", fontWeight: "700" },
  graph: { height: 120, borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 6, overflow: "hidden", backgroundColor: "#f8fafc" },
  channels: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { minWidth: 34, height: 30, borderRadius: 6, borderWidth: 1, borderColor: "#cbd5e1", alignItems: "center", justifyContent: "center" },
  chipOn: { backgroundColor: "#2563eb", borderColor: "#2563eb" },
  chipText: { color: "#334155", fontWeight: "700" },
  chipTextOn: { color: "#fff" },
  panelTitle: { fontSize: 16, fontWeight: "800", color: "#0f172a" },
  recHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  recBadge: { overflow: "hidden", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, fontWeight: "800", fontSize: 12 },
  recOn: { backgroundColor: "#fee2e2", color: "#b91c1c" },
  recOff: { backgroundColor: "#e2e8f0", color: "#334155" },
  input: { height: 40, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 6, paddingHorizontal: 10, color: "#0f172a" },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 6, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: "#fff" },
  buttonPrimary: { backgroundColor: "#2563eb", borderColor: "#2563eb" },
  buttonDanger: { backgroundColor: "#dc2626", borderColor: "#dc2626" },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: "#0f172a", fontWeight: "800" },
  buttonTextInvert: { color: "#fff" },
  status: { color: "#475569", fontSize: 12 },
  file: { borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 6, padding: 10 },
  fileOn: { borderColor: "#2563eb", backgroundColor: "#eff6ff" },
  fileName: { color: "#0f172a", fontWeight: "800" },
  fileMeta: { color: "#64748b", fontSize: 12, marginTop: 2 },
  empty: { color: "#64748b" },
  download: { borderTopWidth: 1, borderTopColor: "#e2e8f0", paddingTop: 10, gap: 8 },
  downloadText: { color: "#0f172a", fontVariant: ["tabular-nums"] },
  error: { color: "#b91c1c", fontWeight: "700" },
  busy: { color: "#2563eb", fontWeight: "700" },
  log: { color: "#475569", fontSize: 11, fontVariant: ["tabular-nums"] },
});
