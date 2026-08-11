function out = mechanical_sensor_record_print(deviceId, recordSeconds)
% Console-only MechanicalSensor recorder:
%   - Connect BLE
%   - Subscribe META / MLX / IMU notifications
%   - STREAM_ON
%   - REC_START(overwrite)
%   - Print 1 Hz summary to MATLAB command window
%   - REC_STOP + STREAM_OFF
%
% Example:
%   out = mechanical_sensor_record_print("mech50", 5);

    if nargin < 1 || strlength(string(deviceId)) == 0
        deviceId = "mech50";
    else
        deviceId = string(deviceId);
    end

    if nargin < 2 || isempty(recordSeconds)
        recordSeconds = 5;
    end

    const = makeConsts();

    bleObj = [];
    ctrlChar = [];
    streamChar = [];
    imuChar = [];
    metaChar = [];
    cleanupObj = onCleanup(@cleanupAll); %#ok<NASGU>

    status = struct( ...
        'streamActive', false, ...
        'recordingActive', false, ...
        'hasRecording', false, ...
        'dirtyOpen', false, ...
        'nandReady', false, ...
        'bytesWritten', uint64(0), ...
        'mlxCount', uint64(0), ...
        'imuCount', uint64(0), ...
        'nextPage', uint32(0), ...
        'lastPage', uint32(0), ...
        'lastError', int32(0));

    lastAck = struct('cmd', uint8(0), 'rc', int16(0), 'status', uint8(0));
    mlxRx = 0;
    imuRx = 0;
    metaRx = 0;
    startTic = [];
    lastStatusRxTic = [];
    lastMlxDeviceMs = uint32(0);
    lastImuDeviceMs = uint32(0);
    lastMlxSample = [NaN NaN NaN];
    lastImuSample = [NaN NaN NaN NaN NaN NaN];
    lastSummaryTic = [];
    summary = struct( ...
        'mlxPrinted', 0, ...
        'imuPrinted', 0, ...
        'lastBytes', uint64(0), ...
        'lastMlxCount', uint64(0), ...
        'lastImuCount', uint64(0), ...
        'lastMlxDeviceMs', uint32(0), ...
        'lastImuDeviceMs', uint32(0));

    logLine("MechanicalSensor console recorder");
    logLine(sprintf("device=%s", deviceId));
    logLine(sprintf("recordSeconds=%.1f", recordSeconds));

    bleObj = ble(deviceId);
    ctrlChar = characteristic(bleObj, const.SERVICE_UUID, const.CHAR_CTRL_UUID);
    streamChar = characteristic(bleObj, const.SERVICE_UUID, const.CHAR_STREAM_UUID);
    imuChar = characteristic(bleObj, const.SERVICE_UUID, const.CHAR_IMU_UUID);
    metaChar = characteristic(bleObj, const.SERVICE_UUID, const.CHAR_META_UUID);

    streamChar.DataAvailableFcn = @onMlxData;
    imuChar.DataAvailableFcn = @onImuData;
    metaChar.DataAvailableFcn = @onMetaData;

    subscribe(metaChar, "notification");
    subscribe(streamChar, "notification");
    subscribe(imuChar, "notification");

    pause(0.4);
    startTic = tic;
    lastSummaryTic = tic;

    sendCommand(const.CMD_STATUS);
    waitForStatus(@(~) true, 3.0, "initial status");

    sendCommand(const.CMD_STREAM_ON);
    waitForStatus(@(s) s.streamActive, 5.0, "stream on");

    sendCommand(const.CMD_REC_START, const.FLAG_OVERWRITE);
    waitForStatus(@(s) s.recordingActive, 8.0, "recording active");
    logLine("Recording active. Printing 1 Hz summary...");

    t0 = tic;
    while toc(t0) < recordSeconds
        pause(0.05);
        drawnow limitrate;

        if toc(lastSummaryTic) >= 1.0
            printSummary();
            lastSummaryTic = tic;
        end
    end

    logLine("Stopping recording...");
    sendCommand(const.CMD_STREAM_OFF);
    sendCommand(const.CMD_REC_STOP);
    waitForStatus(@(s) ~s.recordingActive && ~s.streamActive, 8.0, "recording stopped");
    sendCommand(const.CMD_STATUS);
    waitForStatus(@(~) true, 3.0, "final status");

    printSummary();

    out = struct();
    out.deviceId = char(deviceId);
    out.recordSeconds = recordSeconds;
    out.status = status;
    out.lastAck = lastAck;
    out.mlxRx = mlxRx;
    out.imuRx = imuRx;
    out.metaRx = metaRx;
    out.timestamp = char(datetime('now'));

    logLine(sprintf("Done. mlxRx=%d imuRx=%d metaRx=%d bytes=%s mlx=%s imu=%s", ...
        mlxRx, imuRx, metaRx, ...
        num2str(status.bytesWritten), ...
        num2str(status.mlxCount), ...
        num2str(status.imuCount)));

    function onMetaData(src, ~)
        [data, ~] = read(src, 'oldest');
        data = uint8(data);
        if isempty(data)
            return;
        end

        metaRx = metaRx + 1;
        pktType = data(1);

        if pktType == uint8(16) && numel(data) >= 44
            lastStatusRxTic = tic;
            status.streamActive = data(2) ~= 0;
            status.recordingActive = data(3) ~= 0;
            status.hasRecording = data(4) ~= 0;
            status.dirtyOpen = data(5) ~= 0;
            status.nandReady = data(6) ~= 0;
            status.bytesWritten = leU64(data, 9);
            status.mlxCount = leU64(data, 17);
            status.imuCount = leU64(data, 25);
            status.nextPage = leU32(data, 33);
            status.lastPage = leU32(data, 37);
            status.lastError = leI32(data, 41);
        elseif pktType == uint8(hex2dec('F0')) && numel(data) >= 6
            lastAck.cmd = data(2);
            lastAck.status = data(3);
            lastAck.rc = int16(typecast(uint8(data(5:6)), 'int16'));
            fprintf('[%s] ACK cmd=0x%02X rc=%d status=0x%02X\n', ...
                relTime(), lastAck.cmd, lastAck.rc, lastAck.status);
        else
            fprintf('[%s] META type=0x%02X len=%d\n', relTime(), pktType, numel(data));
        end
    end

    function onMlxData(src, ~)
        [data, ~] = read(src, 'oldest');
        data = uint8(data);
        if numel(data) < 12
            return;
        end

        mlxRx = mlxRx + 1;
        tMs = typecast(uint8(data(1:4)), 'uint32');
        vals = typecast(uint8(data(5:10)), 'int16');
        lastMlxDeviceMs = tMs(1);
        lastMlxSample = [double(vals(1)) double(vals(2)) double(vals(3))];
    end

    function onImuData(src, ~)
        [data, ~] = read(src, 'oldest');
        data = uint8(data);
        if numel(data) < 16
            return;
        end

        imuRx = imuRx + 1;
        tMs = typecast(uint8(data(1:4)), 'uint32');
        vals = typecast(uint8(data(5:16)), 'int16');
        lastImuDeviceMs = tMs(1);
        lastImuSample = double(vals(:)).';
    end

    function sendCommand(cmd, varargin)
        payload = uint8([cmd varargin{:}]);
        fprintf('[%s] CTRL cmd=0x%02X len=%d\n', relTime(), payload(1), numel(payload));
        write(ctrlChar, payload, "uint8");
    end

    function s = relTime()
        if isempty(startTic)
            s = "t+0.000";
        else
            s = sprintf('t+%.3f', toc(startTic));
        end
    end

    function printSummary()
        mlxDelta = mlxRx - summary.mlxPrinted;
        imuDelta = imuRx - summary.imuPrinted;
        bytesDelta = double(status.bytesWritten - summary.lastBytes);
        mlxCountDelta = double(status.mlxCount - summary.lastMlxCount);
        imuCountDelta = double(status.imuCount - summary.lastImuCount);
        mlxDeviceDeltaMs = double(lastMlxDeviceMs - summary.lastMlxDeviceMs);
        imuDeviceDeltaMs = double(lastImuDeviceMs - summary.lastImuDeviceMs);
        mlxLiveHz = 0;
        imuLiveHz = 0;
        mlxRecordedHz = 0;
        imuRecordedHz = 0;
        if mlxDeviceDeltaMs > 0
            mlxLiveHz = 1000 * mlxDelta / mlxDeviceDeltaMs;
            mlxRecordedHz = 1000 * mlxCountDelta / mlxDeviceDeltaMs;
        end
        if imuDeviceDeltaMs > 0
            imuLiveHz = 1000 * imuDelta / imuDeviceDeltaMs;
            imuRecordedHz = 1000 * imuCountDelta / imuDeviceDeltaMs;
        end

        fprintf(['[%s] SUMMARY stream=%d rec=%d has=%d bytes=%s (+%.0f) ' ...
                 'mlx=%s (+%.0f, %.1fHz) imu=%s (+%.0f, %.1fHz) ' ...
                 'live_mlx=%d (%.1fHz) live_imu=%d (%.1fHz) ack=0x%02X/%d\n'], ...
            relTime(), ...
            status.streamActive, ...
            status.recordingActive, ...
            status.hasRecording, ...
            num2str(status.bytesWritten), ...
            bytesDelta, ...
            num2str(status.mlxCount), ...
            mlxCountDelta, ...
            mlxRecordedHz, ...
            num2str(status.imuCount), ...
            imuCountDelta, ...
            imuRecordedHz, ...
            mlxDelta, ...
            mlxLiveHz, ...
            imuDelta, ...
            imuLiveHz, ...
            lastAck.cmd, ...
            lastAck.rc);

        if ~all(isnan(lastMlxSample))
            fprintf('[%s] LAST_MLX t=%u x=%d y=%d z=%d\n', ...
                relTime(), lastMlxDeviceMs, ...
                round(lastMlxSample(1)), round(lastMlxSample(2)), round(lastMlxSample(3)));
        end
        if ~all(isnan(lastImuSample))
            fprintf('[%s] LAST_IMU t=%u ax=%d ay=%d az=%d gx=%d gy=%d gz=%d\n', ...
                relTime(), lastImuDeviceMs, ...
                round(lastImuSample(1)), round(lastImuSample(2)), round(lastImuSample(3)), ...
                round(lastImuSample(4)), round(lastImuSample(5)), round(lastImuSample(6)));
        end

        summary.mlxPrinted = mlxRx;
        summary.imuPrinted = imuRx;
        summary.lastBytes = status.bytesWritten;
        summary.lastMlxCount = status.mlxCount;
        summary.lastImuCount = status.imuCount;
        summary.lastMlxDeviceMs = lastMlxDeviceMs;
        summary.lastImuDeviceMs = lastImuDeviceMs;
    end

    function waitForStatus(pred, timeoutSec, tag)
        tWait = tic;
        while toc(tWait) < timeoutSec
            pause(0.05);
            drawnow limitrate;
            if ~isempty(lastStatusRxTic) && pred(status)
                fprintf('[%s] STATE OK: %s\n', relTime(), tag);
                return;
            end
        end
        error('Timed out waiting for %s.', tag);
    end

    function cleanupAll()
        try
            if ~isempty(streamChar)
                unsubscribe(streamChar);
            end
        catch
        end
        try
            if ~isempty(imuChar)
                unsubscribe(imuChar);
            end
        catch
        end
        try
            if ~isempty(metaChar)
                unsubscribe(metaChar);
            end
        catch
        end

        try
            streamChar.DataAvailableFcn = [];
        catch
        end
        try
            imuChar.DataAvailableFcn = [];
        catch
        end
        try
            metaChar.DataAvailableFcn = [];
        catch
        end

        try
            metaChar = [];
            streamChar = [];
            imuChar = [];
            ctrlChar = [];
            bleObj = [];
        catch
        end
    end
