function mechanical_sensor_capture()
% GUI tool for MechanicalSensor BLE control, live view, recording, and download.

    if focus_existing_mechanical_sensor_console()
        return;
    end

    MLX97_SERVICE_UUID = "a0a4e690-96be-4222-b41e-98ea76b0120c";
    MLX97_CHAR_STREAM  = "a0a4e691-96be-4222-b41e-98ea76b0120c";
    MLX97_CHAR_CTRL    = "a0a4e692-96be-4222-b41e-98ea76b0120c";
    MLX97_CHAR_IMU     = "a0a4e693-96be-4222-b41e-98ea76b0120c";
    MLX97_CHAR_FILE    = "a0a4e694-96be-4222-b41e-98ea76b0120c";
    MLX97_CHAR_META    = "a0a4e695-96be-4222-b41e-98ea76b0120c";

    CMD_STREAM_OFF = uint8(1);
    CMD_STREAM_ON  = uint8(2);
    CMD_REC_START  = uint8(16);
    CMD_REC_STOP   = uint8(17);
    CMD_DOWNLOAD   = uint8(19);
    CMD_ERASE      = uint8(20);
    CMD_ABORT      = uint8(21);
    CMD_STATUS     = uint8(33);

    FLAG_OVERWRITE = uint8(1);

    plotWindowSec = 5;
    plotRefreshSec = 0.10;
    idleStatusPollSec = 2.5;
    connectStatusTimeoutSec = 2.0;
    statusCommandTimeoutSec = 2.0;
    recordStartTimeoutSec = 20.0;
    recordStopTimeoutSec = 20.0;
    downloadStallTimeoutSec = 10.0;
    downloadDoneGraceSec = 0.5;
    downloadHardTimeoutSec = inf;
    maxMlxPoints = 8000;
    maxImuPoints = 8000;
    maxPlotPoints = 220;
    flashTotalBytes = uint64((65536 - 64) * 2048);

    bleObj = [];
    ctrlChar = [];
    streamChar = [];
    imuChar = [];
    fileChar = [];
    metaChar = [];
    plotTimer = [];

    connected = false;
    connectBusy = false;
    liveSubscribed = false;
    downloadActive = false;
    downloadFinishedByMeta = false;
    downloadDoneSeenAt = NaN;
    downloadStartedAt = NaN;
    downloadLastDataAt = NaN;
    statusSeq = uint64(0);
    lastStatusPoll = NaN;
    lastAckCmd = uint8(0);
    lastAckRc = int16(0);

    downloadRemain = uint8([]);
    downloadBinId = -1;
    downloadMlxId = -1;
    downloadImuId = -1;
    downloadBasePath = "";
    downloadFrames = 0;
    downloadMlxCount = 0;
    downloadImuCount = 0;
    downloadBytesReceived = uint64(0);
    downloadDecodedBytes = uint64(0);
    downloadUnknownCount = uint64(0);
    downloadUnknownBytes = uint64(0);
    downloadUnknownLogCount = uint32(0);
    downloadDebugLastLogAt = NaN;
    plotTimeOriginSec = NaN;
    mlxPlotChannel = 'Z';

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

    mlxBufT = zeros(1, maxMlxPoints);
    mlxBufX = zeros(1, maxMlxPoints);
    mlxBufY = zeros(1, maxMlxPoints);
    mlxBufZ = zeros(1, maxMlxPoints);
    mlxBufN = 0;

    imuBufT = zeros(1, maxImuPoints);
    imuBufAx = zeros(1, maxImuPoints);
    imuBufAy = zeros(1, maxImuPoints);
    imuBufAz = zeros(1, maxImuPoints);
    imuBufGx = zeros(1, maxImuPoints);
    imuBufGy = zeros(1, maxImuPoints);
    imuBufGz = zeros(1, maxImuPoints);
    imuBufN = 0;

    [fig, controls, axesHandles, lineHandles] = createGui( ...
        @onConnect, @onStartLive, @onStopLive, @onStartRecording, ...
        @onStopRecording, @onDownload, @onErase, @onMlxChannelChanged);

    plotTimer = timer( ...
        'ExecutionMode', 'fixedSpacing', ...
        'BusyMode', 'drop', ...
        'Period', plotRefreshSec, ...
        'TimerFcn', @onUiTimer, ...
        'Tag', 'MechanicalSensorConsoleTimer');

    set(fig, 'CloseRequestFcn', @onCloseFigure);
    cleanupObj = onCleanup(@cleanupWrapper); %#ok<NASGU>

    setStatusHeader('Disconnected');
    updateStatusText();
    start(plotTimer);
    waitfor(fig);

    function onConnect(~, ~)
        if connectBusy
            return;
        end

        if connected
            disconnectDevice();
            setStatusHeader('Disconnected');
            updateStatusText();
            return;
        end

        deviceId = strtrim(string(get(controls.deviceEdit, 'String')));
        if deviceId == ""
            errordlg('Enter a BLE device name or address first.', 'Mechanical Sensor');
            return;
        end

        connectBusy = true;
        refreshButtons();
        setStatusHeader(sprintf('Connecting to %s...', deviceId));
        updateStatusText();
        drawnow limitrate nocallbacks;

        try
            bleObj = ble(deviceId);
            ctrlChar = characteristic(bleObj, MLX97_SERVICE_UUID, MLX97_CHAR_CTRL);
            streamChar = characteristic(bleObj, MLX97_SERVICE_UUID, MLX97_CHAR_STREAM);
            imuChar = characteristic(bleObj, MLX97_SERVICE_UUID, MLX97_CHAR_IMU);
            fileChar = characteristic(bleObj, MLX97_SERVICE_UUID, MLX97_CHAR_FILE);
            metaChar = characteristic(bleObj, MLX97_SERVICE_UUID, MLX97_CHAR_META);

            metaChar.DataAvailableFcn = @onMetaData;
            fileChar.DataAvailableFcn = @onFileData;
            subscribe(metaChar, "notification");
            subscribe(fileChar, "notification");

            connected = true;
            statusSeq = 0;
            requestStatusSync(connectStatusTimeoutSec);
            setStatusHeader('Connected');
        catch err
            disconnectDevice();
            connectBusy = false;
            refreshButtons();
            errordlg(err.message, 'BLE Connect Failed');
            return;
        end

        connectBusy = false;
        refreshButtons();
        updateStatusText();
    end

    function onStartLive(~, ~)
        if ~connected || downloadActive
            return;
        end

        try
            ensureLiveSubscriptions();
            seq0 = statusSeq;
            sendCtrl([CMD_STREAM_ON]);
            setStatusHeader('Live requested');
            waitForFreshStatusSince(seq0, @(s) s.streamActive, statusCommandTimeoutSec);
            setStatusHeader('Live active');
            updateStatusText();
        catch err
            errordlg(err.message, 'Start Live Failed');
        end
    end

    function onStopLive(~, ~)
        if ~connected || downloadActive
            return;
        end

        try
            seq0 = statusSeq;
            sendCtrl([CMD_STREAM_OFF]);
            waitForFreshStatusSince(seq0, @(s) ~s.streamActive, statusCommandTimeoutSec);
            setStatusHeader('Live stopped');
            updateStatusText();
        catch err
            errordlg(err.message, 'Stop Live Failed');
        end
    end

    function onStartRecording(~, ~)
        if ~connected || downloadActive
            return;
        end
        if status.recordingActive
            warndlg('Device is already recording.', 'Mechanical Sensor');
            return;
        end
        if ~status.nandReady
            warndlg('NAND is not ready on the device.', 'Mechanical Sensor');
            return;
        end
        try
            ensureLiveSubscriptions();
            clearPlotBuffers();
            clearAck();
            seq1 = statusSeq;
            setStatusHeader('Erasing NAND and starting recording...');
            updateStatusText();
            drawnow limitrate nocallbacks;
            sendCtrl([CMD_REC_START FLAG_OVERWRITE]);
            waitForAck(CMD_REC_START, recordStartTimeoutSec);
            waitForFreshStatusSince(seq1, @(s) s.recordingActive, recordStartTimeoutSec);
            seq2 = statusSeq;
            sendCtrl([CMD_STREAM_ON]);
            waitForFreshStatusSince(seq2, @(s) s.streamActive, statusCommandTimeoutSec);
            setStatusHeader('Recording');
            updateStatusText();
        catch err
            errordlg(err.message, 'Start Recording Failed');
        end
    end

    function onStopRecording(~, ~)
        if ~connected || downloadActive
            return;
        end

        try
            clearAck();
            seq1 = statusSeq;
            setStatusHeader('Stopping recording...');
            updateStatusText();
            drawnow limitrate nocallbacks;
            sendCtrl([CMD_REC_STOP]);
            waitForAckOrFreshStatus(CMD_REC_STOP, seq1, @(s) ~s.recordingActive, recordStopTimeoutSec);
            seq2 = statusSeq;
            sendCtrl([CMD_STREAM_OFF]);
            waitForFreshStatusSince(seq2, @(s) ~s.streamActive, statusCommandTimeoutSec + 2.0);
            setStatusHeader('Recording stopped');
            updateStatusText();
        catch err
            errordlg(err.message, 'Stop Recording Failed');
        end
    end

    function onDownload(~, ~)
        if ~connected
            return;
        end
        if status.recordingActive
            warndlg('Stop recording before download.', 'Mechanical Sensor');
            return;
        end
        if ~status.hasRecording
            warndlg('No device recording is available to download.', 'Mechanical Sensor');
            return;
        end

        [fileName, filePath] = uiputfile('*.bin', 'Save downloaded recording as', ...
            sprintf('mechanical_sensor_%s.bin', datestr(now, 'yyyymmdd_HHMMSS')));
        if isequal(fileName, 0)
            return;
        end

        try
            downloadBasePath = string(fullfile(filePath, erase(string(fileName), ".bin")));
            prepareDownloadFiles(downloadBasePath);
        catch err
            errordlg(err.message, 'Download Failed');
            return;
        end

        clearPlotBuffers();
        downloadRemain = uint8([]);
        downloadFrames = 0;
        downloadMlxCount = 0;
        downloadImuCount = 0;
        downloadBytesReceived = uint64(0);
        downloadDecodedBytes = uint64(0);
        downloadUnknownCount = uint64(0);
        downloadUnknownBytes = uint64(0);
        downloadUnknownLogCount = uint32(0);
        downloadDebugLastLogAt = now;
        downloadFinishedByMeta = false;
        downloadDoneSeenAt = NaN;
        downloadStartedAt = now;
        downloadLastDataAt = now;
        downloadActive = true;
        setStatusHeader('Downloading');
        fprintf('[%s] DOWNLOAD start expected_bytes=%s expected_mlx=%s expected_imu=%s\n', ...
            datestr(now, 'yyyy-mm-dd HH:MM:SS.FFF'), ...
            formatBytes(status.bytesWritten), ...
            num2str(status.mlxCount), ...
            num2str(status.imuCount));
        suspendLiveSubscriptions();
        refreshButtons();
        updateStatusText();

        try
            if status.streamActive
                seq0 = statusSeq;
                sendCtrl([CMD_STREAM_OFF]);
                waitForFreshStatusSince(seq0, @(s) ~s.streamActive, statusCommandTimeoutSec);
            end
            sendCtrl([CMD_DOWNLOAD]);
        catch err
            failDownload(err.message);
            return;
        end
    end

    function onErase(~, ~)
        if ~connected || downloadActive
            return;
        end

        answer = questdlg('Soft-delete the recording stored on device NAND?', ...
            'Erase Device Recording', 'Erase', 'Cancel', 'Cancel');
        if ~strcmp(answer, 'Erase')
            return;
        end

        try
            clearAck();
            sendCtrl([CMD_ERASE]);
            waitForAck(CMD_ERASE, statusCommandTimeoutSec + 2.0);
            requestStatusSync(statusCommandTimeoutSec);
            setStatusHeader('Recording erased');
            updateStatusText();
        catch err
            errordlg(err.message, 'Erase Failed');
        end
    end

    function ensureLiveSubscriptions()
        if liveSubscribed
            return;
        end
        streamChar.DataAvailableFcn = @onMlxData;
        imuChar.DataAvailableFcn = @onImuData;
        subscribe(streamChar, "notification");
        subscribe(imuChar, "notification");
        liveSubscribed = true;
    end

    function suspendLiveSubscriptions()
        tryStopNotify(streamChar);
        tryStopNotify(imuChar);
        liveSubscribed = false;
    end

    function sendCtrl(bytes)
        write(ctrlChar, uint8(bytes), "uint8");
    end

    function onMlxData(src, ~)
        if downloadActive
            return;
        end
        [data, ~] = read(src, 'oldest');
        if numel(data) < 12
            return;
        end

        tMs = typecast(uint8(data(1:4)), 'uint32');
        xyz = typecast(uint8(data(5:10)), 'int16');
        tSec = normalizePlotTime(double(tMs(1)) / 1000);
        [mlxBufT, mlxBufX, mlxBufY, mlxBufZ, mlxBufN] = appendMlx( ...
            mlxBufT, mlxBufX, mlxBufY, mlxBufZ, mlxBufN, maxMlxPoints, ...
            tSec, double(xyz(1)), double(xyz(2)), double(xyz(3)));
    end

    function onImuData(src, ~)
        if downloadActive
            return;
        end
        [data, ~] = read(src, 'oldest');
        if numel(data) < 16
            return;
        end

        tMs = typecast(uint8(data(1:4)), 'uint32');
        vals = typecast(uint8(data(5:16)), 'int16');
        tSec = normalizePlotTime(double(tMs(1)) / 1000);
        [imuBufT, imuBufAx, imuBufAy, imuBufAz, imuBufGx, imuBufGy, imuBufGz, imuBufN] = appendImu( ...
            imuBufT, imuBufAx, imuBufAy, imuBufAz, imuBufGx, imuBufGy, imuBufGz, imuBufN, maxImuPoints, ...
            tSec, double(vals(1)), double(vals(2)), double(vals(3)), ...
            double(vals(4)) / 10, double(vals(5)) / 10, double(vals(6)) / 10);
    end

    function onMetaData(src, ~)
        [data, ~] = read(src, 'oldest');
        data = uint8(data);
        if isempty(data)
            return;
        end
        processMetaPacket(data);
    end

    function processMetaPacket(data)
        pktType = uint8(data(1));

        switch pktType
            case uint8(16)
                if numel(data) >= 44
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
                end
                statusSeq = statusSeq + 1;
                refreshButtons();
                updateStatusText();

            case uint8(hex2dec('F0'))
                if numel(data) >= 6
                    lastAckCmd = data(2);
                    lastAckRc = int16(typecast(uint8(data(5:6)), 'int16'));
                    if lastAckRc ~= 0
                        setStatusHeader(sprintf('Command 0x%02X failed (%d)', lastAckCmd, lastAckRc));
                        updateStatusText();
                        if downloadActive && lastAckCmd == CMD_DOWNLOAD
                            failDownload(sprintf('Download command failed: %d', lastAckRc));
                        end
                    end
                end

            case uint8(3)
                downloadFinishedByMeta = true;
                downloadDoneSeenAt = now;
                fprintf('[%s] DOWNLOAD meta-done rx=%s frames=%u mlx=%u imu=%u remain=%u decoded=%s unknown=%s/%s\n', ...
                    datestr(now, 'yyyy-mm-dd HH:MM:SS.FFF'), ...
                    formatBytes(downloadBytesReceived), ...
                    uint32(downloadFrames), ...
                    uint32(downloadMlxCount), ...
                    uint32(downloadImuCount), ...
                    uint32(numel(downloadRemain)), ...
                    formatBytes(downloadDecodedBytes), ...
                    num2str(downloadUnknownCount), ...
                    formatBytes(downloadUnknownBytes));

            otherwise
        end
    end

    function requestStatusAsync()
        if connected
            sendCtrl([CMD_STATUS]);
        end
    end

    function requestStatusSync(timeoutSec)
        seq0 = statusSeq;
        sendCtrl([CMD_STATUS]);
        waitForStatusSeq(seq0, timeoutSec);
    end

    function waitForFreshStatusSince(seq0, pred, timeoutSec)
        t0 = tic;
        while toc(t0) < timeoutSec
            drawnow;
            pause(0.02);
            if statusSeq > seq0 && pred(status)
                return;
            end
        end
        error('Timed out waiting for fresh status.');
    end

    function waitForStatusSeq(seq0, timeoutSec)
        t0 = tic;
        while toc(t0) < timeoutSec
            drawnow;
            pause(0.02);
            if statusSeq > seq0
                return;
            end
        end
        error('Timed out waiting for status.');
    end

    function waitForAck(cmdByte, timeoutSec)
        t0 = tic;
        while toc(t0) < timeoutSec
            drawnow;
            pause(0.02);
            if isequal(lastAckCmd, cmdByte)
                if lastAckRc ~= 0
                    error('Command 0x%02X failed with rc=%d.', cmdByte, lastAckRc);
                end
                return;
            end
        end
        error('Timed out waiting for ACK 0x%02X.', cmdByte);
    end

    function waitForAckOrFreshStatus(cmdByte, seq0, pred, timeoutSec)
        t0 = tic;
        while toc(t0) < timeoutSec
            drawnow;
            pause(0.02);
            if isequal(lastAckCmd, cmdByte)
                if lastAckRc ~= 0
                    error('Command 0x%02X failed with rc=%d.', cmdByte, lastAckRc);
                end
                return;
            end
            if statusSeq > seq0 && pred(status)
                return;
            end
        end
        error('Timed out waiting for ACK/status 0x%02X.', cmdByte);
    end

    function clearAck()
        lastAckCmd = uint8(0);
        lastAckRc = int16(0);
    end

    function onFileData(src, ~)
        try
            [data, ~] = read(src, 'oldest');
        catch err
            if contains(err.message, 'Device has not sent new data', 'IgnoreCase', true)
                return;
            end
            rethrow(err);
        end
        data = uint8(data);
        if isempty(data) || ~downloadActive
            return;
        end

        if downloadBinId < 0
            return;
        end

        fwrite(downloadBinId, data, 'uint8');
        downloadBytesReceived = downloadBytesReceived + uint64(numel(data));
        downloadLastDataAt = now;
        downloadRemain = [downloadRemain; data(:)]; %#ok<AGROW>
        hostNow = datetime('now', 'Format', 'yyyy-MM-dd HH:mm:ss.SSS');
        hostTsStr = char(hostNow);
        hostMs = posixtime(hostNow) * 1000;

        while numel(downloadRemain) >= 2
            recType = downloadRemain(1);
            payloadLen = double(downloadRemain(2));
            totalLen = 2 + payloadLen;
            if numel(downloadRemain) < totalLen
                break;
            end

            payload = downloadRemain(3:totalLen);
            downloadRemain(1:totalLen) = [];
            downloadFrames = downloadFrames + 1;
            writeDownloadRecord(recType, payload, hostTsStr, hostMs);
        end

        refreshButtons();
        updateStatusText();
        if isnan(downloadDebugLastLogAt) || ((now - downloadDebugLastLogAt) * 86400) >= 1.0
            fprintf('[%s] DOWNLOAD progress rx=%s frames=%u mlx=%u imu=%u remain=%u decoded=%s unknown=%s/%s expected_bytes=%s\n', ...
                datestr(now, 'yyyy-mm-dd HH:MM:SS.FFF'), ...
                formatBytes(downloadBytesReceived), ...
                uint32(downloadFrames), ...
                uint32(downloadMlxCount), ...
                uint32(downloadImuCount), ...
                uint32(numel(downloadRemain)), ...
                formatBytes(downloadDecodedBytes), ...
                num2str(downloadUnknownCount), ...
                formatBytes(downloadUnknownBytes), ...
                formatBytes(status.bytesWritten));
            downloadDebugLastLogAt = now;
        end
    end

    function writeDownloadRecord(recType, payload, hostTsStr, hostMs)
        if downloadMlxId < 0 || downloadImuId < 0
            return;
        end

        if recType == uint8(1) && numel(payload) == 12
            tMs = typecast(uint8(payload(1:4)), 'uint32');
            vals = typecast(uint8(payload(5:10)), 'int16');
            stat1 = payload(11);
            stat2 = payload(12);
            fprintf(downloadMlxId, '%s,%.3f,%u,%d,%d,%d,%u,%u\n', ...
                hostTsStr, hostMs, tMs(1), vals(1), vals(2), vals(3), stat1, stat2);
            downloadMlxCount = downloadMlxCount + 1;
            downloadDecodedBytes = downloadDecodedBytes + uint64(14);
        elseif recType == uint8(2) && numel(payload) == 16
            tMs = typecast(uint8(payload(1:4)), 'uint32');
            vals = typecast(uint8(payload(5:16)), 'int16');
            fprintf(downloadImuId, '%s,%.3f,%u,%d,%d,%d,%d,%d,%d\n', ...
                hostTsStr, hostMs, tMs(1), vals(1), vals(2), vals(3), vals(4), vals(5), vals(6));
            downloadImuCount = downloadImuCount + 1;
            downloadDecodedBytes = downloadDecodedBytes + uint64(18);
        else
            downloadUnknownCount = downloadUnknownCount + 1;
            downloadUnknownBytes = downloadUnknownBytes + uint64(numel(payload) + 2);
            if downloadUnknownLogCount < 20
                fprintf('[%s] DOWNLOAD unknown recType=0x%02X payloadLen=%u total=%u firstBytes=%s\n', ...
                    datestr(now, 'yyyy-mm-dd HH:MM:SS.FFF'), ...
                    uint32(recType), ...
                    uint32(numel(payload)), ...
                    uint32(numel(payload) + 2), ...
                    formatBytePreview(payload));
                downloadUnknownLogCount = downloadUnknownLogCount + 1;
            end
        end
    end

    function onUiTimer(~, ~)
        if ~isgraphics(fig)
            return;
        end

        if connected && ~connectBusy && ~downloadActive && ~status.recordingActive
            if isnan(lastStatusPoll) || ((now - lastStatusPoll) * 86400) >= idleStatusPollSec
                try
                    requestStatusAsync();
                    lastStatusPoll = now;
                catch
                    disconnectDevice();
                    setStatusHeader('Disconnected unexpectedly');
                    updateStatusText();
                    return;
                end
            end
        end

        if downloadActive
            expected = double(status.bytesWritten);
            received = double(downloadBytesReceived);
            ageSec = (now - downloadLastDataAt) * 86400;
            doneAgeSec = inf;
            totalAgeSec = inf;
            if ~isnan(downloadDoneSeenAt)
                doneAgeSec = (now - downloadDoneSeenAt) * 86400;
            end
            if ~isnan(downloadStartedAt)
                totalAgeSec = (now - downloadStartedAt) * 86400;
            end

            if downloadFinishedByMeta && doneAgeSec >= downloadDoneGraceSec && isempty(downloadRemain)
                if expected <= 0 || received >= expected
                    finishDownload('Download complete');
                else
                    finishDownloadWithWarning(sprintf('Download incomplete: received %s of %s.', ...
                        formatBytes(downloadBytesReceived), formatBytes(status.bytesWritten)));
                end
            elseif downloadFinishedByMeta && doneAgeSec >= downloadDoneGraceSec && expected > 0 && received >= expected
                flushDownloadRemain();
                finishDownload('Download complete');
            elseif ~isnan(downloadLastDataAt) && ageSec >= downloadStallTimeoutSec
                flushDownloadRemain();
                finishDownloadWithWarning(sprintf('Download ended after %.1f s without new data.', ageSec));
            elseif isfinite(downloadHardTimeoutSec) && totalAgeSec >= downloadHardTimeoutSec
                flushDownloadRemain();
                finishDownloadWithWarning(sprintf('Download stopped after %.1f s total timeout.', totalAgeSec));
            end
        end

        if ~downloadActive
            updatePlots();
        end
        drawnow limitrate nocallbacks;
    end

    function updatePlots()
        if mlxBufN > 0
            [tx, x0, y0, z0, rightEdge] = recentWindow4( ...
                mlxBufT, mlxBufX, mlxBufY, mlxBufZ, mlxBufN, plotWindowSec, maxPlotPoints);
            switch mlxPlotChannel
                case 'X'
                    yPlot = x0;
                    plotColor = [0.84 0.21 0.18];
                case 'Y'
                    yPlot = y0;
                    plotColor = [0.14 0.49 0.86];
                otherwise
                    yPlot = z0;
                    plotColor = [0.18 0.65 0.29];
            end
            set(lineHandles.mlx, 'XData', tx, 'YData', yPlot, 'Color', plotColor);
            title(axesHandles.mlx, sprintf('MLX90397 Live / Download (%s)', mlxPlotChannel));
            updateTimeWindow(rightEdge, plotWindowSec, axesHandles.mlx);
        else
            set(lineHandles.mlx, 'XData', [], 'YData', []);
        end

        if imuBufN > 0
            [tt, ax0, ay0, az0, rightEdge] = recentWindow4( ...
                imuBufT, imuBufAx, imuBufAy, imuBufAz, imuBufN, plotWindowSec, maxPlotPoints);
            [~, gx0, gy0, gz0, ~] = recentWindow4( ...
                imuBufT, imuBufGx, imuBufGy, imuBufGz, imuBufN, plotWindowSec, maxPlotPoints);
            set(lineHandles.accel(1), 'XData', tt, 'YData', ax0);
            set(lineHandles.accel(2), 'XData', tt, 'YData', ay0);
            set(lineHandles.accel(3), 'XData', tt, 'YData', az0);
            set(lineHandles.gyro(1), 'XData', tt, 'YData', gx0);
            set(lineHandles.gyro(2), 'XData', tt, 'YData', gy0);
            set(lineHandles.gyro(3), 'XData', tt, 'YData', gz0);
            updateTimeWindow(rightEdge, plotWindowSec, axesHandles.accel);
            updateTimeWindow(rightEdge, plotWindowSec, axesHandles.gyro);
        else
            set(lineHandles.accel, 'XData', [], 'YData', []);
            set(lineHandles.gyro, 'XData', [], 'YData', []);
        end
    end

    function onMlxChannelChanged(src, ~)
        items = get(src, 'String');
        idx = get(src, 'Value');
        if iscell(items)
            mlxPlotChannel = char(items{idx});
        else
            mlxPlotChannel = char(items(idx, :));
        end
        updatePlots();
    end

    function clearPlotBuffers()
        mlxBufN = 0;
        imuBufN = 0;
        plotTimeOriginSec = NaN;
    end

    function tRel = normalizePlotTime(tSec)
        if isnan(plotTimeOriginSec)
            plotTimeOriginSec = tSec;
        end
        tRel = max(0, tSec - plotTimeOriginSec);
    end

    function prepareDownloadFiles(basePath)
        closeDownloadFiles();

        binPath = char(basePath + ".bin");
        mlxPath = char(basePath + "_mlx97.csv");
        imuPath = char(basePath + "_imu.csv");

        downloadBinId = fopen(binPath, 'w');
        downloadMlxId = fopen(mlxPath, 'w');
        downloadImuId = fopen(imuPath, 'w');

        if downloadBinId < 0 || downloadMlxId < 0 || downloadImuId < 0
            closeDownloadFiles();
            error('Failed to open download output files.');
        end

        fprintf(downloadMlxId, 'host_time_iso,host_t_ms,t_ms_device,x,y,z,stat1,stat2\n');
        fprintf(downloadImuId, 'host_time_iso,host_t_ms,t_ms_device,ax_mg,ay_mg,az_mg,gx_dps_x10,gy_dps_x10,gz_dps_x10\n');
    end

    function closeDownloadFiles()
        if downloadBinId >= 0
            fclose(downloadBinId);
            downloadBinId = -1;
        end
        if downloadMlxId >= 0
            fclose(downloadMlxId);
            downloadMlxId = -1;
        end
        if downloadImuId >= 0
            fclose(downloadImuId);
            downloadImuId = -1;
        end
    end

    function flushDownloadRemain()
        if isempty(downloadRemain)
            return;
        end
        if numel(downloadRemain) <= 2
            downloadRemain = uint8([]);
            return;
        end
        warning('Dropping %d trailing download bytes that did not form a full record.', numel(downloadRemain));
        downloadRemain = uint8([]);
    end

    function finishDownload(headerText)
        fprintf('[%s] DOWNLOAD finish header="%s" rx=%s frames=%u mlx=%u imu=%u remain=%u decoded=%s unknown=%s/%s expected_bytes=%s expected_mlx=%s expected_imu=%s\n', ...
            datestr(now, 'yyyy-mm-dd HH:MM:SS.FFF'), ...
            headerText, ...
            formatBytes(downloadBytesReceived), ...
            uint32(downloadFrames), ...
            uint32(downloadMlxCount), ...
            uint32(downloadImuCount), ...
            uint32(numel(downloadRemain)), ...
            formatBytes(downloadDecodedBytes), ...
            num2str(downloadUnknownCount), ...
            formatBytes(downloadUnknownBytes), ...
            formatBytes(status.bytesWritten), ...
            num2str(status.mlxCount), ...
            num2str(status.imuCount));
        downloadActive = false;
        downloadFinishedByMeta = false;
        downloadDoneSeenAt = NaN;
        closeDownloadFiles();
        setStatusHeader(headerText);
        refreshButtons();
        try
            requestStatusSync(statusCommandTimeoutSec);
        catch
        end
        updateStatusText();
    end

    function finishDownloadWithWarning(msg)
        finishDownload('Download finished with warnings');
        warning('%s', msg);
    end

    function failDownload(msg)
        closeDownloadFiles();
        downloadActive = false;
        downloadFinishedByMeta = false;
        downloadDoneSeenAt = NaN;
        refreshButtons();
        setStatusHeader('Download failed');
        updateStatusText();
        errordlg(msg, 'Download Failed');
    end

    function disconnectDevice()
        if downloadActive && connected
            try
                sendCtrl([CMD_ABORT]);
            catch
            end
        end

        suspendLiveSubscriptions();
        tryStopNotify(fileChar);
        tryStopNotify(metaChar);

        streamChar = [];
        imuChar = [];
        fileChar = [];
        metaChar = [];
        ctrlChar = [];
        bleObj = [];
        connected = false;
        connectBusy = false;
        liveSubscribed = false;
        downloadActive = false;
        downloadFinishedByMeta = false;
        downloadDoneSeenAt = NaN;
        downloadStartedAt = NaN;
        downloadLastDataAt = NaN;
        statusSeq = 0;
        lastStatusPoll = NaN;
        closeDownloadFiles();
        refreshButtons();
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

    function setStatusHeader(msg)
        if isgraphics(controls.headerText)
            set(controls.headerText, 'String', msg);
        end
    end

    function updateStatusText()
        if ~isgraphics(controls.statusBox)
            return;
        end

        flashFrac = min(1, double(status.bytesWritten) / double(flashTotalBytes));
        lines = {
            sprintf('Connected: %d    Busy(connect/download): %d/%d', connected, connectBusy, downloadActive)
            sprintf('Stream: %d    Recording: %d    Has Recording: %d    Dirty Open: %d', ...
                status.streamActive, status.recordingActive, status.hasRecording, status.dirtyOpen)
            sprintf('NAND Ready: %d    Last ACK: 0x%02X / %d', status.nandReady, lastAckCmd, lastAckRc)
            sprintf('Bytes: %s    MLX: %s    IMU: %s', ...
                num2str(status.bytesWritten), num2str(status.mlxCount), num2str(status.imuCount))
            sprintf('Flash Usage: %s / %s  (%.1f%%%%)', ...
                formatBytes(status.bytesWritten), formatBytes(flashTotalBytes), 100 * flashFrac)
            sprintf('Next Page: %u    Last Page: %u    Last Error: %d', ...
                status.nextPage, status.lastPage, status.lastError)
        };

        if downloadActive
            expected = status.bytesWritten;
            frac = 0;
            if expected > 0
                frac = min(1, double(downloadBytesReceived) / double(expected));
            end
            lines(end+1:end+2) = { ...
                sprintf('Download Path: %s', downloadBasePath), ...
                sprintf('Download Progress: %s / %s  (%.1f%%%%)    Frames: %d    MLX: %d    IMU: %d', ...
                    formatBytes(downloadBytesReceived), formatBytes(expected), 100 * frac, ...
                    downloadFrames, downloadMlxCount, downloadImuCount) ...
            };
        end

        set(controls.statusBox, 'String', lines);
        updateProgressBar();
        updateDownloadVisualState();
    end

    function refreshButtons()
        if ~isgraphics(fig)
            return;
        end

        set(controls.connectBtn, 'String', ternary(connected, 'Disconnect', 'Connect'));
        set(controls.connectBtn, 'Enable', onOff(~connectBusy));

        appBusy = connectBusy || downloadActive;
        set(controls.startLiveBtn, 'Enable', onOff(connected && ~appBusy && ~status.streamActive && ~status.recordingActive));
        set(controls.stopLiveBtn, 'Enable', onOff(connected && ~appBusy && status.streamActive && ~status.recordingActive));
        set(controls.startRecBtn, 'Enable', onOff(connected && ~appBusy && ~status.recordingActive));
        set(controls.stopRecBtn, 'Enable', onOff(connected && ~appBusy && status.recordingActive));
        set(controls.downloadBtn, 'Enable', onOff(connected && ~appBusy && status.hasRecording && ~status.recordingActive));
        set(controls.eraseBtn, 'Enable', onOff(connected && ~appBusy && status.hasRecording && ~status.recordingActive));
    end

    function updateProgressBar()
        if ~isgraphics(controls.progressAxes)
            return;
        end

        if downloadActive && status.bytesWritten > 0
            frac = min(1, double(downloadBytesReceived) / double(status.bytesWritten));
            label = sprintf('Download  %s / %s  (%.1f%%%%)', ...
                formatBytes(downloadBytesReceived), formatBytes(status.bytesWritten), 100 * frac);
            color = [0.12 0.62 0.24];
        else
            frac = min(1, double(status.bytesWritten) / double(flashTotalBytes));
            label = sprintf('Flash Usage  %s / %s  (%.1f%%%%)', ...
                formatBytes(status.bytesWritten), formatBytes(flashTotalBytes), 100 * frac);
            color = [0.16 0.46 0.82];
        end

        set(controls.progressPatch, 'XData', [0 frac frac 0], 'YData', [0 0 1 1], 'FaceColor', color);
        set(controls.progressLabel, 'String', label);
    end

    function updateDownloadVisualState()
        if downloadActive
            figColor = [0.97 1.00 0.97];
            axColor = [0.94 0.99 0.94];
        else
            figColor = [0.97 0.97 0.98];
            axColor = [1 1 1];
        end

        set(fig, 'Color', figColor);
        set(axesHandles.mlx, 'Color', axColor);
        set(axesHandles.accel, 'Color', axColor);
        set(axesHandles.gyro, 'Color', axColor);
    end

    function onCloseFigure(~, ~)
        cleanupWrapper();
        if isgraphics(fig)
            delete(fig);
        end
    end

    function cleanupWrapper()
        try
            localCleanup();
        catch
        end
    end

    function localCleanup()
        try
            t = plotTimer;
        catch
            t = [];
        end

        if ~isempty(t)
            try
                if isvalid(t)
                    stop(t);
                end
            catch
            end
            try
                if isvalid(t)
                    delete(t);
                end
            catch
            end
        end

        try
            disconnectDevice();
        catch
        end
    end
