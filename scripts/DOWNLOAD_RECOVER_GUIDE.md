# Nexus BLE Data Download & Recovery Guide (ADS1299 / MAX30003 / MAX30001)

This guide explains how to download or recover data from both BLE devices using the Python scripts in this repo.

- ADS1299 EEG device profile: `ads1299`
- MAX30003 ECG/EMG device profile: `max30003`
- MAX30001 profile: `max30001` (currently stream-only in firmware; no list/read/recover yet)
- Main script: `Nexus/scripts/ble_nexus_download.py`
- ADS recovery post-process script: `Nexus/scripts/recover_ads.py`
- ADS one-click recover-to-CSV wrapper: `Nexus/scripts/recover_ads_csv.py`

---

## 1) Prerequisites

## 1.1 Firmware requirements

For **normal download** (`list`/`read`), firmware only needs command `LIST (0x12)` and `READ (0x13)`.

For **raw recovery when file list is broken** (`recover`), firmware must include:
- `RECOVER (0x30)` in BLE CTRL command parser
- recovery scan implementation in app (`ads1299_stream_app.c`)

If `recover` immediately fails or does nothing, confirm device is running the updated firmware.

## 1.2 Python environment

On macOS with PEP 668 (externally-managed Python), use a virtualenv:

```bash
cd /Users/shiyuanduan/Documents/PhD/CodingStuff
python3 -m venv .venv_ble
source .venv_ble/bin/activate
python -m pip install --upgrade pip
python -m pip install bleak
```

You must activate `.venv_ble` before running scripts.

## 1.3 Paths

All commands in this guide assume current dir:

```bash
cd /Users/shiyuanduan/Documents/PhD/CodingStuff
source .venv_ble/bin/activate
```

---

## 2) Core script overview

Main CLI:

```bash
python Nexus/scripts/ble_nexus_download.py --type {ads1299|max30003|max30001} [global options] <command> [command options]
```

Global options:
- `--type ads1299|max30003` (required)
- `--name <BLE name substring>` or `--address <BLE address/UUID>`
- `--verbose` print detailed META logs
- `--timeout` command timeout in seconds (default long)
- `--scan-timeout`, `--connect-timeout`

Commands:
- `list` list files in device directory
- `status` query runtime status (`streamActive`, `recordingActive`, etc.)
- `read --file <name> --out-dir <dir>` normal download by filename
- `recover --out-dir <dir>` raw recovery stream (ADS only, for broken directory / 0 files)

Outputs (`read` / `recover`):
- `*.bin` raw packed records from FILE notify
- `*.csv` decoded samples
- `*.json` metadata (sample rate, anchors, throughput, paths)

---

## 3) Recommended operation order

1. Try `list` first.
2. If file is visible, use `read` (best for exact file-level retrieval).
3. If ADS `list` is empty unexpectedly (e.g., power-loss directory issue), use `recover`.
4. For ADS, if you only need last N hours, run `recover_ads.py` (or one-click wrapper).

---

## 4) ADS1299 workflow

## 4.1 Normal file download (preferred)

### Step A: list files

```bash
python Nexus/scripts/ble_nexus_download.py \
  --type ads1299 \
  --name NIEEG-ADS1299-Demo1 \
  --verbose \
  list
```

### Step B: read one file

```bash
python Nexus/scripts/ble_nexus_download.py \
  --type ads1299 \
  --name NIEEG-ADS1299-Demo1 \
  --verbose \
  read \
  --file <FILE_NAME> \
  --out-dir ./downloads
```

## 4.2 Recovery when list is 0 files

```bash
python Nexus/scripts/ble_nexus_download.py \
  --type ads1299 \
  --name NIEEG-ADS1299-Demo1 \
  --verbose \
  recover \
  --out-dir ./downloads
```

This scans NAND data pages and streams valid records even when directory metadata is broken.

## 4.3 Recover only last N hours (ADS)

After you have a recovered `*.bin`, trim to last N hours:

```bash
python Nexus/scripts/recover_ads.py \
  --input-bin ./downloads/<RECOVERED_BIN>.bin \
  --hours 4 \
  --fs 250 \
  --out-dir ./downloads
```

Common values:
- `--hours 4`
- `--hours 5.2`

## 4.4 One-click ADS recover-to-CSV

If you do not want to manually handle the intermediate bin:

```bash
python Nexus/scripts/recover_ads_csv.py --hours 4 --verbose
```

Defaults:
- device name default is `NIEEG-ADS1299-Demo1`
- intermediate bin is deleted by default
- add `--keep-bin` to preserve bin

---

## 5) MAX30003 workflow

## 5.1 Normal file download (preferred)

### Step A: list files

