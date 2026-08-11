function out = mechanical_sensor_record_cycle(deviceId, recordSeconds)
% Minimal control cycle for RTT-assisted debugging:
%   STATUS -> ERASE -> STREAM_ON -> REC_START(overwrite) -> wait -> REC_STOP -> STREAM_OFF -> STATUS

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

    logLine("MechanicalSensor record cycle");
    logLine(sprintf("device=%s", deviceId));
    logLine(sprintf("recordSeconds=%.1f", recordSeconds));

    bleObj = ble(deviceId);
    ctrlChar = characteristic(bleObj, const.SERVICE_UUID, const.CHAR_CTRL_UUID);
    metaChar = characteristic(bleObj, const.SERVICE_UUID, const.CHAR_META_UUID);

    pause(0.5);
    requestStatus("initial");

    sendCommand(const.CMD_ERASE);
    waitForStatus(@(s) ~s.recordingActive && ~s.hasRecording && s.bytesWritten == 0, 15.0, "erase");

    sendCommand(const.CMD_STREAM_ON);
    waitForStatus(@(s) s.streamActive, 15.0, "stream_on");

    sendCommand(const.CMD_REC_START, const.FLAG_OVERWRITE);
    waitForStatus(@(s) s.recordingActive, 20.0, "rec_start");

    logLine(sprintf("Sleeping %.1f s while recording...", recordSeconds));
    pause(recordSeconds);

    requestStatus("mid_record");

    sendCommand(const.CMD_REC_STOP);
    waitForStatus(@(s) ~s.recordingActive && s.hasRecording, 20.0, "rec_stop");

    sendCommand(const.CMD_STREAM_OFF);
    waitForStatus(@(s) ~s.streamActive, 15.0, "stream_off");

    finalStatus = requestStatus("final");

    out = struct();
    out.deviceId = char(deviceId);
    out.recordSeconds = recordSeconds;
    out.finalStatus = finalStatus;
    out.timestamp = char(datetime('now'));

    logLine("Cycle complete.");

    function st = requestStatus(tag)
        if nargin < 1
            tag = "status";
        end

        logLine(sprintf("STATUS request: %s", tag));
        sendCommand(const.CMD_STATUS);

        t0 = tic;
        while toc(t0) < 12.0
            pause(0.2);
            try
                data = read(metaChar);
            catch
                data = [];
            end

            if isempty(data)
                continue;
            end

            data = uint8(data);
            logLine(sprintf("read(meta): len=%d first=0x%02X", numel(data), data(1)));
            if numel(data) < 48 || data(1) ~= uint8(16)
                continue;
            end

            st = parseStatus(data);
            logStatus(st, string(tag));
            return;
        end

        error("Timed out waiting for STATUS (%s).", tag);
    end

    function waitForStatus(pred, timeoutSec, tag)
        t0 = tic;
        while toc(t0) < timeoutSec
            st = requestStatus(tag);
            ok = pred(st);
            logLine(sprintf("%s check: pass=%d", tag, ok));
            if ok
                return;
            end
            pause(0.25);
        end
        error("Timed out waiting for state: %s.", tag);
    end

    function sendCommand(cmd, varargin)
        bytes = uint8([cmd varargin{:}]);
        logLine(sprintf("write ctrl cmd=0x%02X len=%d", bytes(1), numel(bytes)));
        write(ctrlChar, bytes, "uint8");
    end

    function st = parseStatus(data)
        st = struct();
        st.streamActive = data(2) ~= 0;
        st.recordingActive = data(3) ~= 0;
        st.hasRecording = data(4) ~= 0;
        st.dirtyOpen = data(5) ~= 0;
        st.nandReady = data(6) ~= 0;
        st.bytesWritten = leU64(data, 9);
        st.mlxCount = leU64(data, 17);
        st.imuCount = leU64(data, 25);
        st.nextPage = leU32(data, 33);
        st.lastPage = leU32(data, 37);
        st.lastError = leI32(data, 41);
    end

    function logStatus(st, tag)
        logLine(sprintf([ ...
            'STATUS[%s]: stream=%d rec=%d has=%d dirty=%d nand=%d bytes=%s mlx=%s imu=%s next=%u last=%u err=%d'], ...
            char(tag), ...
            st.streamActive, ...
            st.recordingActive, ...
            st.hasRecording, ...
            st.dirtyOpen, ...
            st.nandReady, ...
            num2str(st.bytesWritten), ...
            num2str(st.mlxCount), ...
            num2str(st.imuCount), ...
            st.nextPage, ...
            st.lastPage, ...
            st.lastError));
    end

    function cleanupAll()
        try
            %#ok<NASGU>
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

    const.CMD_STREAM_OFF = uint8(1);
    const.CMD_STREAM_ON  = uint8(2);
    const.CMD_REC_START  = uint8(16);
    const.CMD_REC_STOP   = uint8(17);
    const.CMD_ERASE      = uint8(20);
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
