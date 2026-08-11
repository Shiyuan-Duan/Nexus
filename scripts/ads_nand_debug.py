#!/usr/bin/env python3
"""BLE-only ADS1299 NAND debug helper.

This script is intended for situations where RTT is unavailable and you can
only interact with the device over BLE.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path
from typing import Optional

from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic


ADS_SERVICE_UUID = "4f6a9b50-6d4a-4f26-8f6a-3a0b2c1b21a0"
ADS_CHAR_CTRL = "4f6a9b52-6d4a-4f26-8f6a-3a0b2c1b21a0"
ADS_CHAR_META = "4f6a9b55-6d4a-4f26-8f6a-3a0b2c1b21a0"
ADS_CHAR_DEBUG = "4f6a9b56-6d4a-4f26-8f6a-3a0b2c1b21a0"

CMD_REC_START = 0x10
CMD_REC_STOP = 0x11
CMD_LIST = 0x12
CMD_FORMAT = 0x15
CMD_STATUS = 0x21


def get_u64le(buf: bytes, off: int) -> int:
    return int.from_bytes(buf[off : off + 8], "little", signed=False)


def get_u32le(buf: bytes, off: int) -> int:
    return int.from_bytes(buf[off : off + 4], "little", signed=False)


def get_i16le(buf: bytes, off: int) -> int:
    return int.from_bytes(buf[off : off + 2], "little", signed=True)


def decode_errno(status: int) -> str:
    names = {
        2: "ENOENT",
        5: "EIO",
        16: "EBUSY",
        17: "EEXIST",
        19: "ENODEV",
        22: "EINVAL",
        28: "ENOSPC",
    }
    return names.get(status, f"ERR{status}")


def parse_meta(data: bytes) -> str:
    if not data:
        return "empty"
    t = data[0]
    if t == 0x01 and len(data) >= 14:
        name_len = data[1]
        name = data[2 : 2 + name_len].decode("ascii", errors="ignore")
        off = 2 + name_len
        if off + 12 <= len(data):
            samples = get_u64le(data, off)
            pages = get_u32le(data, off + 8)
            return f"list_entry name={name} samples={samples} pages={pages}"
        return f"list_entry malformed name={name}"
    if t == 0x02:
        return "list_done"
    if t == 0x03:
        return "read_done"
    if t == 0x10 and len(data) >= 12:
        stream = data[1] != 0
        rec = data[2] != 0
        name_len = data[3]
        name = data[4 : 4 + name_len].decode("ascii", errors="ignore")
        off = 4 + name_len
        samples = get_u64le(data, off) if off + 8 <= len(data) else 0
        return f"status stream={int(stream)} rec={int(rec)} name={name or '-'} samples={samples}"
    if t == 0xF0 and len(data) >= 3:
        cmd = data[1]
        status = data[2]
        if len(data) >= 6:
            nand = data[3] != 0
            rc = get_i16le(data, 4)
            return f"ack cmd=0x{cmd:02x} status={status}({decode_errno(status) if status else 'OK'}) nand={int(nand)} rc={rc}"
        return f"ack cmd=0x{cmd:02x} status={status}"
    return f"raw type=0x{t:02x} len={len(data)} hex={data.hex(' ')}"


def parse_kv_line(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    parts = text.strip().split()
    if not parts:
        return out
    out["kind"] = parts[0]
    for token in parts[1:]:
        if "=" not in token:
            continue
        key, value = token.split("=", 1)
        out[key] = value
    return out


def diagnose(debug_packets: list[str], meta_packets: list[str]) -> dict[str, str]:
    diagnosis = {
        "summary": "unknown",
        "problem_stage": "unknown",
        "suggested_fix": "inspect log file",
    }
    for text in reversed(debug_packets):
        if not text.startswith("NANDDBG "):
            continue
        data = parse_kv_line(text)
        stage = data.get("stage", "unknown")
        err = data.get("err", "0")
        fix = data.get("fix", "inspect_log")
        diagnosis["problem_stage"] = stage
        diagnosis["suggested_fix"] = fix
        if stage == "nand_probe_ok":
            diagnosis["summary"] = "probe_ok"
        elif stage == "nand_fs_ready":
            diagnosis["summary"] = "nand_fs_ready"
        elif "dir_" in stage or "nand_fs_init_failed" == stage:
            diagnosis["summary"] = "directory_or_fs_failure"
        elif "jedec" in stage or "spi" in stage or "dev_not_ready" in stage:
            diagnosis["summary"] = "nand_probe_failure"
        elif "recover" in stage:
            diagnosis["summary"] = "recover_path"
        diagnosis["last_error"] = err
        diagnosis["last_debug"] = text
        return diagnosis
    if any("nand=0" in m for m in meta_packets):
        diagnosis["summary"] = "nand_disabled_in_firmware"
        diagnosis["suggested_fix"] = "inspect_debug_channel_log"
    return diagnosis


async def discover_address(name: Optional[str], address: Optional[str], timeout: float) -> str:
    if address:
        return address
    if not name:
        raise ValueError("Provide --name or --address")
    devices = await BleakScanner.discover(timeout=timeout, return_adv=True)
    candidates: list[str] = []
    for device, adv in devices.values():
        uuids = [u.lower() for u in (adv.service_uuids or [])]
        if ADS_SERVICE_UUID.lower() in uuids:
            candidates.append(f"{device.name or '-'} | {device.address} | ads_service=1")
        if device.name and name.lower() in device.name.lower():
            if ADS_SERVICE_UUID.lower() in uuids:
                return device.address
    for device, _adv in devices.values():
        if device.name and name.lower() in device.name.lower():
            return device.address
    msg = [f"Cannot find device by name: {name}"]
    if candidates:
        msg.append("ADS candidates seen during scan:")
        msg.extend(candidates[:10])
    else:
        msg.append("No ADS service candidates seen during scan.")
    raise RuntimeError("\n".join(msg))


async def print_gatt(client: BleakClient) -> None:
    print("[GATT] services/chars")
    for service in client.services:
        if service.uuid.lower() != ADS_SERVICE_UUID.lower():
            continue
        print(f"  service {service.uuid}")
        for char in service.characteristics:
            props = ",".join(char.properties)
            print(f"    char {char.uuid} props={props}")


async def wait_for(predicate, timeout: float, step: float = 0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        await asyncio.sleep(step)
    raise asyncio.TimeoutError()


async def main_async(args: argparse.Namespace) -> None:
    address = await discover_address(args.name, args.address, args.scan_timeout)
    print(f"[BLE] connecting {address}")
    meta_packets: list[str] = []
    debug_packets: list[str] = []
    raw_events: list[dict[str, str]] = []
    meta_event = asyncio.Event()
    ack_event = asyncio.Event()
    status_event = asyncio.Event()
    list_done_event = asyncio.Event()
    list_entries: list[dict[str, int | str]] = []
    last_ack: Optional[dict[str, int]] = None
    last_status: Optional[dict[str, int | str]] = None
    started_at = time.strftime("%Y%m%d_%H%M%S")
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = out_dir / f"ads_nand_debug_{started_at}.log"
    json_path = out_dir / f"ads_nand_debug_{started_at}.json"

    def on_meta(_: BleakGATTCharacteristic, data: bytearray) -> None:
        nonlocal last_ack, last_status
        text = parse_meta(bytes(data))
        meta_packets.append(text)
        raw_events.append({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "type": "meta", "text": text})
        print(f"[META] {text}", flush=True)
        meta_event.set()
        b = bytes(data)
        if not b:
            return
        t = b[0]
        if t == 0x01 and len(b) >= 14:
            name_len = b[1]
            name = b[2 : 2 + name_len].decode("ascii", errors="ignore")
            off = 2 + name_len
            if off + 12 <= len(b):
                list_entries.append({
                    "name": name,
                    "samples": get_u64le(b, off),
                    "pages": get_u32le(b, off + 8),
                })
        elif t == 0x02:
            list_done_event.set()
        elif t == 0x10 and len(b) >= 12:
            stream = 1 if (b[1] != 0) else 0
            rec = 1 if (b[2] != 0) else 0
            name_len = b[3]
            name = b[4 : 4 + name_len].decode("ascii", errors="ignore")
            off = 4 + name_len
            samples = get_u64le(b, off) if off + 8 <= len(b) else 0
            last_status = {
                "stream": stream,
                "rec": rec,
                "name": name,
                "samples": samples,
            }
            status_event.set()
        elif t == 0xF0 and len(b) >= 3:
            last_ack = {
                "cmd": b[1],
                "status": b[2],
                "nand": 1 if (len(b) >= 4 and b[3] != 0) else 0,
                "rc": get_i16le(b, 4) if len(b) >= 6 else 0,
            }
            ack_event.set()

    def on_debug(_: BleakGATTCharacteristic, data: bytearray) -> None:
        try:
            text = bytes(data).decode("ascii", errors="ignore")
        except Exception:
            text = bytes(data).hex(" ")
        debug_packets.append(text)
        raw_events.append({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "type": "debug", "text": text})
        print(f"[DEBUG] {text}", flush=True)

    async with BleakClient(address, timeout=args.connect_timeout) as client:
        if not client.is_connected:
            raise RuntimeError("BLE connect failed")
        async def subscribe_all(print_services: bool = False) -> None:
            await client.get_services()
            if print_services:
                await print_gatt(client)
            await client.start_notify(ADS_CHAR_META, on_meta)
            try:
                await client.start_notify(ADS_CHAR_DEBUG, on_debug)
            except Exception as exc:
                print(f"[DEBUG] subscribe failed: {exc}")

        async def unsubscribe_all() -> None:
            try:
                await client.stop_notify(ADS_CHAR_META)
            except Exception:
                pass
            try:
                await client.stop_notify(ADS_CHAR_DEBUG)
            except Exception:
                pass

        await subscribe_all(print_services=True)

        async def send(cmd: int, label: str, payload: bytes = b"") -> None:
            meta_event.clear()
            ack_event.clear()
            print(f"[CTRL] send {label} (0x{cmd:02x})")
            await client.write_gatt_char(ADS_CHAR_CTRL, bytes([cmd]) + payload, response=False)
            try:
                await asyncio.wait_for(meta_event.wait(), timeout=args.cmd_timeout)
            except asyncio.TimeoutError:
                print(f"[CTRL] timeout waiting for first META after {label}")

        async def request_status() -> Optional[dict[str, int | str]]:
            status_event.clear()
            await send(CMD_STATUS, "STATUS")
            try:
                await asyncio.wait_for(status_event.wait(), timeout=args.cmd_timeout)
            except asyncio.TimeoutError:
                print("[STATUS] timeout")
                return None
            return last_status

        async def request_list() -> list[dict[str, int | str]]:
            list_entries.clear()
            list_done_event.clear()
            await send(CMD_LIST, "LIST")
            try:
                await asyncio.wait_for(list_done_event.wait(), timeout=max(args.cmd_timeout, 6.0))
            except asyncio.TimeoutError:
                print("[LIST] timeout waiting for end-of-list")
            print(f"[LIST] {len(list_entries)} entries")
            for e in list_entries:
                print(f"  - {e['name']} samples={e['samples']} pages={e['pages']}")
            return list(list_entries)

        async def send_and_wait_ack(cmd: int, label: str, payload: bytes = b"") -> Optional[dict[str, int]]:
            ack_event.clear()
            await send(cmd, label, payload)
            try:
                await asyncio.wait_for(ack_event.wait(), timeout=args.cmd_timeout)
            except asyncio.TimeoutError:
                print(f"[ACK] timeout waiting for {label}")
                return None
            print(f"[ACK] {last_ack}")
            return last_ack

        await request_status()

        if args.do_list:
            await request_list()
            await asyncio.sleep(1.0)

        if args.do_format:
            await send_and_wait_ack(CMD_FORMAT, "FORMAT")
            await asyncio.sleep(1.0)
            await request_status()

        if args.rec_name:
            print(f"[ROUNDTRIP] start rec_name={args.rec_name} duration={args.rec_seconds:.1f}s reconnect={int(args.reconnect_after_stop)}")
            await request_status()
            before = await request_list()
            ack = await send_and_wait_ack(CMD_REC_START, "REC_START", args.rec_name.encode("ascii", errors="ignore")[:24])
            if not ack or ack.get("status", 1) != 0:
                print("[ROUNDTRIP] REC_START failed; aborting roundtrip")
            else:
                await asyncio.sleep(args.rec_seconds)
                await request_status()
                ack = await send_and_wait_ack(CMD_REC_STOP, "REC_STOP")
                await asyncio.sleep(args.post_stop_wait)
                await request_status()
                mid = await request_list()
                before_names = {str(e["name"]) for e in before}
                new_entries = [e for e in mid if str(e["name"]) not in before_names]
                print(f"[ROUNDTRIP] new_entries_immediate={len(new_entries)}")
                for e in new_entries:
                    print(f"  immediate: {e['name']} samples={e['samples']} pages={e['pages']}")

                if args.reconnect_after_stop:
                    print("[ROUNDTRIP] reconnecting to verify persistence")
                    await unsubscribe_all()
                    await client.disconnect()
                    await asyncio.sleep(1.0)
                    await client.connect()
                    if not client.is_connected:
                        raise RuntimeError("BLE reconnect failed")
                    await subscribe_all(print_services=False)
                    await request_status()
                    after = await request_list()
                    before_names = {str(e["name"]) for e in before}
                    persisted = [e for e in after if str(e["name"]) not in before_names]
                    print(f"[ROUNDTRIP] new_entries_after_reconnect={len(persisted)}")
                    for e in persisted:
                        print(f"  persisted: {e['name']} samples={e['samples']} pages={e['pages']}")

        if args.debug_wait > 0:
            print(f"[WAIT] listening for DEBUG/META for {args.debug_wait:.1f}s")
            await asyncio.sleep(args.debug_wait)

        print("")
        print("[SUMMARY]")
        print(f"  meta_packets={len(meta_packets)}")
        print(f"  debug_packets={len(debug_packets)}")
        if not meta_packets:
            print("  no META seen")
        result = diagnose(debug_packets, meta_packets)
        print(f"  diagnosis={result['summary']}")
        print(f"  problem_stage={result['problem_stage']}")
        print(f"  suggested_fix={result['suggested_fix']}")

        with log_path.open("w", encoding="utf-8") as f:
            for event in raw_events:
                f.write(f"{event['ts']} [{event['type'].upper()}] {event['text']}\n")
        json_path.write_text(
            json.dumps(
                {
                    "address": address,
                    "started_at": started_at,
                    "meta_packets": meta_packets,
                    "debug_packets": debug_packets,
                    "diagnosis": result,
                    "log_path": str(log_path),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"  saved_log={log_path}")
        print(f"  saved_json={json_path}")

        await unsubscribe_all()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="BLE-only ADS1299 NAND debug helper")
    parser.add_argument("--name", default="NIEEG-ADS1299-Demo1", help="BLE device name substring")
    parser.add_argument("--address", default=None, help="BLE address/UUID")
    parser.add_argument("--scan-timeout", type=float, default=6.0, help="Scan timeout seconds")
    parser.add_argument("--connect-timeout", type=float, default=20.0, help="Connect timeout seconds")
    parser.add_argument("--cmd-timeout", type=float, default=4.0, help="Timeout for first META after command")
    parser.add_argument("--debug-wait", type=float, default=2.0, help="Extra seconds to keep listening")
    parser.add_argument("--do-list", action="store_true", help="Also send LIST")
    parser.add_argument("--do-format", action="store_true", help="Also send FORMAT")
    parser.add_argument("--rec-name", default=None, help="If set, run REC_START/REC_STOP roundtrip with this filename")
    parser.add_argument("--rec-seconds", type=float, default=5.0, help="Recording duration for roundtrip test")
    parser.add_argument("--post-stop-wait", type=float, default=2.0, help="Wait after REC_STOP before LIST")
    parser.add_argument("--reconnect-after-stop", action="store_true", help="Disconnect/reconnect after REC_STOP and verify LIST again")
    parser.add_argument("--out-dir", default="./downloads", help="Directory for saved debug logs")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