```bash
python Nexus/scripts/ble_nexus_download.py \
  --type max30003 \
  --name NIEMG-Demo1 \
  --verbose \
  list
```

### Step B: read one file

```bash
python Nexus/scripts/ble_nexus_download.py \
  --type max30003 \
  --name NIEMG-Demo1 \
  --verbose \
  read \
  --file <FILE_NAME> \
  --out-dir ./downloads
```

MAX30003 (ECG/EMG) note:
- `recover` is **not supported now**.
- Use normal `list` + `read` only.

---

## 5.3 MAX30001 status (important)

Current firmware (`max30001_stream_app.c` + `ble_max30001_stream_srv.c`) exposes:
- switch characteristic
- live notify characteristics (`biov`, `bioz`)

It does **not** expose:
- `CTRL` commands (`LIST/READ/RECOVER`)
- `FILE` notify
- `META` notify
- NAND logging directory

So script-level `list/read/recover` is currently unavailable for `max30001` until firmware adds the same download protocol as ADS/MAX30003.

## 6) Data format details

Sampling rates used by scripts:
- ADS1299: **250 Hz**
- MAX30003: **512 Hz**

## 6.1 Raw packed record format (`*.bin`)

All FILE data is packed as repeated records:

```text
[type][len][payload]
```

- `type=0x01`: sample frame record
- `type=0x02`: time sync anchor (`host_time_ms`, `sample_index`)

## 6.2 ADS CSV columns

`sample_idx, offset_ms, host_time_ms, status, ch1..ch8`

- `offset_ms`: sample-relative timeline
- `host_time_ms`: estimated from nearest/recent anchor

## 6.3 MAX CSV columns

`sample_idx, offset_ms, host_time_ms, biov`

---

## 7) Recording start time recoverability

Can start time always be recovered?

- **If time-sync anchors exist** (`type=0x02` records): start absolute time can be estimated.
- **If no anchors**: only relative timeline (`offset_ms`) is available; absolute `rec start` cannot be reconstructed exactly.

Check `*.json` fields:
- `anchors`
- `first_sample_host_time_ms`

---

## 8) Performance expectations

Speed depends on BLE connection interval/MTU/notifications and disk IO.

General notes:
- `read` and `recover` write CSV while receiving; this is stable but not max speed.
- `--verbose` adds log overhead.
- Very large recordings may take tens of minutes to hours.

Progress display in terminal includes:
- percentage (if expected sample count known)
- current/expected samples
- current samples/s
- received MB

---

## 9) Troubleshooting

## 9.1 `externally-managed-environment` when installing `bleak`

Use virtualenv (`.venv_ble`) as shown in Prerequisites.

## 9.2 `Characteristic ... not found`

- Device may not be fully discovered/connected.
- Reconnect and retry.
- Verify service UUID matches selected `--type`.

## 9.3 `list` shows 0 files after power loss

Likely directory/index corruption. Use `recover`.

## 9.4 Recover returns nothing

Possible causes:
- Firmware does not include `CMD_RECOVER (0x30)` implementation.
- NAND has no valid records in scanned range.
- Wrong profile (`--type` mismatch).

## 9.5 Can app still download after crash?

Yes. Device-side NAND data is independent of app process crashes.
Re-run scripts and download/recover again.

---

## 10) Practical command cheat-sheet

ADS normal:

```bash
python Nexus/scripts/ble_nexus_download.py --type ads1299 --name NIEEG-ADS1299-Demo1 list
python Nexus/scripts/ble_nexus_download.py --type ads1299 --name NIEEG-ADS1299-Demo1 read --file <F> --out-dir ./downloads
```

ADS recover:

```bash
python Nexus/scripts/ble_nexus_download.py --type ads1299 --name NIEEG-ADS1299-Demo1 recover --out-dir ./downloads
python Nexus/scripts/recover_ads.py --input-bin ./downloads/<B>.bin --hours 4 --fs 250 --out-dir ./downloads
```

ADS one-click recover 4h:

```bash
python Nexus/scripts/recover_ads_csv.py --hours 4 --verbose
```

MAX normal:

```bash
python Nexus/scripts/ble_nexus_download.py --type max30003 --name NIEMG-Demo1 list
python Nexus/scripts/ble_nexus_download.py --type max30003 --name NIEMG-Demo1 read --file <F> --out-dir ./downloads
```

MAX recover:
- Not supported now for ECG/EMG (`max30003`).

---

## 11) Notes for analysis tools (MATLAB / Python)

- ADS has 8 channels in CSV (`ch1..ch8`).
- Use `offset_ms` for reliable relative alignment.
- Use `host_time_ms` only when anchors exist and absolute timeline is needed.

For long recordings, prefer processing CSV in chunks to reduce RAM pressure.