end

function const = makeConsts()
    const.SERVICE_UUID     = "a0a4e690-96be-4222-b41e-98ea76b0120c";
    const.CHAR_STREAM_UUID = "a0a4e691-96be-4222-b41e-98ea76b0120c";
    const.CHAR_CTRL_UUID   = "a0a4e692-96be-4222-b41e-98ea76b0120c";
    const.CHAR_IMU_UUID    = "a0a4e693-96be-4222-b41e-98ea76b0120c";
    const.CHAR_META_UUID   = "a0a4e695-96be-4222-b41e-98ea76b0120c";

    const.CMD_STREAM_OFF = uint8(1);
    const.CMD_STREAM_ON  = uint8(2);
    const.CMD_REC_START  = uint8(16);
    const.CMD_REC_STOP   = uint8(17);
    const.CMD_STATUS     = uint8(33);
    const.FLAG_OVERWRITE = uint8(1);
end

function v = leU32(data, idx1)
    v = typecast(uint8(data(idx1:idx1+3)), 'uint32');
    v = v(1);
end

function v = leI32(data, idx1)
    v = typecast(uint8(data(idx1:idx1+3)), 'int32');
    v = v(1);
end

function v = leU64(data, idx1)
    v = typecast(uint8(data(idx1:idx1+7)), 'uint64');
    v = v(1);
end

function logLine(msg)
    ts = datestr(now, 'yyyy-mm-dd HH:MM:SS');
    fprintf('[%s] %s\n', ts, msg);
end
