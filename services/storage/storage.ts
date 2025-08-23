// Placeholder storage layer; replace with AsyncStorage/SQLite/FileSystem as needed.

const mem: Record<string, string> = {};

export async function setItem(key: string, value: string): Promise<void> {
  mem[key] = value;
}

export async function getItem(key: string): Promise<string | null> {
  return mem.hasOwnProperty(key) ? mem[key] : null;
}

export async function removeItem(key: string): Promise<void> {
  delete mem[key];
}

