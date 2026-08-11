function mlx97_capture()
% MLX97 BLE capture tool for MATLAB.
%
% Workflow:
%   1. Prompts for BLE device name/address
%   2. Prompts for output folder and file name
%   3. Connects to the MLX97 BLE peripheral
%   4. Subscribes to stream notifications
%   5. Sends CTRL START (0x01)
%   6. Logs raw samples to CSV until you press Enter
%   7. Sends CTRL STOP (0x00) and closes cleanly
%
% Output CSV columns:
%   host_time_iso, host_t_ms, t_ms_device, x, y, z, stat1, stat2

    MLX97_SERVICE_UUID = "a0a4e690-96be-4222-b41e-98ea76b0120c";
    MLX97_CHAR_STREAM  = "a0a4e691-96be-4222-b41e-98ea76b0120c";
    MLX97_CHAR_CTRL    = "a0a4e692-96be-4222-b41e-98ea76b0120c";
    MLX97_CTRL_START   = uint8(1);
    MLX97_CTRL_STOP    = uint8(0);

    prompts = { ...
        'BLE device name or address:', ...
        'Output filename (without extension):' ...
    };
    defaults = {'MECH2', sprintf('mlx97_%s', datestr(now, 'yyyymmdd_HHMMSS'))};
    answer = inputdlg(prompts, 'MLX97 Capture', [1 60], defaults);
    if isempty(answer)
        disp('Cancelled.');
        return;
    end

    deviceId = strtrim(string(answer{1}));
    baseName = strtrim(string(answer{2}));
    if baseName == ""
        error('Filename cannot be empty.');
    end

    outDir = uigetdir(pwd, 'Select folder to save MLX97 capture');
    if isequal(outDir, 0)
        disp('Cancelled.');
        return;
    end

    outPath = fullfile(outDir, baseName + ".csv");
    if isfile(outPath)
        overwrite = questdlg(sprintf('File exists:\n%s\nOverwrite?', outPath), ...
            'Overwrite?', 'Yes', 'No', 'No');
        if ~strcmp(overwrite, 'Yes')
            disp('Cancelled.');
            return;
        end
    end

    fprintf('Scanning nearby BLE devices...\n');
    try
        disp(blelist);
    catch blelistErr
        warning('blelist failed: %s', blelistErr.message);
    end

    fprintf('Connecting to %s ...\n', deviceId);
    bleObj = ble(deviceId);
    ctrlChar = characteristic(bleObj, MLX97_SERVICE_UUID, MLX97_CHAR_CTRL);
    streamChar = characteristic(bleObj, MLX97_SERVICE_UUID, MLX97_CHAR_STREAM);

    fileId = fopen(outPath, 'w');
    if fileId < 0
        clear bleObj ctrlChar streamChar;
        error('Failed to open output file: %s', outPath);
    end

    cleanupObj = onCleanup(@() localCleanup(streamChar, ctrlChar, fileId, MLX97_CTRL_STOP));

    fprintf(fileId, 'host_time_iso,host_t_ms,t_ms_device,x,y,z,stat1,stat2\n');

    sampleCount = 0;
    firstHostMs = [];
    lastHostMs = [];

    streamChar.DataAvailableFcn = @onData;
    subscribe(streamChar, "notification");
    write(ctrlChar, MLX97_CTRL_START, "uint8");

    fprintf('Recording to:\n  %s\n', outPath);
    fprintf('Press Enter in MATLAB Command Window to stop.\n');
    input('', 's');

    elapsedMs = 0;
    if ~isempty(firstHostMs) && ~isempty(lastHostMs)
        elapsedMs = lastHostMs - firstHostMs;
    end
    fprintf('Saved %d samples', sampleCount);
    if elapsedMs > 0
        fprintf(' over %.3f s (%.2f Hz avg host-side)', elapsedMs / 1000, sampleCount / (elapsedMs / 1000));
    end
    fprintf('.\n');

    function onData(src, ~)
        [data, ts] = read(src, 'oldest');
        if numel(data) < 12
            return;
        end

        sampleCount = sampleCount + 1;
        hostMs = posixtime(ts) * 1000;
        if isempty(firstHostMs)
            firstHostMs = hostMs;
        end
        lastHostMs = hostMs;

        tMsDevice = typecast(uint8(data(1:4)), 'uint32');
        xyz = typecast(uint8(data(5:10)), 'int16');
        stat1 = uint8(data(11));
        stat2 = uint8(data(12));

        fprintf(fileId, '%s,%.3f,%u,%d,%d,%d,%u,%u\n', ...
            char(string(ts, 'yyyy-MM-dd HH:mm:ss.SSS')), ...
            hostMs, ...
            tMsDevice(1), ...
            xyz(1), xyz(2), xyz(3), ...
            stat1, stat2);

        if mod(sampleCount, 100) == 0
            fprintf('Samples: %d | last device t=%u | x=%d y=%d z=%d | stat2=0x%02X\n', ...
                sampleCount, tMsDevice(1), xyz(1), xyz(2), xyz(3), stat2);
        end
    end
end

function localCleanup(streamChar, ctrlChar, fileId, stopByte)
    try
        write(ctrlChar, stopByte, "uint8");
    catch
    end

    try
        unsubscribe(streamChar);
    catch
    end

    try
        streamChar.DataAvailableFcn = [];
    catch
    end

    try
        fclose(fileId);
    catch
    end
end
