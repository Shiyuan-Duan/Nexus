// Simple packager that groups incoming samples by device and session id.

import { onSample, type Sample } from "./dataBus";

export type Dataset = {
  id: string;
  deviceId: string;
  kind?: string;
  startedAt: number;
  count: number;
};

const datasets: Record<string, Dataset> = {};

function datasetKey(deviceId: string, kind?: string) {
  return `${deviceId}:${kind ?? "default"}`;
}

export function start() {
  // idempotent; no-op if already subscribed
  if ((start as any)._sub) return;
  (start as any)._sub = onSample(handleSample);
}

function handleSample(s: Sample) {
  const key = datasetKey(s.deviceId, s.kind);
  let ds = datasets[key];
  if (!ds) {
    ds = { id: key, deviceId: s.deviceId, kind: s.kind, startedAt: Date.now(), count: 0 };
    datasets[key] = ds;
  }
  ds.count += 1;
}

export function listDatasets(): Dataset[] {
  return Object.values(datasets);
}

export function getDataset(id: string): Dataset | undefined {
  return datasets[id];
}

