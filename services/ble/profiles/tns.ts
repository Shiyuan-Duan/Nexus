// TNS profile placeholder: service + characteristics

export const TNS_SERVICE_UUID = "a0a4c680-96be-4222-b41e-98ea76b0120c";

// Add real characteristic UUIDs as they are defined on the firmware
export const TNS_CHAR_SWITCH = "a0a4c681-96be-4222-b41e-98ea76b0120c";
export const TNS_CHAR_AMPLITUDE = "a0a4c682-96be-4222-b41e-98ea76b0120c";
export const TNS_CHAR_RESERVED = "a0a4c683-96be-4222-b41e-98ea76b0120c";

export const TNS_CHARACTERISTICS: { uuid: string; name: string; rw: "r" | "w" | "rw" }[] = [
  { uuid: TNS_CHAR_SWITCH, name: "Switch", rw: "rw" },
  { uuid: TNS_CHAR_AMPLITUDE, name: "Amplitude", rw: "rw" },
  { uuid: TNS_CHAR_RESERVED, name: "Reserved", rw: "r" },
];

export type TnsCharacteristic = typeof TNS_CHARACTERISTICS[number];
