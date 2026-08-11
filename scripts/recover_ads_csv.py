#!/usr/bin/env python3
"""One-click ADS1299 recover to CSV (directly from device).

It wraps:
  1) ble_nexus_download.py recover
  2) optional recover_ads.py --hours N
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def run_cmd(cmd: list[str]) -> None:
    p = subprocess.run(cmd)
    if p.returncode != 0:
        raise SystemExit(p.returncode)


def newest_new_file(before: set[Path], after: set[Path]) -> Path:
    new_files = [p for p in after if p not in before]
    if not new_files:
        raise RuntimeError("No new json output found after recover")
    new_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return new_files[0]


def main() -> None:
    ap = argparse.ArgumentParser(description="One-click recover ADS1299 data from device to CSV")
    ap.add_argument("--name", default="NIEEG-ADS1299-Demo1", help="BLE device name")
    ap.add_argument("--address", default=None, help="BLE address/UUID (optional)")
    ap.add_argument("--out-dir", default="./downloads", help="Output directory")
    ap.add_argument("--hours", type=float, default=None, help="Only keep last N hours (optional)")
    ap.add_argument("--fs", type=float, default=250.0, help="Sampling rate for trimming (default 250)")
    ap.add_argument("--keep-bin", action="store_true", help="Keep recovered bin file")
    ap.add_argument("--verbose", action="store_true", help="Verbose BLE meta logs")
    args = ap.parse_args()

    root = Path(__file__).resolve().parent
    ble_py = root / "ble_nexus_download.py"
    recover_py = root / "recover_ads.py"
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    before_json = set(out_dir.glob("*.json"))

    cmd = [sys.executable, str(ble_py), "--type", "ads1299"]
    if args.address:
        cmd += ["--address", args.address]
    else:
        cmd += ["--name", args.name]
    if args.verbose:
        cmd += ["--verbose"]
    cmd += ["recover", "--out-dir", str(out_dir)]

    print("[STEP 1/2] Recovering raw records from device...", flush=True)
    run_cmd(cmd)

    after_json = set(out_dir.glob("*.json"))
    meta_json = newest_new_file(before_json, after_json)
    meta = json.loads(meta_json.read_text(encoding="utf-8"))
    src_csv = Path(meta["csv_path"])
    src_bin = Path(meta["bin_path"])
    final_csv = src_csv

    if args.hours is not None and args.hours > 0:
        print(f"[STEP 2/2] Trimming to last {args.hours} hours...", flush=True)
        before_trim_json = set(out_dir.glob("*_recover_*.json"))
        cmd2 = [
            sys.executable,
            str(recover_py),
            "--input-bin",
            str(src_bin),
            "--hours",
            str(args.hours),
            "--fs",
            str(args.fs),
            "--out-dir",
            str(out_dir),
        ]
        run_cmd(cmd2)
        after_trim_json = set(out_dir.glob("*_recover_*.json"))
        trim_json = newest_new_file(before_trim_json, after_trim_json)
        trim_meta = json.loads(trim_json.read_text(encoding="utf-8"))
        final_csv = Path(trim_meta["csv_path"])

    if not args.keep_bin and src_bin.exists():
        src_bin.unlink(missing_ok=True)

    print(f"[DONE] CSV: {final_csv}", flush=True)


if __name__ == "__main__":
    main()
