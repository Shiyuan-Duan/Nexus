// Storage layer: uses AsyncStorage if available, otherwise falls back to memory.

let asyncStorage: {
  setItem: (key: string, value: string) => Promise<void>;
  getItem: (key: string) => Promise<string | null>;
  removeItem: (key: string) => Promise<void>;
} | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@react-native-async-storage/async-storage");
  asyncStorage = mod?.default ?? mod;
} catch {
  asyncStorage = null;
}

const mem: Record<string, string> = {};

export async function setItem(key: string, value: string): Promise<void> {
  if (asyncStorage) {
    await asyncStorage.setItem(key, value);
    return;
  }
  mem[key] = value;
}

export async function getItem(key: string): Promise<string | null> {
  if (asyncStorage) {
    return asyncStorage.getItem(key);
  }
  return mem.hasOwnProperty(key) ? mem[key] : null;
}

export async function removeItem(key: string): Promise<void> {
  if (asyncStorage) {
    await asyncStorage.removeItem(key);
    return;
  }
  delete mem[key];
}
