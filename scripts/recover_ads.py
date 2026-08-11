#!/usr/bin/env python3
"""Recover ADS1299 records from raw packed .bin dump.

Input format (same as FILE notify payload stream):
  [type][len][payload]...
  type=0x01 len=27: ADS frame (status + 8ch*3B)
  type=0x02 len=16: time sync (u64 host_time_ms LE + u64 sample_index LE)

This script is for offline recovery from existing raw bin dump files.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import time
from pathlib import Path
from typing import Optional


ADS_FRAME_LEN = 27
ADS_CHANNELS = 8
ADS_DEFAULT_FS = 250.0


def int24be(b0: int, b1: int, b2: int) -> int:
    v = ((b0 & 0xFF) << 16) | ((b1 & 0xFF) << 8) | (b2 & 0xFF)
    return v - 0x1000000 if (v & 0x800000) else v


def u64le(buf: bytes, off: int) -> int:
    return int.from_bytes(buf[off : off + 8], "little", signed=False)


def parse_records(data: bytes):
    off = 0
    n = len(data)
    while off + 2 <= n:
        t = data[off]
        ln = data[off + 1]
        end = off + 2 + ln
        if end > n:
            break
        yield t, ln, data[off + 2 : end], off
        off = end
    return off


def first_pass(buf: bytes):
    frames = 0
    anchors: list[dict] = []
    parsed_bytes = 0
    for t, ln, payload, off in parse_records(buf):
        parsed_bytes = off + 2 + ln
        if t == 0x01 and ln >= ADS_FRAME_LEN:
            frames += 1
        elif t == 0x02 and ln >= 16:
            anchors.append(
                {
                    "host_ms": u64le(payload, 0),
                    "sample_idx": u64le(payload, 8),
                }
            )
    return frames, anchors, parsed_bytes


def find_anchor_before(sample_idx: int, anchors: list[dict]) -> Optional[dict]:
    # anchors are usually monotonic sample_idx in firmware.
    best = None
    for a in anchors:
        if int(a["sample_idx"]) <= sample_idx:
            best = a
        else:
            break
    return best


def estimate_host_ms(sample_idx: int, anchors: list[dict], sample_period_ms: float) -> Optional[float]:
    if not anchors:
        return None
    a = find_anchor_before(sample_idx, anchors)
    if a is None:
        a = anchors[0]
    return float(a["host_ms"]) + (sample_idx - int(a["sample_idx"])) * sample_period_ms


def recover(
    in_bin: Path,
    out_dir: Path,
    hours: float,
    fs_hz: float,
    strict: bool,
) -> dict:
    if not in_bin.exists():
        raise FileNotFoundError(f"input not found: {in_bin}")
    out_dir.mkdir(parents=True, exist_ok=True)

    ts = time.strftime("%Y%m%d_%H%M%S")
    stem = in_bin.stem
    csv_path = out_dir / f"{stem}_recover_{ts}.csv"
    json_path = out_dir / f"{stem}_recover_{ts}.json"

    raw = in_bin.read_bytes()
    total_bytes = len(raw)
    total_frames, anchors, parsed_bytes = first_pass(raw)
    if strict and parsed_bytes != total_bytes:
        raise RuntimeError(f"truncated/invalid record stream near byte {parsed_bytes} / {total_bytes}")

    sample_period_ms = 1000.0 / fs_hz
    want_samples = max(1, int(hours * 3600.0 * fs_hz))
    start_idx = max(0, total_frames - want_samples)

    recovered = 0
    frame_idx = 0
    with csv_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["sample_idx", "offset_ms", "host_time_ms", "status", "ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "ch7", "ch8"])
        for t, ln, payload, _off in parse_records(raw):
            if t != 0x01 or ln < ADS_FRAME_LEN:
                continue
            if frame_idx < start_idx:
                frame_idx += 1
                continue
            status = ((payload[0] << 16) | (payload[1] << 8) | payload[2]) & 0xFFFFFF
            ch = [int24be(payload[3 + i * 3], payload[4 + i * 3], payload[5 + i * 3]) for i in range(ADS_CHANNELS)]
            out_idx = frame_idx - start_idx
            offset_ms = out_idx * sample_period_ms
            host_ms = estimate_host_ms(frame_idx, anchors, sample_period_ms)
            w.writerow(
                [
                    frame_idx,
                    f"{offset_ms:.3f}",
                    "" if host_ms is None else f"{host_ms:.3f}",
                    status,
                    *ch,
                ]
            )
            recovered += 1
            frame_idx += 1

    first_host = estimate_host_ms(start_idx, anchors, sample_period_ms) if recovered > 0 else None
    last_host = estimate_host_ms(start_idx + recovered - 1, anchors, sample_period_ms) if recovered > 0 else None
    meta = {
        "source_bin": str(in_bin),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "sample_rate_hz": fs_hz,
        "requested_hours": hours,
        "requested_samples": want_samples,
        "total_frames_in_bin": total_frames,
        "recovered_start_sample_idx": start_idx,
        "recovered_frames": recovered,
        "anchors_count": len(anchors),
        "anchors": anchors,
        "parsed_bytes": parsed_bytes,
        "input_bytes": total_bytes,
        "parse_complete": parsed_bytes == total_bytes,
        "estimated_start_host_time_ms": first_host,
        "estimated_end_host_time_ms": last_host,
        "estimated_duration_hours": (recovered / fs_hz) / 3600.0,
        "csv_path": str(csv_path),
    }
    json_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    meta["json_path"] = str(json_path)
    return meta


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Recover ADS1299 data from raw packed .bin")
    p.add_argument("--input-bin", required=True, help="Raw packed bin file")
    p.add_argument("--out-dir", default="./downloads", help="Output directory")
    p.add_argument("--hours", type=float, default=5.2, help="Recover last N hours (default: 5.2)")
    p.add_argument("--fs", type=float, default=ADS_DEFAULT_FS, help="Sample rate Hz (default: 250)")
    p.add_argument("--strict", action="store_true", help="Fail if trailing incomplete bytes exist")
    return p


def main() -> None:
    args = build_parser().parse_args()
    if not math.isfinite(args.hours) or args.hours <= 0:
        raise SystemExit("--hours must be > 0")
    if not math.isfinite(args.fs) or args.fs <= 0:
        raise SystemExit("--fs must be > 0")
    meta = recover(
        in_bin=Path(args.input_bin),
        out_dir=Path(args.out_dir),
        hours=float(args.hours),
        fs_hz=float(args.fs),
        strict=bool(args.strict),
    )
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
