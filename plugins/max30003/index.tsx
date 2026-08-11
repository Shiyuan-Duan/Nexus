import React from "react";
import type { DeviceIdentity } from "../../constants/devices";
import type { DevicePlugin } from "../registry";
import { ExgRecorderPopup, type ExgFileEvent, type ExgRecorderConfig } from "../_shared/exgRecorder";
import {
  MAX30003_CHAR_CTRL,
  MAX30003_CHAR_FILE,
  MAX30003_CHAR_META,
  MAX30003_CHAR_STREAM,
  MAX30003_CHAR_SWITCH,
  MAX30003_CMD_ABORT,
  MAX30003_CMD_DELETE,
  MAX30003_CMD_FORMAT,
  MAX30003_CMD_LIST,
  MAX30003_CMD_READ,
  MAX30003_CMD_RECOVER,
  MAX30003_CMD_REC_START,
  MAX30003_CMD_REC_STOP,
  MAX30003_CMD_STATUS,
  MAX30003_CMD_TIME_SYNC,
  MAX30003_SAMPLE_RATE,
  MAX30003_SERVICE_UUID,
  encodeCtrlName,
  encodeCtrlNoArg,
  encodeSwitch,
  encodeTimeSync,
  parseFilePackets,
  parseMetaPacket,
  parseStreamSamples,
} from "../../services/ble/profiles/max30003";

const config: ExgRecorderConfig = {
  key: "max30003",
  title: "ECG MAX30003",
  deviceType: "max30003",
  sampleRateHz: MAX30003_SAMPLE_RATE,
  channelCount: 1,
  defaultPrefix: "ecg",
  serviceUuid: MAX30003_SERVICE_UUID,
  switchChar: MAX30003_CHAR_SWITCH,
  ctrlChar: MAX30003_CHAR_CTRL,
  streamChar: MAX30003_CHAR_STREAM,
  fileChar: MAX30003_CHAR_FILE,
  metaChar: MAX30003_CHAR_META,
  commands: {
    recStart: MAX30003_CMD_REC_START,
    recStop: MAX30003_CMD_REC_STOP,
    list: MAX30003_CMD_LIST,
    read: MAX30003_CMD_READ,
    del: MAX30003_CMD_DELETE,
    format: MAX30003_CMD_FORMAT,
    abort: MAX30003_CMD_ABORT,
    status: MAX30003_CMD_STATUS,
    timeSync: MAX30003_CMD_TIME_SYNC,
    recover: MAX30003_CMD_RECOVER,
  },
  encodeSwitch,
  encodeNoArg: encodeCtrlNoArg,
  encodeName: encodeCtrlName,
  encodeTimeSync,
  parseMeta: parseMetaPacket,
  parseStream: (data: Uint8Array) => parseStreamSamples(data).map((v) => [v]),
  parseFile: (data: Uint8Array): ExgFileEvent[] => {
    const out: ExgFileEvent[] = [];
    for (const pkt of parseFilePackets(data)) {
      if (pkt.kind === "time_sync") {
        out.push({ kind: "time_sync", hostTimeMs: pkt.hostTimeMs, sampleIndex: pkt.sampleIndex });
      } else if (pkt.kind === "frame") {
        out.push({ kind: "sample", sample: 0, values: [pkt.sample] });
      }
    }
    return out;
  },
};

const Popup: React.FC<{ device: DeviceIdentity }> = ({ device }) => <ExgRecorderPopup device={device} config={config} />;

const plugin: DevicePlugin = {
  key: "max30003",
  matches: (t) => t === "max30003" || t === "ecg-v1" || t === "emg-v1",
  Popup,
};

export default plugin;
