function out = mechanical_sensor_record_minimal(deviceId, recordSeconds)
% Minimal recording benchmark:
%   - Connect BLE
%   - Do NOT enable live stream notifications
%   - REC_START(overwrite)
%   - Wait
%   - REC_STOP
%   - Print final recorded counts and effective rates
%
% Example:
%   out = mechanical_sensor_record_minimal("mech50", 5);

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
    metaRx = 0;
    startTic = [];
    lastStatusRxTic = [];
    statusSeq = uint64(0);

    logLine("MechanicalSensor minimal recorder");
    logLine(sprintf("device=%s", deviceId));
    logLine(sprintf("recordSeconds=%.1f", recordSeconds));

    bleObj = ble(deviceId);
    ctrlChar = characteristic(bleObj, const.SERVICE_UUID, const.CHAR_CTRL_UUID);
    metaChar = characteristic(bleObj, const.SERVICE_UUID, const.CHAR_META_UUID);

    metaChar.DataAvailableFcn = @onMetaData;
    subscribe(metaChar, "notification");

    pause(0.4);
    startTic = tic;

    sendCommand(const.CMD_STATUS);
    waitForFreshStatus(@(~) true, 3.0, "initial status");
    preStartStatus = status;

    sendCommand(const.CMD_REC_START, const.FLAG_OVERWRITE);
    waitForFreshStatus(@(s) s.recordingActive, 5.0, "recording active");
    initialStatus = status;
    logLine("Recording active.");

    pause(recordSeconds);

    logLine("Stopping recording...");
    sendCommand(const.CMD_REC_STOP);
    waitForFreshStatus(@(s) ~s.recordingActive, 5.0, "recording stopped");

    sendCommand(const.CMD_STATUS);
    waitForFreshStatus(@(~) true, 3.0, "final status");
    finalStatus = status;

    mlxDelta = double(finalStatus.mlxCount - initialStatus.mlxCount);
    imuDelta = double(finalStatus.imuCount - initialStatus.imuCount);
    bytesDelta = double(finalStatus.bytesWritten - initialStatus.bytesWritten);

    out = struct();
    out.deviceId = char(deviceId);
    out.recordSeconds = recordSeconds;
    out.preStartStatus = preStartStatus;
    out.initialStatus = initialStatus;
    out.finalStatus = finalStatus;
    out.lastAck = lastAck;
    out.metaRx = metaRx;
    out.mlxRateHz = mlxDelta / recordSeconds;
    out.imuRateHz = imuDelta / recordSeconds;
    out.bytesPerSec = bytesDelta / recordSeconds;
    out.timestamp = char(datetime('now'));

    fprintf('[%s] FINAL bytes=%s (+%.0f, %.1f B/s) mlx=%s (+%.0f, %.1f Hz) imu=%s (+%.0f, %.1f Hz) err=%d\n', ...
        relTime(), ...
        num2str(finalStatus.bytesWritten), ...
        bytesDelta, ...
        out.bytesPerSec, ...
        num2str(finalStatus.mlxCount), ...
        mlxDelta, ...
        out.mlxRateHz, ...
        num2str(finalStatus.imuCount), ...
        imuDelta, ...
        out.imuRateHz, ...
        finalStatus.lastError);

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
            statusSeq = statusSeq + 1;
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
        end
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

    function waitForFreshStatus(pred, timeoutSec, tag)
        tWait = tic;
        startSeq = statusSeq;
        while toc(tWait) < timeoutSec
            pause(0.05);
            drawnow limitrate;
            if statusSeq > startSeq && ~isempty(lastStatusRxTic) && pred(status)
                fprintf('[%s] STATE OK: %s\n', relTime(), tag);
                return;
            end
        end
        error('Timed out waiting for %s.', tag);
    end

    function cleanupAll()
        try
            if ~isempty(metaChar)
                unsubscribe(metaChar);
            end
        catch
        end
        try
            metaChar.DataAvailableFcn = [];
        catch
        end
        try
            metaChar = [];
            ctrlChar = [];
            bleObj = [];
        catch
        end
    end
end

function const = makeConsts()
    const.SERVICE_UUID   = "a0a4e690-96be-4222-b41e-98ea76b0120c";
    const.CHAR_CTRL_UUID = "a0a4e692-96be-4222-b41e-98ea76b0120c";
    const.CHAR_META_UUID = "a0a4e695-96be-4222-b41e-98ea76b0120c";

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
