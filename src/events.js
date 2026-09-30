import { EventEmitter } from 'node:events';

// Szyna zdarzeń dla powiadomień na żywo w panelu (Server-Sent Events).
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function notify(type, payload = {}) {
  bus.emit('event', { type, at: new Date().toISOString(), ...payload });
}
