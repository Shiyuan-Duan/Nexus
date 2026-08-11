function report = mechanical_sensor_nand_selftest(deviceId, outputDir)
% End-to-end NAND workflow self-test for the MechanicalSensor BLE device.
%
% This validates the workflow we actually depend on:
%   status -> erase -> live stream -> recording -> host disconnect ->
%   reconnect -> still recording -> stop -> download -> parse/verify.
%
% It cannot mathematically guarantee future correctness, but it is designed
% to catch the concrete NAND/recording/download failures that matter for
% this product flow.

    if nargin < 1 || strlength(string(deviceId)) == 0
        deviceId = "mech50";
    else
        deviceId = string(deviceId);
    end

    if nargin < 2 || strlength(string(outputDir)) == 0
        picked = uigetdir(pwd, 'Select output folder for NAND self-test artifacts');
        if isequal(picked, 0)
            error('Output folder selection was cancelled.');
        end
        outputDir = string(picked);
    else
        outputDir = string(outputDir);
    end

    if ~isfolder(outputDir)
        mkdir(outputDir);
    end

    const = makeConsts();
    state = initState(outputDir, deviceId);
    cleanupObj = onCleanup(@()cleanupAll()); %#ok<NASGU>

    logLine('MechanicalSensor NAND self-test');
    logLine(sprintf('device=%s', deviceId));
    logLine(sprintf('outputDir=%s', outputDir));

    runStep('Connect and query status', @stepConnectAndStatus);
    runStep('Verify NAND ready', @stepVerifyNandReady);
    runStep('Erase previous recording', @stepEraseExisting);
    runStep('Verify empty state after erase', @stepVerifyErasedState);
    runStep('Start live stream and recording', @stepStartRecording);
    runStep('Verify recording counters increase', @stepVerifyRecordingProgress);
    runStep('Host disconnect while recording', @stepDisconnectWhileRecording);
    runStep('Reconnect and verify recording continues', @stepReconnectAndVerify);
    runStep('Stop recording cleanly', @stepStopRecording);
    runStep('Verify closed recording state', @stepVerifyStoppedState);
    runStep('Download recording', @stepDownloadRecording);
    runStep('Verify downloaded content', @stepVerifyDownload);
    runStep('Optional erase-after-test verification', @stepFinalErase);

    state.report.completed = true;
    state.report.finishedAt = datetime('now');
    state.report.outputBase = char(state.downloadBase);
    state.report.statusAtEnd = state.status;
    state.report.mlxLivePackets = state.mlxLivePackets;
    state.report.imuLivePackets = state.imuLivePackets;
    state.report.downloadFrames = state.downloadFrames;
    state.report.downloadMlxCount = state.downloadMlxCount;
    state.report.downloadImuCount = state.downloadImuCount;
    state.report.result = 'PASS';

    writeReportFile();
    report = state.report;
    logLine('SELF-TEST PASS');

    function stepConnectAndStatus()
        connectDevice();
        requestStatus();
        waitFor(@() state.statusSeen, 5.0, 'Timed out waiting for initial STATUS packet.');
    end

    function stepVerifyNandReady()
        assertTrue(state.status.nandReady, 'Device reports nandReady=0.');
        if state.status.lastError ~= 0
            logLine(sprintf('Initial device lastError=%d; continuing to erase/reset state.', ...
                state.status.lastError));
        end
    end

    function stepEraseExisting()
        sendCommand(const.CMD_ERASE);
        waitForErasedState(12.0);
    end

    function stepVerifyErasedState()
        assertTrue(~state.status.recordingActive, 'Recording is active after erase.');
        assertTrue(~state.status.hasRecording, 'hasRecording stayed true after erase.');
        assertTrue(state.status.bytesWritten == 0, 'bytesWritten is not zero after erase.');
        assertTrue(state.status.mlxCount == 0, 'mlxCount is not zero after erase.');
        assertTrue(state.status.imuCount == 0, 'imuCount is not zero after erase.');
        assertTrue(state.status.lastError == 0, sprintf('lastError is not zero after erase: %d.', ...
            state.status.lastError));
    end

    function stepStartRecording()
        ensureLiveSubscriptions();
        sendCommand(const.CMD_STREAM_ON);
        waitForStreamOn(15.0);
        pause(0.5);
        sendCommand(const.CMD_REC_START, const.FLAG_OVERWRITE);
        waitForRecordingOn(20.0);
        state.recordingStartStatus = state.status;
        state.recordingStartMlxLive = state.mlxLivePackets;
        state.recordingStartImuLive = state.imuLivePackets;
    end

    function stepVerifyRecordingProgress()
        baseline = state.status;
        t0 = tic;
        while toc(t0) < 8.0
            pause(1.0);
            requestStatus();
            growing = state.status.bytesWritten > baseline.bytesWritten || ...
                      state.status.mlxCount > baseline.mlxCount || ...
                      state.status.imuCount > baseline.imuCount;
            logLine(sprintf(['REC progress: stream=%d rec=%d bytes=%s->%s mlx=%s->%s imu=%s->%s grow=%d'], ...
                baseline.streamActive, ...
                state.status.recordingActive, ...
                num2str(baseline.bytesWritten), ...
                num2str(state.status.bytesWritten), ...
                num2str(baseline.mlxCount), ...
                num2str(state.status.mlxCount), ...
                num2str(baseline.imuCount), ...
                num2str(state.status.imuCount), ...
                growing));
            if state.status.streamActive && state.status.recordingActive && growing
                state.preDisconnectStatus = state.status;
                return;
            end
        end
        error('Recording counters did not increase while connected.');
    end

    function stepDisconnectWhileRecording()
        disconnectDevice();
        pause(3.0);
    end

    function stepReconnectAndVerify()
        connectDevice();
        requestStatus();
        waitFor(@() state.statusSeen, 5.0, 'Timed out waiting for STATUS after reconnect.');
        assertTrue(state.status.recordingActive, 'Device was not still recording after reconnect.');
        pause(3.0);
        requestStatus();
        waitFor(@() state.status.bytesWritten > state.preDisconnectStatus.bytesWritten || ...
                    state.status.mlxCount > state.preDisconnectStatus.mlxCount || ...
                    state.status.imuCount > state.preDisconnectStatus.imuCount, ...
                6.0, 'Recording counters did not advance across host disconnect/reconnect.');
    end

    function stepStopRecording()
        sendCommand(const.CMD_REC_STOP);
        waitForRecordingOff(15.0);
        sendCommand(const.CMD_STREAM_OFF);
        waitForStreamOff(15.0);
    end

    function stepVerifyStoppedState()
        assertTrue(~state.status.recordingActive, 'recordingActive stayed true after stop.');
        assertTrue(state.status.hasRecording, 'hasRecording is false after stop.');
        assertTrue(state.status.bytesWritten > 0, 'bytesWritten is zero after stop.');
        assertTrue(state.status.mlxCount > 0, 'mlxCount is zero after stop.');
        assertTrue(state.status.imuCount > 0, 'imuCount is zero after stop.');
        state.finalRecordedStatus = state.status;
    end

    function stepDownloadRecording()
        timestamp = string(datestr(now, 'yyyymmdd_HHMMSS'));
        state.downloadBase = fullfile(outputDir, "mechanical_nand_selftest_" + timestamp);
        openDownloadFiles();
        state.downloadActive = true;
        state.downloadDone = false;
        state.downloadRemain = uint8([]);
        state.downloadFrames = 0;
        state.downloadMlxCount = 0;
        state.downloadImuCount = 0;
        state.downloadBytesReceived = 0;
        subscribe(state.fileChar, "notification");
        sendCommand(const.CMD_DOWNLOAD);
        waitFor(@() state.downloadBytesReceived >= double(state.finalRecordedStatus.bytesWritten), ...
            60.0, 'Download did not reach expected byte count.');
        finishDownload();
    end

    function stepVerifyDownload()
        binInfo = dir(char(state.downloadBase + ".bin"));
        mlxInfo = dir(char(state.downloadBase + "_mlx97.csv"));
        imuInfo = dir(char(state.downloadBase + "_imu.csv"));

        assertTrue(~isempty(binInfo) && binInfo.bytes > 0, 'Downloaded .bin file is missing or empty.');
        assertTrue(~isempty(mlxInfo) && mlxInfo.bytes > 0, 'Downloaded MLX CSV is missing or empty.');
        assertTrue(~isempty(imuInfo) && imuInfo.bytes > 0, 'Downloaded IMU CSV is missing or empty.');

        assertTrue(state.downloadMlxCount == double(state.finalRecordedStatus.mlxCount), ...
            sprintf('MLX count mismatch: downloaded=%d device=%s.', ...
            state.downloadMlxCount, num2str(state.finalRecordedStatus.mlxCount)));
        assertTrue(state.downloadImuCount == double(state.finalRecordedStatus.imuCount), ...
            sprintf('IMU count mismatch: downloaded=%d device=%s.', ...
            state.downloadImuCount, num2str(state.finalRecordedStatus.imuCount)));

        assertTrue(binInfo.bytes == double(state.finalRecordedStatus.bytesWritten), ...
            sprintf('BIN size mismatch: file=%d device=%s.', ...
            binInfo.bytes, num2str(state.finalRecordedStatus.bytesWritten)));
    end

    function stepFinalErase()
        sendCommand(const.CMD_ERASE);
        pollStatusUntil(@() ~state.status.recordingActive && ~state.status.hasRecording && state.status.bytesWritten == 0, ...
            12.0, 'Final erase did not return the device to empty state.');
    end

    function runStep(name, fn)
        logLine(['STEP: ' char(name)]);
        try
            fn();
            state.stepResults(end+1) = struct('name', string(name), 'result', "PASS", 'detail', ""); %#ok<AGROW>
            logLine(['PASS: ' char(name)]);
        catch err
            state.stepResults(end+1) = struct('name', string(name), 'result', "FAIL", 'detail', string(err.message)); %#ok<AGROW>
            state.report.completed = false;
            state.report.finishedAt = datetime('now');
            state.report.result = 'FAIL';
            state.report.failureStep = char(name);
            state.report.failureMessage = err.message;
            try
                writeReportFile();
            catch
            end
            rethrow(err);
        end
    end

    function connectDevice()
        if ~isempty(state.bleObj)
            return;
        end

        state.statusSeen = false;
        state.lastAckCmd = [];
        state.lastAckRc = [];
        state.downloadDone = false;

        state.bleObj = ble(deviceId);
        state.ctrlChar = characteristic(state.bleObj, const.SVC_UUID, const.CHAR_CTRL);
        state.streamChar = characteristic(state.bleObj, const.SVC_UUID, const.CHAR_STREAM);
        state.imuChar = characteristic(state.bleObj, const.SVC_UUID, const.CHAR_IMU);
        state.fileChar = characteristic(state.bleObj, const.SVC_UUID, const.CHAR_FILE);
        state.metaChar = characteristic(state.bleObj, const.SVC_UUID, const.CHAR_META);

        state.fileChar.DataAvailableFcn = @onFileData;
        pause(0.5);
    end

    function disconnectDevice()
        tryStopNotify(state.streamChar);
        tryStopNotify(state.imuChar);
        tryStopNotify(state.fileChar);
        tryStopNotify(state.metaChar);

        state.streamChar = [];
        state.imuChar = [];
        state.fileChar = [];
        state.metaChar = [];
        state.ctrlChar = [];
        state.bleObj = [];
        state.liveSubscribed = false;
        state.statusSeen = false;
    end

    function cleanupAll()
        try
            if state.downloadActive
                finishDownload();
            end
        catch
        end
        try
            disconnectDevice();
        catch
        end
    end

    function ensureLiveSubscriptions()
        if state.liveSubscribed
            return;
        end
        state.liveSubscribed = true;
    end

    function sendCommand(cmd, flags)
        if nargin < 2
            flags = [];
        end
        payload = uint8(cmd);
        if ~isempty(flags)
            payload(2) = uint8(flags);
        end
        state.lastAckCmd = [];
        state.lastAckRc = [];
        logLine(sprintf('write ctrl cmd=0x%02X len=%d', payload(1), numel(payload)));
        write(state.ctrlChar, payload, "uint8");
    end

    function requestStatus()
        for attempt = 1:3
            state.statusSeen = false;
            logLine(sprintf('STATUS attempt %d', attempt));
            sendCommand(const.CMD_STATUS);
            try
                waitFor(@() fetchStatusSnapshot(), 2.5, 'Timed out waiting for STATUS response.');
                return;
            catch
                pause(0.4);
            end
        end
        error('Timed out waiting for STATUS response after 3 attempts.');
    end

    function pollStatusUntil(predicateFn, timeoutSec, failMsg)
        t0 = tic;
        while toc(t0) < timeoutSec
            requestStatus();
            if predicateFn()
                return;
            end
            pause(0.25);
        end
        error(failMsg);
    end

    function waitForErasedState(timeoutSec)
        t0 = tic;
        while toc(t0) < timeoutSec
            requestStatus();
            isErased = (~state.status.recordingActive) && ...
                       (~state.status.hasRecording) && ...
                       (double(state.status.bytesWritten) == 0) && ...
                       (double(state.status.mlxCount) == 0) && ...
                       (double(state.status.imuCount) == 0) && ...
                       (state.status.lastError == 0);
            logLine(sprintf(['ERASE check: rec=%d has=%d bytes=%s mlx=%s imu=%s err=%d pass=%d'], ...
                state.status.recordingActive, ...
                state.status.hasRecording, ...
                num2str(state.status.bytesWritten), ...
                num2str(state.status.mlxCount), ...
                num2str(state.status.imuCount), ...
                state.status.lastError, ...
                isErased));
            if isErased
                return;
            end
            pause(0.25);
        end
        error('Erase did not produce an empty state.');
    end

    function waitForStreamOn(timeoutSec)
        t0 = tic;
        while toc(t0) < timeoutSec
            requestStatus();
            isOn = state.status.streamActive;
            logLine(sprintf('STREAM check: stream=%d pass=%d', ...
                state.status.streamActive, isOn));
            if isOn
                return;
            end
            pause(0.25);
        end
        error('Live stream did not become active.');
    end

    function waitForRecordingOn(timeoutSec)
        t0 = tic;
        while toc(t0) < timeoutSec
            requestStatus();
            isOn = state.status.recordingActive;
            logLine(sprintf(['REC check: stream=%d rec=%d has=%d dirty=%d bytes=%s mlx=%s imu=%s err=%d pass=%d'], ...
                state.status.streamActive, ...
                state.status.recordingActive, ...
                state.status.hasRecording, ...
                state.status.dirtyOpen, ...
                num2str(state.status.bytesWritten), ...
                num2str(state.status.mlxCount), ...
                num2str(state.status.imuCount), ...
                state.status.lastError, ...
                isOn));
            if isOn
                return;
            end
            pause(0.25);
        end
        error('Recording state did not become active.');
    end

    function waitForRecordingOff(timeoutSec)
        t0 = tic;
        while toc(t0) < timeoutSec
            requestStatus();
            isOff = (~state.status.recordingActive) && state.status.hasRecording;
            logLine(sprintf(['REC STOP check: stream=%d rec=%d has=%d dirty=%d bytes=%s imu=%s err=%d pass=%d'], ...
                state.status.streamActive, ...
                state.status.recordingActive, ...
                state.status.hasRecording, ...
                state.status.dirtyOpen, ...
                num2str(state.status.bytesWritten), ...
                num2str(state.status.imuCount), ...
                state.status.lastError, ...
                isOff));
            if isOff
                return;
            end
            pause(0.25);
        end
        error('Recording did not stop cleanly.');
    end

    function waitForStreamOff(timeoutSec)
        t0 = tic;
        while toc(t0) < timeoutSec
            requestStatus();
            isOff = ~state.status.streamActive;
            logLine(sprintf('STREAM OFF check: stream=%d pass=%d', ...
                state.status.streamActive, isOff));
            if isOff
                return;
            end
            pause(0.25);
        end
        error('Stream did not stop cleanly.');
    end

    function waitFor(predicateFn, timeoutSec, failMsg)
        t0 = tic;
        while toc(t0) < timeoutSec
            pumpBle();
            drawnow;
            if predicateFn()
                return;
            end
            pause(0.05);
        end
        error(failMsg);
    end

    function onMetaData(src, ~)
        [data, ~] = read(src, 'oldest');
        handleMetaPacket(data);
    end

    function handleMetaPacket(data)
        if isempty(data)
            return;
        end

        data = uint8(data);
        pktType = data(1);
        switch pktType
            case uint8(16)
                if numel(data) >= 44
                    state.status.streamActive = data(2) ~= 0;
                    state.status.recordingActive = data(3) ~= 0;
                    state.status.hasRecording = data(4) ~= 0;
                    state.status.dirtyOpen = data(5) ~= 0;
                    state.status.nandReady = data(6) ~= 0;
                    state.status.bytesWritten = leU64(data, 9);
                    state.status.mlxCount = leU64(data, 17);
                    state.status.imuCount = leU64(data, 25);
                    state.status.nextPage = leU32(data, 33);
                    state.status.lastPage = leU32(data, 37);
                    state.status.lastError = leI32(data, 41);
                    state.statusSeen = true;
                    logLine(sprintf(['STATUS parsed: stream=%d rec=%d has=%d dirty=%d nand=%d ' ...
                        'bytes=%s mlx=%s imu=%s next=%u last=%u err=%d'], ...
                        state.status.streamActive, ...
                        state.status.recordingActive, ...
                        state.status.hasRecording, ...
                        state.status.dirtyOpen, ...
                        state.status.nandReady, ...
                        num2str(state.status.bytesWritten), ...
                        num2str(state.status.mlxCount), ...
                        num2str(state.status.imuCount), ...
                        state.status.nextPage, ...
                        state.status.lastPage, ...
                        state.status.lastError));
                end
            case uint8(hex2dec('F0'))
                if numel(data) >= 6
                    state.lastAckCmd = data(2);
                    state.lastAckRc = int16(typecast(uint8(data(5:6)), 'int16'));
                end
            case uint8(3)
                state.downloadDone = true;
            otherwise
        end
    end

    function onFileData(src, ~)
        [data, ~] = read(src, 'oldest');
        handleFilePacket(data);
    end

    function handleFilePacket(data)
        if isempty(data) || ~state.downloadActive
            return;
        end

        fwrite(state.downloadBinId, uint8(data), 'uint8');
        state.downloadBytesReceived = state.downloadBytesReceived + numel(data);
        state.downloadRemain = [state.downloadRemain; uint8(data(:))]; %#ok<AGROW>

        while numel(state.downloadRemain) >= 2
            recType = state.downloadRemain(1);
            payloadLen = double(state.downloadRemain(2));
            totalLen = 2 + payloadLen;
            if numel(state.downloadRemain) < totalLen
                break;
            end

            payload = state.downloadRemain(3:totalLen);
            state.downloadRemain(1:totalLen) = [];
            state.downloadFrames = state.downloadFrames + 1;
            writeDownloadRecord(recType, payload);
        end
    end

    function pumpBle()
        pollLiveReads();
        drainFile();
    end

    function pollLiveReads()
        if ~state.liveSubscribed
            return;
        end

        if ~isempty(state.streamChar)
            try
                data = read(state.streamChar);
                if numel(data) >= 12
                    state.mlxLivePackets = state.mlxLivePackets + 1;
                end
            catch
            end
        end

        if ~isempty(state.imuChar)
            try
                data = read(state.imuChar);
                if numel(data) >= 16
                    state.imuLivePackets = state.imuLivePackets + 1;
                end
            catch
            end
        end
    end

    function drainFile()
        if isempty(state.fileChar) || ~state.downloadActive
            return;
        end
        for k = 1:8
            try
                [data, ~] = read(state.fileChar, 'oldest');
            catch
                break;
            end
            if isempty(data)
                break;
            end
            handleFilePacket(data);
        end
    end

    function ok = fetchStatusSnapshot()
        ok = false;
        if isempty(state.metaChar)
            return;
        end
        try
            data = read(state.metaChar);
        catch
            logLine('read(meta): failed');
            return;
        end
        if isempty(data)
            logLine('read(meta): empty');
            return;
        end
        logLine(sprintf('read(meta): len=%d first=0x%02X', numel(data), uint8(data(1))));
        handleMetaPacket(data);
        ok = state.statusSeen;
    end

    function openDownloadFiles()
        closeDownloadFiles();

        state.downloadBinId = fopen(char(state.downloadBase + ".bin"), 'w');
        state.downloadMlxId = fopen(char(state.downloadBase + "_mlx97.csv"), 'w');
        state.downloadImuId = fopen(char(state.downloadBase + "_imu.csv"), 'w');

        if state.downloadBinId < 0 || state.downloadMlxId < 0 || state.downloadImuId < 0
            closeDownloadFiles();
            error('Failed to open download output files.');
        end

        fprintf(state.downloadMlxId, 'host_time_iso,host_t_ms,t_ms_device,x,y,z,stat1,stat2\n');
        fprintf(state.downloadImuId, 'host_time_iso,host_t_ms,t_ms_device,ax_mg,ay_mg,az_mg,gx_dps_x10,gy_dps_x10,gz_dps_x10\n');
    end

    function writeDownloadRecord(recType, payload)
        hostTs = datetime('now', 'Format', 'yyyy-MM-dd HH:mm:ss.SSS');
        hostMs = posixtime(hostTs) * 1000;

        if recType == uint8(1) && numel(payload) == 12
            tMs = typecast(uint8(payload(1:4)), 'uint32');
            vals = typecast(uint8(payload(5:10)), 'int16');
            stat1 = payload(11);
            stat2 = payload(12);
            fprintf(state.downloadMlxId, '%s,%.3f,%u,%d,%d,%d,%u,%u\n', ...
                char(hostTs), hostMs, tMs(1), vals(1), vals(2), vals(3), stat1, stat2);
            state.downloadMlxCount = state.downloadMlxCount + 1;
        elseif recType == uint8(2) && numel(payload) == 16
            tMs = typecast(uint8(payload(1:4)), 'uint32');
            vals = typecast(uint8(payload(5:16)), 'int16');
            fprintf(state.downloadImuId, '%s,%.3f,%u,%d,%d,%d,%d,%d,%d\n', ...
                char(hostTs), hostMs, tMs(1), vals(1), vals(2), vals(3), vals(4), vals(5), vals(6));
            state.downloadImuCount = state.downloadImuCount + 1;
        else
            error('Malformed download record: type=%u payloadLen=%d.', recType, numel(payload));
        end
    end

    function finishDownload()
        if ~isempty(state.downloadRemain)
            error('Trailing download bytes remained undecoded: %d.', numel(state.downloadRemain));
        end
        state.downloadActive = false;
        closeDownloadFiles();
    end

    function closeDownloadFiles()
        if state.downloadBinId >= 0
            fclose(state.downloadBinId);
            state.downloadBinId = -1;
        end
        if state.downloadMlxId >= 0
            fclose(state.downloadMlxId);
            state.downloadMlxId = -1;
        end
        if state.downloadImuId >= 0
            fclose(state.downloadImuId);
            state.downloadImuId = -1;
        end
    end

    function tryStopNotify(ch)
        if isempty(ch)
            return;
        end
        try
            unsubscribe(ch);
        catch
        end
    end

    function assertTrue(tf, msg)
        if ~tf
            error(msg);
        end
    end

    function logLine(msg)
        stamp = char(datetime('now', 'Format', 'yyyy-MM-dd HH:mm:ss'));
        line = sprintf('[%s] %s', stamp, msg);
        disp(line);
        state.logLines{end+1} = line; %#ok<AGROW>
    end

    function writeReportFile()
        reportPath = fullfile(outputDir, sprintf('mechanical_nand_selftest_report_%s.txt', ...
            datestr(now, 'yyyymmdd_HHMMSS')));
        fid = fopen(reportPath, 'w');
        if fid < 0
            return;
        end
        c = onCleanup(@() fclose(fid)); %#ok<NASGU>

        fprintf(fid, 'MechanicalSensor NAND self-test report\n');
        fprintf(fid, 'device=%s\n', deviceId);
        fprintf(fid, 'result=%s\n', state.report.result);
        if isfield(state.report, 'failureStep')
            fprintf(fid, 'failureStep=%s\n', state.report.failureStep);
            fprintf(fid, 'failureMessage=%s\n', state.report.failureMessage);
        end
        fprintf(fid, '\nStep results:\n');
        for i = 1:numel(state.stepResults)
            fprintf(fid, '  %s: %s', state.stepResults(i).name, state.stepResults(i).result);
            if strlength(state.stepResults(i).detail) > 0
                fprintf(fid, ' | %s', state.stepResults(i).detail);
            end
            fprintf(fid, '\n');
        end
        fprintf(fid, '\nFinal status:\n');
        fprintf(fid, '  nandReady=%d\n', state.status.nandReady);
        fprintf(fid, '  recordingActive=%d\n', state.status.recordingActive);
        fprintf(fid, '  hasRecording=%d\n', state.status.hasRecording);
        fprintf(fid, '  dirtyOpen=%d\n', state.status.dirtyOpen);
        fprintf(fid, '  bytesWritten=%s\n', num2str(state.status.bytesWritten));
        fprintf(fid, '  mlxCount=%s\n', num2str(state.status.mlxCount));
        fprintf(fid, '  imuCount=%s\n', num2str(state.status.imuCount));
        fprintf(fid, '  nextPage=%u\n', state.status.nextPage);
        fprintf(fid, '  lastPage=%u\n', state.status.lastPage);
        fprintf(fid, '  lastError=%d\n', state.status.lastError);
        fprintf(fid, '\nLive packets:\n');
        fprintf(fid, '  mlx=%d\n', state.mlxLivePackets);
        fprintf(fid, '  imu=%d\n', state.imuLivePackets);
        fprintf(fid, '\nDownload:\n');
        fprintf(fid, '  frames=%d\n', state.downloadFrames);
        fprintf(fid, '  mlx=%d\n', state.downloadMlxCount);
        fprintf(fid, '  imu=%d\n', state.downloadImuCount);
        fprintf(fid, '  base=%s\n', stringOrEmpty(state.downloadBase));
        fprintf(fid, '\nLog:\n');
        for i = 1:numel(state.logLines)
            fprintf(fid, '%s\n', state.logLines{i});
        end
        state.report.reportPath = reportPath;
    end
