// Lightweight in-memory event bus for streaming samples and device events.

export type Sample = { deviceId: string; t: number; values: number[]; kind?: string };

type Listener<T> = (payload: T) => void;

class Emitter<T> {
  private listeners: Set<Listener<T>> = new Set();
  emit(v: T) {
    for (const l of this.listeners) {
      try {
        l(v);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[dataBus] listener error", e);
      }
    }
  }
  on(l: Listener<T>) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

const sampleEmitter = new Emitter<Sample>();

export function publishSample(s: Sample) {
  sampleEmitter.emit(s);
}

export function onSample(l: Listener<Sample>) {
  return sampleEmitter.on(l);
}
