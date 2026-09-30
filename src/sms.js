import { config } from './config.js';

// Normalizacja numeru do formatu międzynarodowego (domyślnie Polska, +48).
export function normalizePhone(raw) {
  if (!raw) return '';
  let p = String(raw).replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  else if (p.startsWith('00')) p = p.slice(2);
  if (p.length === 9) p = '48' + p;
  return p;
}

// Driver 'console' – do testów i na start: nic nie wysyła, tylko loguje.
const consoleDriver = {
  async send(to, message) {
    console.log(`[SMS symulacja] do ${to}: ${message}`);
    return { status: 'symulacja', providerId: null };
  },
};

// Driver SMSAPI.pl – https://www.smsapi.pl/docs
const smsapiDriver = {
  async send(to, message) {
    const body = new URLSearchParams({ to, message, format: 'json', encoding: 'utf-8' });
    if (config.sms.sender) body.set('from', config.sms.sender);
    if (config.sms.normalize) body.set('normalize', '1');
    const res = await fetch('https://api.smsapi.pl/sms.do', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.sms.token}` },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.message || `SMSAPI HTTP ${res.status}`);
    return { status: 'wyslany', providerId: data.list?.[0]?.id ?? null };
  },
};

let driver = config.sms.provider === 'smsapi' && config.sms.token ? smsapiDriver : consoleDriver;

// Pozwala podmienić driver w testach.
export function setSmsDriver(d) {
  driver = d;
}

/**
 * Wysyła SMS i zapisuje go w sms_log. Nigdy nie rzuca wyjątku –
 * błąd wysyłki zapisujemy, żeby nie blokował zmiany statusu zamówienia.
 */
export async function sendSms(db, { to, message, orderId = null, kind }) {
  const phone = normalizePhone(to);
  const log = (status, providerId = null, error = null) =>
    db
      .prepare('INSERT INTO sms_log (order_id, kind, phone, body, status, provider_id, error) VALUES (?,?,?,?,?,?,?)')
      .run(orderId, kind, phone, message, status, providerId, error);

  if (!phone) {
    log('blad', null, 'Brak numeru telefonu');
    return { ok: false, error: 'Brak numeru telefonu' };
  }
  try {
    const r = await driver.send(phone, message);
    log(r.status, r.providerId);
    return { ok: true, ...r };
  } catch (err) {
    log('blad', null, err.message);
    console.error('[SMS] błąd wysyłki:', err.message);
    return { ok: false, error: err.message };
  }
}