end

function [fig, controls, axesHandles, lineHandles] = createGui(connectCb, startLiveCb, stopLiveCb, startRecCb, stopRecCb, downloadCb, eraseCb, mlxChannelCb)
    fig = figure( ...
        'Name', 'Mechanical Sensor Console', ...
        'Tag', 'MechanicalSensorConsoleFigure', ...
        'NumberTitle', 'off', ...
        'Color', [0.97 0.97 0.98], ...
        'MenuBar', 'none', ...
        'ToolBar', 'none', ...
        'Position', [80 60 1360 920]);

    topPanel = uipanel('Parent', fig, 'Title', 'Session', 'FontWeight', 'bold', ...
        'Units', 'normalized', 'Position', [0.02 0.70 0.96 0.28], ...
        'BackgroundColor', [0.97 0.97 0.98]);

    uicontrol(topPanel, 'Style', 'text', 'String', 'Device', ...
        'Units', 'normalized', 'Position', [0.02 0.86 0.06 0.08], ...
        'HorizontalAlignment', 'left', 'BackgroundColor', [0.97 0.97 0.98], 'FontWeight', 'bold');

    controls.deviceEdit = uicontrol(topPanel, 'Style', 'edit', 'String', 'mech50', ...
        'Units', 'normalized', 'Position', [0.08 0.84 0.18 0.11], ...
        'HorizontalAlignment', 'left', 'FontSize', 11);

    controls.connectBtn = uicontrol(topPanel, 'Style', 'pushbutton', 'String', 'Connect', ...
        'Units', 'normalized', 'Position', [0.28 0.84 0.10 0.11], 'FontSize', 11);
    controls.startLiveBtn = uicontrol(topPanel, 'Style', 'pushbutton', 'String', 'Start Live', ...
        'Units', 'normalized', 'Position', [0.40 0.84 0.10 0.11], 'FontSize', 11, 'Enable', 'off');
    controls.stopLiveBtn = uicontrol(topPanel, 'Style', 'pushbutton', 'String', 'Stop Live', ...
        'Units', 'normalized', 'Position', [0.52 0.84 0.10 0.11], 'FontSize', 11, 'Enable', 'off');
    controls.startRecBtn = uicontrol(topPanel, 'Style', 'pushbutton', 'String', 'Start Recording', ...
        'Units', 'normalized', 'Position', [0.64 0.84 0.14 0.11], 'FontSize', 11, 'Enable', 'off');
    controls.stopRecBtn = uicontrol(topPanel, 'Style', 'pushbutton', 'String', 'Stop Recording', ...
        'Units', 'normalized', 'Position', [0.80 0.84 0.14 0.11], 'FontSize', 11, 'Enable', 'off');

    controls.downloadBtn = uicontrol(topPanel, 'Style', 'pushbutton', 'String', 'Download Recording', ...
        'Units', 'normalized', 'Position', [0.40 0.70 0.18 0.11], 'FontSize', 11, 'Enable', 'off');
    controls.eraseBtn = uicontrol(topPanel, 'Style', 'pushbutton', 'String', 'Erase Recording', ...
        'Units', 'normalized', 'Position', [0.60 0.70 0.18 0.11], 'FontSize', 11, 'Enable', 'off');

    controls.headerText = uicontrol(topPanel, 'Style', 'text', 'String', 'Disconnected', ...
        'Units', 'normalized', 'Position', [0.02 0.70 0.34 0.11], ...
        'HorizontalAlignment', 'left', 'BackgroundColor', [0.97 0.97 0.98], ...
        'FontWeight', 'bold', 'FontSize', 12);

    controls.progressAxes = axes('Parent', topPanel, 'Units', 'normalized', ...
        'Position', [0.02 0.58 0.92 0.07], 'XLim', [0 1], 'YLim', [0 1], ...
        'XTick', [], 'YTick', [], 'Box', 'on');
    controls.progressPatch = patch('Parent', controls.progressAxes, ...
        'XData', [0 0 0 0], 'YData', [0 0 1 1], ...
        'FaceColor', [0.16 0.46 0.82], 'EdgeColor', 'none');
    controls.progressLabel = uicontrol(topPanel, 'Style', 'text', ...
        'String', 'Flash Usage  0 B / 0 B  (0.0%)', ...
        'Units', 'normalized', 'Position', [0.02 0.49 0.92 0.07], ...
        'HorizontalAlignment', 'left', 'BackgroundColor', [0.97 0.97 0.98], ...
        'FontName', 'Courier', 'FontSize', 10);

    controls.statusBox = uicontrol(topPanel, 'Style', 'edit', ...
        'String', {'Disconnected'}, ...
        'Units', 'normalized', 'Position', [0.02 0.05 0.92 0.40], ...
        'HorizontalAlignment', 'left', 'Max', 20, 'Min', 0, ...
        'Enable', 'inactive', 'BackgroundColor', [1 1 1], ...
        'FontName', 'Courier', 'FontSize', 10);

    axesHandles.mlx = axes('Parent', fig, 'Position', [0.07 0.47 0.88 0.18]);
    hold(axesHandles.mlx, 'on');
    grid(axesHandles.mlx, 'on');
    title(axesHandles.mlx, 'MLX90397 Live / Download (Z)');
    ylabel(axesHandles.mlx, 'Counts');
    lineHandles.mlx = plot(axesHandles.mlx, nan, nan, 'Color', [0.18 0.65 0.29], 'LineWidth', 1.2);
    uicontrol('Parent', fig, 'Style', 'text', 'String', 'MLX Channel', ...
        'Units', 'normalized', 'Position', [0.07 0.655 0.08 0.022], ...
        'HorizontalAlignment', 'left', 'BackgroundColor', [0.97 0.97 0.98], 'FontWeight', 'bold');
    controls.mlxChannelPopup = uicontrol('Parent', fig, 'Style', 'popupmenu', ...
        'String', {'X', 'Y', 'Z'}, 'Value', 3, ...
        'Units', 'normalized', 'Position', [0.15 0.653 0.06 0.028], ...
        'FontSize', 10);

    axesHandles.accel = axes('Parent', fig, 'Position', [0.07 0.25 0.88 0.18]);
    hold(axesHandles.accel, 'on');
    grid(axesHandles.accel, 'on');
    title(axesHandles.accel, 'BMI270 Accel');
    ylabel(axesHandles.accel, 'mg');
    lineHandles.accel(1) = plot(axesHandles.accel, nan, nan, 'Color', [0.84 0.21 0.18], 'LineWidth', 1.0);
    lineHandles.accel(2) = plot(axesHandles.accel, nan, nan, 'Color', [0.14 0.49 0.86], 'LineWidth', 1.0);
    lineHandles.accel(3) = plot(axesHandles.accel, nan, nan, 'Color', [0.18 0.65 0.29], 'LineWidth', 1.0);
    legend(axesHandles.accel, {'AX', 'AY', 'AZ'}, 'Location', 'northwest');

    axesHandles.gyro = axes('Parent', fig, 'Position', [0.07 0.03 0.88 0.18]);
    hold(axesHandles.gyro, 'on');
    grid(axesHandles.gyro, 'on');
    title(axesHandles.gyro, 'BMI270 Gyro');
    ylabel(axesHandles.gyro, 'deg/s');
    xlabel(axesHandles.gyro, 'Device Time (s)');
    lineHandles.gyro(1) = plot(axesHandles.gyro, nan, nan, 'Color', [0.84 0.21 0.18], 'LineWidth', 1.0);
    lineHandles.gyro(2) = plot(axesHandles.gyro, nan, nan, 'Color', [0.14 0.49 0.86], 'LineWidth', 1.0);
    lineHandles.gyro(3) = plot(axesHandles.gyro, nan, nan, 'Color', [0.18 0.65 0.29], 'LineWidth', 1.0);
    legend(axesHandles.gyro, {'GX', 'GY', 'GZ'}, 'Location', 'northwest');

    set(controls.connectBtn, 'Callback', connectCb);
    set(controls.startLiveBtn, 'Callback', startLiveCb);
    set(controls.stopLiveBtn, 'Callback', stopLiveCb);
    set(controls.startRecBtn, 'Callback', startRecCb);
    set(controls.stopRecBtn, 'Callback', stopRecCb);
    set(controls.downloadBtn, 'Callback', downloadCb);
    set(controls.eraseBtn, 'Callback', eraseCb);
    set(controls.mlxChannelPopup, 'Callback', mlxChannelCb);
