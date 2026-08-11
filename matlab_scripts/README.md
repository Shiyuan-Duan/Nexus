# MATLAB Scripts

## MLX97 capture

Use [mlx97_capture.m](/Users/shiyuanduan/Documents/PhD/CodingStuff/Nexus/matlab_scripts/mlx97_capture.m) to collect raw MLX97 BLE data directly from MATLAB.

### What it does

- Prompts for BLE device name or address
- Prompts for output folder
- Prompts for output filename
- Connects over BLE
- Subscribes to the MLX97 stream characteristic
- Sends `CTRL START`
- Saves raw samples to CSV
- Sends `CTRL STOP` when you stop

### CSV columns

- `host_time_iso`
- `host_t_ms`
- `t_ms_device`
- `x`
- `y`
- `z`
- `stat1`
- `stat2`

### Usage

In MATLAB:

```matlab
cd('/Users/shiyuanduan/Documents/PhD/CodingStuff/Nexus/matlab_scripts');
mlx97_capture
```

### Requirements

- MATLAB with Bluetooth Low Energy support (`ble`, `characteristic`, `subscribe`)
- The MLX97 device advertising and connectable

### MLX97 UUIDs

- Service: `a0a4e690-96be-4222-b41e-98ea76b0120c`
- Stream: `a0a4e691-96be-4222-b41e-98ea76b0120c`
- Ctrl: `a0a4e692-96be-4222-b41e-98ea76b0120c`

## Mechanical sensor capture

Use [mechanical_sensor_capture.m](/Users/shiyuanduan/Documents/PhD/CodingStuff/Nexus/matlab_scripts/mechanical_sensor_capture.m) to collect both MLX97 magnetometer data and BMI270 IMU data from the laptop.

### What it does

- Prompts for BLE device name or address
- Prompts for output folder
- Prompts for output file prefix
- Connects over BLE
- Subscribes to the MLX97 stream characteristic
- Subscribes to the IMU characteristic
- Sends `CTRL START`
- Saves two CSV files, one for MLX97 and one for IMU
- Sends `CTRL STOP` when you stop

### Output files

- `<prefix>_mlx97.csv`
- `<prefix>_imu.csv`

### IMU CSV columns

- `host_time_iso`
- `host_t_ms`
- `t_ms_device`
- `ax_mg`
- `ay_mg`
- `az_mg`
- `gx_dps_x10`
- `gy_dps_x10`
- `gz_dps_x10`

### Usage

In MATLAB:

```matlab
cd('/Users/shiyuanduan/Documents/PhD/CodingStuff/Nexus/matlab_scripts');
mechanical_sensor_capture
```

### Mechanical sensor UUIDs

- Service: `a0a4e690-96be-4222-b41e-98ea76b0120c`
- MLX97 Stream: `a0a4e691-96be-4222-b41e-98ea76b0120c`
- Ctrl: `a0a4e692-96be-4222-b41e-98ea76b0120c`
- IMU: `a0a4e693-96be-4222-b41e-98ea76b0120c`
