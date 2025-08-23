// Simple API client stubs (no real network calls yet)

export async function get<T = unknown>(url: string, _opts?: Record<string, unknown>): Promise<T> {
  void url;
  return {} as T;
}

export async function post<T = unknown>(url: string, _body?: unknown, _opts?: Record<string, unknown>): Promise<T> {
  void url;
  return {} as T;
}