end

function found = focus_existing_mechanical_sensor_console()
    found = false;
    figs = findall(0, 'Type', 'figure', 'Tag', 'MechanicalSensorConsoleFigure');
    if isempty(figs)
        return;
    end

    fig = figs(1);
    try
        if isgraphics(fig)
            figure(fig);
            drawnow;
            found = true;
        end
    catch
        found = false;
    end
end

function [tBuf, xBuf, yBuf, zBuf, n] = appendMlx(tBuf, xBuf, yBuf, zBuf, n, maxPoints, t, x, y, z)
    if n < maxPoints
        n = n + 1;
        tBuf(n) = t;
        xBuf(n) = x;
        yBuf(n) = y;
        zBuf(n) = z;
    else
        tBuf(1:end-1) = tBuf(2:end);
        xBuf(1:end-1) = xBuf(2:end);
        yBuf(1:end-1) = yBuf(2:end);
        zBuf(1:end-1) = zBuf(2:end);
        tBuf(end) = t;
        xBuf(end) = x;
        yBuf(end) = y;
        zBuf(end) = z;
    end
end

function [tBuf, axBuf, ayBuf, azBuf, gxBuf, gyBuf, gzBuf, n] = appendImu(tBuf, axBuf, ayBuf, azBuf, gxBuf, gyBuf, gzBuf, n, maxPoints, t, ax, ay, az, gx, gy, gz)
    if n < maxPoints
        n = n + 1;
        tBuf(n) = t;
        axBuf(n) = ax;
        ayBuf(n) = ay;
        azBuf(n) = az;
        gxBuf(n) = gx;
        gyBuf(n) = gy;
        gzBuf(n) = gz;
    else
        tBuf(1:end-1) = tBuf(2:end);
        axBuf(1:end-1) = axBuf(2:end);
        ayBuf(1:end-1) = ayBuf(2:end);
        azBuf(1:end-1) = azBuf(2:end);
        gxBuf(1:end-1) = gxBuf(2:end);
        gyBuf(1:end-1) = gyBuf(2:end);
        gzBuf(1:end-1) = gzBuf(2:end);
        tBuf(end) = t;
        axBuf(end) = ax;
        ayBuf(end) = ay;
        azBuf(end) = az;
        gxBuf(end) = gx;
        gyBuf(end) = gy;
        gzBuf(end) = gz;
    end
