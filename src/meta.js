import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/** Weryfikacja podpisu X-Hub-Signature-256 (jeśli ustawiono META_APP_SECRET). */
export function verifySignature(rawBody, header) {
  if (!config.meta.appSecret) return true;
  if (!header || !rawBody) return false;
  const expected = 'sha256=' + createHmac('sha256', config.meta.appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Wyciąga wiadomości tekstowe z webhooka Messengera / Instagrama.
 * Zwraca [{ source, senderId, text }].
 */
export function parseWebhook(body) {
  const source = body?.object === 'instagram' ? 'instagram' : 'facebook';
  const out = [];
  for (const entry of body?.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const msg = ev.message;
      if (!msg || msg.is_echo || !msg.text) continue;
      out.push({ source, senderId: ev.sender?.id, text: msg.text });
    }
  }
  return out;
}

/** Wysyła odpowiedź do klienta przez Send API (Messenger / Instagram). */
export async function sendMetaMessage(recipientId, text) {
  if (!config.meta.pageToken) throw new Error('Brak META_PAGE_TOKEN – nie można wysłać odpowiedzi do Meta');
  const url = `https://graph.facebook.com/${config.meta.graphVersion}/me/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.meta.pageToken}` },
    body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text } }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || `Meta HTTP ${res.status}`);
  }
}

/** Pobiera imię i nazwisko nadawcy (opcjonalne – jeśli się nie uda, zwraca null). */
export async function fetchSenderName(senderId) {
  if (!config.meta.pageToken || !senderId) return null;
  try {
    const url = `https://graph.facebook.com/${config.meta.graphVersion}/${senderId}?fields=name`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${config.meta.pageToken}` } });
    if (!res.ok) return null;
    return (await res.json()).name ?? null;
  } catch {
    return null;
  }
}