end

function const = makeConsts()
    const.SVC_UUID   = "a0a4e690-96be-4222-b41e-98ea76b0120c";
    const.CHAR_STREAM = "a0a4e691-96be-4222-b41e-98ea76b0120c";
    const.CHAR_CTRL   = "a0a4e692-96be-4222-b41e-98ea76b0120c";
    const.CHAR_IMU    = "a0a4e693-96be-4222-b41e-98ea76b0120c";
    const.CHAR_FILE   = "a0a4e694-96be-4222-b41e-98ea76b0120c";
    const.CHAR_META   = "a0a4e695-96be-4222-b41e-98ea76b0120c";

    const.CMD_STREAM_OFF = uint8(1);
    const.CMD_STREAM_ON  = uint8(2);
    const.CMD_REC_START  = uint8(16);
    const.CMD_REC_STOP   = uint8(17);
    const.CMD_DOWNLOAD   = uint8(19);
    const.CMD_ERASE      = uint8(20);
    const.CMD_ABORT      = uint8(21);
    const.CMD_STATUS     = uint8(33);
    const.FLAG_OVERWRITE = uint8(1);
end

function state = initState(outputDir, deviceId)
    state = struct();
    state.outputDir = string(outputDir);
    state.deviceId = string(deviceId);
    state.bleObj = [];
    state.ctrlChar = [];
    state.streamChar = [];
    state.imuChar = [];
    state.fileChar = [];
    state.metaChar = [];
    state.liveSubscribed = false;
    state.statusSeen = false;
    state.lastAckCmd = [];
    state.lastAckRc = [];
    state.downloadActive = false;
    state.downloadDone = false;
    state.downloadRemain = uint8([]);
    state.downloadBinId = -1;
    state.downloadMlxId = -1;
    state.downloadImuId = -1;
    state.downloadBase = "";
    state.downloadFrames = 0;
    state.downloadMlxCount = 0;
    state.downloadImuCount = 0;
    state.downloadBytesReceived = 0;
    state.mlxLivePackets = 0;
    state.imuLivePackets = 0;
    state.stepResults = struct('name', {}, 'result', {}, 'detail', {});
    state.logLines = {};
    state.status = struct( ...
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
    state.report = struct('completed', false, 'result', 'FAIL');
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

function s = stringOrEmpty(x)
    if strlength(string(x)) == 0
        s = "";
    else
        s = string(x);
    end
end