end

function [tOut, aOut, bOut, cOut, rightEdge] = recentWindow4(tBuf, aBuf, bBuf, cBuf, n, windowSec, maxPlotPoints)
    if n <= 0
        tOut = [];
        aOut = [];
        bOut = [];
        cOut = [];
        rightEdge = windowSec;
        return;
    end

    t = tBuf(1:n);
    a = aBuf(1:n);
    b = bBuf(1:n);
    c = cBuf(1:n);
    rightEdge = t(end);
    keep = t >= max(0, rightEdge - windowSec);
    t = t(keep);
    a = a(keep);
    b = b(keep);
    c = c(keep);

    if numel(t) > maxPlotPoints
        idx = round(linspace(1, numel(t), maxPlotPoints));
        t = t(idx);
        
        a = a(idx);
        b = b(idx);
        c = c(idx);
    end

    tOut = t;
    aOut = a;
    bOut = b;
    cOut = c;
end

function updateTimeWindow(rightEdge, windowSec, ax)
    if isempty(rightEdge) || ~isfinite(rightEdge)
        return;
    end
    leftEdge = max(0, rightEdge - windowSec);
    if rightEdge <= leftEdge
        rightEdge = leftEdge + windowSec;
    end
    xlim(ax, [leftEdge rightEdge]);
end

function s = onOff(tf)
    if tf
        s = 'on';
    else
        s = 'off';
    end
end

function out = ternary(cond, a, b)
    if cond
        out = a;
    else
        out = b;
    end
end

function txt = formatBytes(x)
    x = double(x);
    units = {'B', 'KB', 'MB', 'GB'};
    idx = 1;
    while x >= 1024 && idx < numel(units)
        x = x / 1024;
        idx = idx + 1;
    end
    if idx == 1
        txt = sprintf('%.0f %s', x, units{idx});
    else
        txt = sprintf('%.2f %s', x, units{idx});
    end
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

function txt = formatBytePreview(data)
    if isempty(data)
        txt = '[]';
        return;
    end
    n = min(numel(data), 8);
    parts = strings(1, n);
    for i = 1:n
        parts(i) = sprintf('%02X', uint8(data(i)));
    end
    txt = char(strjoin(cellstr(parts), ' '));
    if numel(data) > n
        txt = [txt ' ...'];
    end
end
