#!/usr/bin/env python3
"""Desktop BLE downloader for Nexus ADS1299 / MAX30003 recordings.

Requires:
  pip install bleak
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic


@dataclass(frozen=True)
class Profile:
    name: str
    service: str
    char_ctrl: str
    char_file: str
    char_meta: str
    cmd_list: int = 0x12
    cmd_read: int = 0x13
    cmd_status: int = 0x21
    cmd_recover: int = 0x30


ADS = Profile(
    name="ads1299",
    service="4f6a9b50-6d4a-4f26-8f6a-3a0b2c1b21a0",
    char_ctrl="4f6a9b52-6d4a-4f26-8f6a-3a0b2c1b21a0",
    char_file="4f6a9b54-6d4a-4f26-8f6a-3a0b2c1b21a0",
    char_meta="4f6a9b55-6d4a-4f26-8f6a-3a0b2c1b21a0",
)

MAX = Profile(
    name="max30003",
    service="a0a4d780-96be-4222-b41e-98ea76b0120c",
    char_ctrl="a0a4d783-96be-4222-b41e-98ea76b0120c",
    char_file="a0a4d784-96be-4222-b41e-98ea76b0120c",
    char_meta="a0a4d785-96be-4222-b41e-98ea76b0120c",
)

MAX30001 = Profile(
    name="max30001",
    service="a0a4d680-96be-4222-b41e-98ea76b0120c",
    # max30001 firmware is stream-only right now; no ctrl/file/meta for download.
    char_ctrl="",
    char_file="",
    char_meta="",
)


def int24be(b0: int, b1: int, b2: int) -> int:
    v = ((b0 & 0xFF) << 16) | ((b1 & 0xFF) << 8) | (b2 & 0xFF)
    return v - 0x1000000 if (v & 0x800000) else v


def u64le(buf: bytes, off: int) -> int:
    return int.from_bytes(buf[off : off + 8], "little", signed=False)


def u32le(buf: bytes, off: int) -> int:
    return int.from_bytes(buf[off : off + 4], "little", signed=False)


def i16le(buf: bytes, off: int) -> int:
    return int.from_bytes(buf[off : off + 2], "little", signed=True)


@dataclass
class ListEntry:
    name: str
    samples: int
    pages: int


class Session:
    def __init__(self, client: BleakClient, profile: Profile, verbose: bool = False):
        self.client = client
        self.profile = profile
        self.verbose = verbose
        self.meta_event = asyncio.Event()
        self.read_done = asyncio.Event()
        self.list_done = asyncio.Event()
        self.status_event = asyncio.Event()
        self.last_status: Optional[dict] = None
        self.last_ack: Optional[dict] = None
        self.list_entries: list[ListEntry] = []
        self._meta_handler: Optional[Callable[[bytes], None]] = None
        self._file_handler: Optional[Callable[[bytes], None]] = None

    def log(self, msg: str) -> None:
        if self.verbose:
            print(msg, flush=True)

    async def start(self) -> None:
        if not self.profile.char_meta or not self.profile.char_file:
            raise RuntimeError(
                f"profile '{self.profile.name}' has no FILE/META characteristics for list/read/recover"
            )
        await self.client.start_notify(self.profile.char_meta, self._on_meta)
        await self.client.start_notify(self.profile.char_file, self._on_file)

    async def stop(self) -> None:
        try:
            await self.client.stop_notify(self.profile.char_meta)
        except Exception:
            pass
        try:
            await self.client.stop_notify(self.profile.char_file)
        except Exception:
            pass

    async def write_ctrl(self, payload: bytes) -> None:
        # Firmware CTRL char is Write Without Response.
        await self.client.write_gatt_char(self.profile.char_ctrl, payload, response=False)

    def set_meta_handler(self, handler: Optional[Callable[[bytes], None]]) -> None:
        self._meta_handler = handler

    def set_file_handler(self, handler: Optional[Callable[[bytes], None]]) -> None:
        self._file_handler = handler

    def _on_file(self, _: BleakGATTCharacteristic, data: bytearray) -> None:
        b = bytes(data)
        if self._file_handler:
            self._file_handler(b)

    def _on_meta(self, _: BleakGATTCharacteristic, data: bytearray) -> None:
        b = bytes(data)
        if self._meta_handler:
            self._meta_handler(b)
        if not b:
            return
        t = b[0]
        if t == 0x01 and len(b) >= 14:
            nlen = b[1]
            name = b[2 : 2 + nlen].decode("ascii", errors="ignore")
            off = 2 + nlen
            if off + 12 <= len(b):
                e = ListEntry(name=name, samples=u64le(b, off), pages=u32le(b, off + 8))
                self.list_entries.append(e)
                self.log(f"[META] list: {e.name} samples={e.samples} pages={e.pages}")
            return
        if t == 0x02:
            self.log("[META] list done")
            self.list_done.set()
            return
        if t == 0x03:
            self.log("[META] read done")
            self.read_done.set()
            return
        if t == 0x10 and len(b) >= 12:
            stream = b[1] != 0
            rec = b[2] != 0
            nlen = b[3]
            name = b[4 : 4 + nlen].decode("ascii", errors="ignore")
            off = 4 + nlen
            sc = u64le(b, off) if off + 8 <= len(b) else 0
            self.last_status = {
                "stream_active": stream,
                "recording_active": rec,
                "active_name": name,
                "sample_count": sc,
            }
            self.log(f"[META] status: stream={int(stream)} rec={int(rec)} name={name or '-'} samples={sc}")
            self.status_event.set()
            return
        if t == 0xF0 and len(b) >= 3:
            cmd = b[1]
            st = b[2]
            out = {"cmd": cmd, "status": st}
            if len(b) >= 6:
                out["nand_ready"] = b[3] != 0
                out["rc"] = i16le(b, 4)
            self.last_ack = out
            self.log(f"[META] ack: {out}")
            return
        self.log(f"[META] raw: {b.hex(' ')}")


def parse_records(chunk: bytes, remain: bytearray):
    data = remain + bytearray(chunk)
    off = 0
    total = len(data)
    while off + 2 <= total:
        t = data[off]
        ln = data[off + 1]
        end = off + 2 + ln
        if end > total:
            break
        payload = bytes(data[off + 2 : end])
        yield t, ln, payload
        off = end
    del data[:off]
    remain.clear()
    remain.extend(data)


def render_progress(frames: int, expected_samples: Optional[int], bytes_rx: int, started: float, done: bool = False) -> None:
    elapsed = max(0.001, time.time() - started)
    sps = frames / elapsed
    mb = bytes_rx / 1e6
    if expected_samples and expected_samples > 0:
        ratio = min(1.0, frames / expected_samples)
        width = 32
        fill = int(ratio * width)
        bar = ("#" * fill) + ("-" * (width - fill))
        msg = f"\r[READ] [{bar}] {ratio*100:6.2f}%  {frames}/{expected_samples} samples  {sps:8.1f} sps  {mb:7.2f} MB"
    else:
        msg = f"\r[READ] {frames} samples  {sps:8.1f} sps  {mb:7.2f} MB"
    sys.stdout.write(msg)
    if done:
        sys.stdout.write("\n")
    sys.stdout.flush()


async def discover_address(name: Optional[str], address: Optional[str], service_uuid: str, timeout: float) -> str:
    if address:
        return address
    if not name:
        raise ValueError("Provide --name or --address")
    devices = await BleakScanner.discover(timeout=timeout, return_adv=True)
    for d, adv in devices.values():
        if d.name and name.lower() in d.name.lower():
            if service_uuid.lower() in [u.lower() for u in (adv.service_uuids or [])]:
                return d.address
    for d, _adv in devices.values():
        if d.name and name.lower() in d.name.lower():
            return d.address
    raise RuntimeError(f"Cannot find device by name: {name}")


async def run_list(sess: Session, timeout_s: float) -> list[ListEntry]:
    sess.list_entries.clear()
    sess.list_done.clear()
    await sess.write_ctrl(bytes([sess.profile.cmd_list]))
    await asyncio.wait_for(sess.list_done.wait(), timeout=timeout_s)
    return list(sess.list_entries)


async def run_status(sess: Session, timeout_s: float) -> dict:
    sess.status_event.clear()
    await sess.write_ctrl(bytes([sess.profile.cmd_status]))
    await asyncio.wait_for(sess.status_event.wait(), timeout=timeout_s)
    if not sess.last_status:
        raise RuntimeError("No status received")
    return sess.last_status


async def run_read(
    sess: Session,
    file_name: str,
    out_dir: Path,
    expected_samples: Optional[int],
    timeout_s: float,
    ctrl_payload: Optional[bytes] = None,
) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    safe = file_name.replace("/", "_")
    ts = time.strftime("%Y%m%d_%H%M%S")
    bin_path = out_dir / f"{safe}_{sess.profile.name}_{ts}.bin"
    csv_path = out_dir / f"{safe}_{sess.profile.name}_{ts}.csv"
    json_path = out_dir / f"{safe}_{sess.profile.name}_{ts}.json"

    remain = bytearray()
    frames = 0
    packets = 0
    anchors: list[dict] = []
    bytes_rx = 0
    started = time.time()
    last_print = started
    last_flush = started
    first_sample_host_ms: Optional[int] = None
    interrupted_error: Optional[str] = None

    bf = bin_path.open("wb")
    cf = csv_path.open("w", newline="")
    cw = csv.writer(cf)
    if sess.profile.name == "ads1299":
        cw.writerow(["sample_idx", "offset_ms", "host_time_ms", "status", "ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "ch7", "ch8"])
        sample_rate = 250.0
    else:
        cw.writerow(["sample_idx", "offset_ms", "host_time_ms", "biov"])
        sample_rate = 512.0

    def host_time_from_anchor(sample_idx: int) -> Optional[float]:
        if not anchors:
            return None
        a = anchors[-1]
        return float(a["host_ms"]) + (sample_idx - int(a["sample_idx"])) * (1000.0 / sample_rate)

    def on_file(data: bytes) -> None:
        nonlocal frames, packets, bytes_rx, first_sample_host_ms, last_print, last_flush
        if not data:
            return
        bytes_rx += len(data)
        bf.write(data)
        for t, ln, payload in parse_records(data, remain):
            packets += 1
            if t == 0x02 and ln >= 16:
                host_ms = u64le(payload, 0)
                sample_idx = u64le(payload, 8)
                anchors.append({"host_ms": host_ms, "sample_idx": sample_idx})
                if sample_idx == 0:
                    first_sample_host_ms = host_ms
                continue
            if t != 0x01:
                continue
            if sess.profile.name == "ads1299":
                if ln < 27:
                    continue
                status = ((payload[0] << 16) | (payload[1] << 8) | payload[2]) & 0xFFFFFF
                ch = [int24be(payload[3 + i * 3], payload[4 + i * 3], payload[5 + i * 3]) for i in range(8)]
                host_ms = host_time_from_anchor(frames)
                offset = frames * (1000.0 / sample_rate)
                cw.writerow([frames, f"{offset:.3f}", "" if host_ms is None else f"{host_ms:.3f}", status, *ch])
                frames += 1
            else:
                if ln < 3:
                    continue
                v = int24be(payload[0], payload[1], payload[2])
                host_ms = host_time_from_anchor(frames)
                offset = frames * (1000.0 / sample_rate)
                cw.writerow([frames, f"{offset:.3f}", "" if host_ms is None else f"{host_ms:.3f}", v])
                frames += 1

        now = time.time()
        if now - last_flush >= 1.0:
            bf.flush()
            cf.flush()
            last_flush = now
        if now - last_print >= 0.2:
            last_print = now
            render_progress(frames, expected_samples, bytes_rx, started, done=False)

    sess.set_file_handler(on_file)
    sess.read_done.clear()
    payload = ctrl_payload if ctrl_payload is not None else (bytes([sess.profile.cmd_read]) + file_name.encode("ascii", errors="ignore")[:24])
    await sess.write_ctrl(payload)

    try:
        await asyncio.wait_for(sess.read_done.wait(), timeout=timeout_s)
    except Exception as e:
        interrupted_error = str(e)
    finally:
        sess.set_file_handler(None)
        bf.flush()
        cf.flush()
        bf.close()
        cf.close()
        render_progress(frames, expected_samples, bytes_rx, started, done=True)

    elapsed = max(0.001, time.time() - started)
    meta = {
        "profile": sess.profile.name,
        "file_name": file_name,
        "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "sample_rate_hz": sample_rate,
        "samples": frames,
        "records": packets,
        "bytes": bytes_rx,
        "elapsed_s": elapsed,
        "avg_samples_per_s": frames / elapsed,
        "first_sample_host_time_ms": first_sample_host_ms,
        "anchors": anchors,
        "bin_path": str(bin_path),
        "csv_path": str(csv_path),
        "complete": interrupted_error is None,
        "error": interrupted_error,
    }
    json_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


async def run(args: argparse.Namespace) -> None:
    if args.type == "ads1299":
        profile = ADS
    elif args.type == "max30003":
        profile = MAX
    else:
        profile = MAX30001
    address = await discover_address(args.name, args.address, profile.service, args.scan_timeout)
    print(f"[BLE] connecting: {address} ({profile.name})")
    async with BleakClient(address, timeout=args.connect_timeout) as client:
        if not client.is_connected:
            raise RuntimeError("BLE connect failed")
        if profile.name == "max30001":
            raise RuntimeError(
                "max30001 firmware is stream-only right now (switch + biov/bioz notify). "
                "Download/recover needs max30001 CTRL/FILE/META + NAND logging in firmware."
            )
        sess = Session(client, profile, verbose=args.verbose)
        await sess.start()
        try:
            if args.command == "status":
                st = await run_status(sess, args.timeout)
                print(json.dumps(st, ensure_ascii=False, indent=2))
                return

            if args.command == "list":
                entries = await run_list(sess, args.timeout)
                print(f"[LIST] {len(entries)} file(s)")
                for e in entries:
                    print(f"  - {e.name}\tsamples={e.samples}\tpages={e.pages}")
                return

            if args.command == "read":
                entries = await run_list(sess, args.timeout)
                expected = None
                for e in entries:
                    if e.name == args.file:
                        expected = e.samples
                        break
                print(f"[READ] start file={args.file} expected_samples={expected if expected is not None else '?'}")
                meta = await run_read(
                    sess,
                    file_name=args.file,
                    out_dir=Path(args.out_dir),
                    expected_samples=expected,
                    timeout_s=args.timeout,
                )
                if meta.get("complete", True):
                    print("[READ] done")
                else:
                    print(f"[READ] interrupted; partial data saved (error={meta.get('error')})")
                print(json.dumps(meta, ensure_ascii=False, indent=2))
                return

            if args.command == "recover":
                print("[RECOVER] start raw NAND recovery stream")
                meta = await run_read(
                    sess=sess,
                    file_name=f"recover_{sess.profile.name}",
                    out_dir=Path(args.out_dir),
                    expected_samples=None,
                    timeout_s=args.timeout,
                    ctrl_payload=bytes([sess.profile.cmd_recover]),
                )
                if meta.get("complete", True):
                    print("[RECOVER] done")
                else:
                    print(f"[RECOVER] interrupted; partial data saved (error={meta.get('error')})")
                print(json.dumps(meta, ensure_ascii=False, indent=2))
                return
        finally:
            await sess.stop()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Nexus BLE downloader (ADS1299 / MAX30003 / MAX30001)")
    p.add_argument("--type", choices=["ads1299", "max30003", "max30001"], required=True, help="Device profile")
    p.add_argument("--address", default=None, help="BLE address/UUID (preferred)")
    p.add_argument("--name", default=None, help="BLE name keyword (fallback scan)")
    p.add_argument("--scan-timeout", type=float, default=6.0, help="Scan timeout seconds")
    p.add_argument("--connect-timeout", type=float, default=20.0, help="Connect timeout seconds")
    p.add_argument("--timeout", type=float, default=36000.0, help="Command timeout seconds")
    p.add_argument("--verbose", action="store_true", help="Print meta logs")

    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="List files on device")
    sub.add_parser("status", help="Read runtime status")
    sp_recover = sub.add_parser("recover", help="Recover raw records even when dir/list is broken")
    sp_recover.add_argument("--out-dir", default="./downloads", help="Output directory")
    sp = sub.add_parser("read", help="Read one file from device")
    sp.add_argument("--file", required=True, help="Target filename on device")
    sp.add_argument("--out-dir", default="./downloads", help="Output directory")
    return p


def main() -> None:
    args = build_parser().parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
