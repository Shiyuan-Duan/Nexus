function mechanical_sensor_print_xyz(deviceId)
% Print live MLX x/y/z samples to the MATLAB command window.
%
% Example:
%   mechanical_sensor_print_xyz
%   mechanical_sensor_print_xyz("mech50")
%
% Stop with Ctrl+C. The cleanup handler will try to send STREAM_OFF.

    if nargin < 1 || strlength(string(deviceId)) == 0
        deviceId = "mech50";
    else
        deviceId = string(deviceId);
    end

    SERVICE_UUID = "a0a4e690-96be-4222-b41e-98ea76b0120c";
    CHAR_STREAM_UUID = "a0a4e691-96be-4222-b41e-98ea76b0120c";
    CHAR_CTRL_UUID = "a0a4e692-96be-4222-b41e-98ea76b0120c";

    CMD_STREAM_OFF = uint8(1);
    CMD_STREAM_ON = uint8(2);

    bleObj = [];
    ctrlChar = [];
    streamChar = [];
    startTic = tic;
    sampleCount = 0;
    cleanupObj = onCleanup(@cleanupAll); %#ok<NASGU>

    fprintf('[%s] MechanicalSensor live MLX printer\n', timestampNow());
    fprintf('[%s] device=%s\n', timestampNow(), deviceId);

    bleObj = ble(deviceId);
    ctrlChar = characteristic(bleObj, SERVICE_UUID, CHAR_CTRL_UUID);
    streamChar = characteristic(bleObj, SERVICE_UUID, CHAR_STREAM_UUID);

    streamChar.DataAvailableFcn = @onMlxData;
    subscribe(streamChar, "notification");
    write(ctrlChar, CMD_STREAM_ON, "uint8");

    fprintf('[%s] STREAM_ON sent. Printing x y z ...\n', timestampNow());

    while true
        pause(0.1);
        drawnow limitrate;
    end

    function onMlxData(src, ~)
        data = read(src, 'oldest');
        data = uint8(data);
        if numel(data) < 12
            return;
        end

        tMs = typecast(uint8(data(1:4)), 'uint32');
        vals = typecast(uint8(data(5:10)), 'int16');
        stat1 = uint8(data(11));
        stat2 = uint8(data(12));
        sampleCount = sampleCount + 1;

        fprintf('[t+%.3f] #%d dev_ms=%u x=%d y=%d z=%d stat1=0x%02X stat2=0x%02X\n', ...
            toc(startTic), ...
            sampleCount, ...
            tMs(1), ...
            vals(1), vals(2), vals(3), ...
            stat1, stat2);
    end

    function cleanupAll()
        try
            if ~isempty(ctrlChar)
                write(ctrlChar, CMD_STREAM_OFF, "uint8");
            end
        catch
        end
        try
            if ~isempty(streamChar)
                unsubscribe(streamChar);
            end
        catch
        end
    end
end

function s = timestampNow()
    s = char(datetime('now', 'Format', 'yyyy-MM-dd HH:mm:ss.SSS'));
end
