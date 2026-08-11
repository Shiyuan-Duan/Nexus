import React from "react";
import type { DeviceIdentity } from "../../constants/devices";
import type { DevicePlugin } from "../registry";
import { ExgRecorderPopup, type ExgFileEvent, type ExgRecorderConfig } from "../_shared/exgRecorder";
import {
  ADS1299_CHANNELS,
  ADS1299_CHAR_CTRL,
  ADS1299_CHAR_DEBUG,
  ADS1299_CHAR_FILE,
  ADS1299_CHAR_META,
  ADS1299_CHAR_STREAM,
  ADS1299_CHAR_SWITCH,
  ADS1299_CMD_ABORT,
  ADS1299_CMD_DELETE,
  ADS1299_CMD_FORMAT,
  ADS1299_CMD_LIST,
  ADS1299_CMD_READ,
  ADS1299_CMD_RECOVER,
  ADS1299_CMD_REC_START,
  ADS1299_CMD_REC_STOP,
  ADS1299_CMD_STATUS,
  ADS1299_CMD_TIME_SYNC,
  ADS1299_SERVICE_UUID,
  encodeCtrlName,
  encodeCtrlNoArg,
  encodeSwitch,
  encodeTimeSync,
  parseAds1299StreamChunk,
  parseDebugText,
  parseFilePackets,
  parseMetaPacket,
} from "../../services/ble/profiles/ads1299";

const config: ExgRecorderConfig = {
  key: "ads1299",
  title: "EEG ADS1299",
  deviceType: "ads1299",
  sampleRateHz: 250,
  channelCount: ADS1299_CHANNELS,
  defaultPrefix: "eeg",
  serviceUuid: ADS1299_SERVICE_UUID,
  switchChar: ADS1299_CHAR_SWITCH,
  ctrlChar: ADS1299_CHAR_CTRL,
  streamChar: ADS1299_CHAR_STREAM,
  fileChar: ADS1299_CHAR_FILE,
  metaChar: ADS1299_CHAR_META,
  debugChar: ADS1299_CHAR_DEBUG,
  commands: {
    recStart: ADS1299_CMD_REC_START,
    recStop: ADS1299_CMD_REC_STOP,
    list: ADS1299_CMD_LIST,
    read: ADS1299_CMD_READ,
    del: ADS1299_CMD_DELETE,
    format: ADS1299_CMD_FORMAT,
    abort: ADS1299_CMD_ABORT,
    status: ADS1299_CMD_STATUS,
    timeSync: ADS1299_CMD_TIME_SYNC,
    recover: ADS1299_CMD_RECOVER,
  },
  encodeSwitch,
  encodeNoArg: encodeCtrlNoArg,
  encodeName: encodeCtrlName,
  encodeTimeSync,
  parseMeta: parseMetaPacket,
  parseStream: parseAds1299StreamChunk,
  parseDebug: parseDebugText,
  parseFile: (data: Uint8Array): ExgFileEvent[] => {
    const out: ExgFileEvent[] = [];
    for (const pkt of parseFilePackets(data)) {
      if (pkt.kind === "time_sync" && pkt.timeSync) {
        out.push({ kind: "time_sync", hostTimeMs: pkt.timeSync.hostTimeMs, sampleIndex: pkt.timeSync.sampleIndex });
      } else if (pkt.kind === "frame" && pkt.frame) {
        out.push({ kind: "sample", sample: 0, status: pkt.frame.status, values: pkt.frame.channels });
      }
    }
    return out;
  },
};

const Popup: React.FC<{ device: DeviceIdentity }> = ({ device }) => <ExgRecorderPopup device={device} config={config} />;

const plugin: DevicePlugin = {
  key: "ads1299",
  matches: (t) => t === "ads1299" || t === "eeg-v1",
  Popup,
};

export default plugin;
