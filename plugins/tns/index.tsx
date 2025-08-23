import React, { useCallback, useEffect, useState } from "react";
import { Text, View, Button, ActivityIndicator, Switch } from "react-native";
import type { DeviceIdentity } from "../../constants/devices";
import type { DevicePlugin } from "../registry";
import { getBleManager } from "../../services/ble/bleManager";
import { read, write } from "../../services/ble/bleClient";
import {
  TNS_SERVICE_UUID,
  TNS_CHAR_SWITCH,
  TNS_CHAR_AMPLITUDE,
  TNS_CHAR_RESERVED,
} from "../../services/ble/profiles/tns";
import CircularDial from "../../components/CircularDial";

const Popup: React.FC<{ device: DeviceIdentity }> = ({ device }) => {
  const manager = getBleManager();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [switchByte, setSwitchByte] = useState<number | null>(null);
  const [ampByte, setAmpByte] = useState<number | null>(null);
  const [reservedBytes, setReservedBytes] = useState<Uint8Array | null>(null);
  const [availableServices, setAvailableServices] = useState<string[]>([]);
  const [writingSwitch, setWritingSwitch] = useState(false);
  const [writingAmp, setWritingAmp] = useState(false);

  const toHex = (u8: Uint8Array | null) => {
    if (!u8 || u8.length === 0) return "";
    return Array.from(u8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
  };

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
          setAvailableServices(list);
          const want = String(TNS_SERVICE_UUID).toLowerCase();
          const has = list.includes(want);
          if (!has) {
            throw new Error(`Service ${want} not found on device. Found: ${list.join(', ') || 'none'}`);
          }
        } catch {}
      }

      const sw = await read(device.id, TNS_SERVICE_UUID, TNS_CHAR_SWITCH, manager);
      setSwitchByte(sw.length > 0 ? sw[0] : null);

      const amp = await read(device.id, TNS_SERVICE_UUID, TNS_CHAR_AMPLITUDE, manager);
      const a = amp.length > 0 ? amp[0] : null;
      setAmpByte(typeof a === 'number' ? Math.max(0, Math.min(100, a)) : a);

      const res = await read(device.id, TNS_SERVICE_UUID, TNS_CHAR_RESERVED, manager);
      // Expecting 4 bytes; store as-is
      setReservedBytes(res.length >= 4 ? res.slice(0, 4) : res);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
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
      setWritingSwitch(true);
      setErr(null);
      try {
        const value = new Uint8Array([on ? 1 : 0]);
        await write(device.id, TNS_SERVICE_UUID, TNS_CHAR_SWITCH, value, manager);
      } catch (e: any) {
        setErr(e?.message ?? String(e));
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
      const clamped = Math.max(0, Math.min(100, Math.round(amp)));
      setWritingAmp(true);
      setErr(null);
      try {
        const value = new Uint8Array([clamped & 0xff]);
        await write(device.id, TNS_SERVICE_UUID, TNS_CHAR_AMPLITUDE, value, manager);
      } catch (e: any) {
        setErr(e?.message ?? String(e));
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

  const amplitudeToVoltage = (a: number | null): number => {
    const pct = Math.max(0, Math.min(100, a ?? 0));
    return (pct * 20) / 100; // 0..20 V
  };

  return (
    <View style={{ padding: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: "600", marginBottom: 8 }}>TNS Device</Text>
      <Text style={{ marginBottom: 12, color: "#6b7280" }}>Device: {device.name}</Text>

      <View style={{ marginBottom: 12, flexDirection: "row", alignItems: "center" }}>
        <Button title="Refresh" onPress={readAll} />
        {loading && <ActivityIndicator size="small" style={{ marginLeft: 8 }} />}
      </View>

      {err ? (
        <Text style={{ color: "#ef4444", marginBottom: 12 }}>Error: {err}</Text>
      ) : null}
      {availableServices.length > 0 && (
        <Text style={{ color: "#6b7280", marginBottom: 12 }}>
          Services: {availableServices.join(", ")}
        </Text>
      )}

      <View style={{ gap: 16 }}>
        <View style={{ padding: 12, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ fontWeight: "600" }}>Switch</Text>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              {writingSwitch ? <ActivityIndicator size="small" style={{ marginRight: 8 }} /> : null}
              <Switch
                value={!!(switchByte && switchByte !== 0)}
                onValueChange={(v) => {
                  // Optimistically update local value; device truth will be restored after read-back
                  setSwitchByte(v ? 1 : 0);
                  writeSwitch(v);
                }}
              />
            </View>
          </View>
          <Text style={{ color: "#6b7280", marginTop: 6 }}>Raw: {switchByte === null ? "?" : `${switchByte}`}</Text>
        </View>

        <View style={{ padding: 12, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8, alignItems: "center" }}>
          <Text style={{ fontWeight: "600", marginBottom: 8 }}>Amplitude</Text>
          <CircularDial
            value={Math.max(0, Math.min(100, ampByte ?? 0))}
            onChange={(v) => setAmpByte(Math.max(0, Math.min(100, Math.round(v))))}
            onComplete={(v) => writeAmp(v)}
            size={220}
            stroke={18}
            progressColor="#16a34a"
            handleColor="#16a34a"
            disabled={loading || writingAmp}
          >
            <View style={{ alignItems: "center" }}>
              {writingAmp ? <ActivityIndicator size="small" /> : null}
              <Text style={{ fontSize: 28, fontWeight: "700" }}>
                {amplitudeToVoltage(ampByte).toFixed(2)} V
              </Text>
              <Text style={{ color: "#6b7280" }}>voltage</Text>
            </View>
          </CircularDial>
          <Text style={{ color: "#6b7280", marginTop: 6 }}>Raw: {ampByte === null ? "?" : `${ampByte}`}</Text>
        </View>

        <View style={{ padding: 12, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8 }}>
          <Text style={{ fontWeight: "600", marginBottom: 6 }}>Reserved</Text>
          <Text style={{ color: "#6b7280" }}>4 bytes (read-only)</Text>
          <Text style={{ marginTop: 4 }}>Value: {reservedBytes ? toHex(reservedBytes) : "?"}</Text>
        </View>
      </View>
    </View>
  );
};

const plugin: DevicePlugin = {
  key: "tns",
  matches: (t) => t === "tns",
  Popup,
};

export default plugin;
