import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb, getById } from './db.js';
import { bus } from './events.js';
import { verifySignature, parseWebhook, fetchSenderName } from './meta.js';
import { receiveInquiry, replyToInquiry, closeInquiry } from './inquiries.js';
import * as orders from './orders.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// Przetwarzanie zapytań w tle – webhook Meta musi dostać 200 szybko.
function processInBackground(db, data) {
  receiveInquiry(db, data).catch((err) => console.error('[Zapytanie] błąd przetwarzania:', err));
}

export function createApp(db) {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));

  // ───────────── Webhooki (bez hasła panelu) ─────────────

  // Weryfikacja webhooka w Meta for Developers
  app.get('/webhooks/meta', (req, res) => {
    const ok =
      req.query['hub.mode'] === 'subscribe' &&
      config.meta.verifyToken &&
      safeEqual(req.query['hub.verify_token'] ?? '', config.meta.verifyToken);
    return ok ? res.status(200).send(req.query['hub.challenge']) : res.sendStatus(403);
  });

  app.post('/webhooks/meta', async (req, res) => {
    if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(401);
    res.sendStatus(200);
    for (const m of parseWebhook(req.body)) {
      const senderName = await fetchSenderName(m.senderId);
      processInBackground(db, { source: m.source, senderId: m.senderId, senderName, message: m.text });
    }
  });

  // Inne źródła (formularz na stronie, e-mail przez Make/Zapier itp.)
  app.post('/webhooks/zapytanie', (req, res) => {
    if (!config.inboundApiKey || !safeEqual(req.get('x-api-key') ?? '', config.inboundApiKey)) {
      return res.sendStatus(401);
    }
    const { source, name, contact, message } = req.body ?? {};
    if (!message) return res.status(400).json({ error: 'Pole "message" jest wymagane' });
    processInBackground(db, { source: source || 'www', senderName: name, contact, message });
    res.status(202).json({ ok: true });
  });

  // ───────────── Panel (chroniony hasłem, jeśli ustawiono APP_PASSWORD) ─────────────

  app.use((req, res, next) => {
    if (!config.appPassword) return next();
    const [scheme, encoded] = (req.get('authorization') || '').split(' ');
    const pass = scheme === 'Basic' ? Buffer.from(encoded || '', 'base64').toString().split(':').slice(1).join(':') : '';
    if (safeEqual(pass, config.appPassword)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Cukiernia", charset="UTF-8"').sendStatus(401);
  });

  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

  const api = express.Router();
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) console.error(err);
      res.status(status).json({ error: err.message });
    }
  };
  const idParam = (req) => Number(req.params.id);

  api.get('/config', wrap(() => ({
    bakeryName: config.bakeryName,
    aiEnabled: Boolean(config.ai.apiKey),
    aiAutoReply: config.ai.autoReply,
    smsProvider: config.sms.provider === 'smsapi' && config.sms.token ? 'smsapi' : 'symulacja',
    metaConnected: Boolean(config.meta.pageToken),
    pickupReminderHours: config.pickupReminderHours,
  })));

  api.get('/summary', wrap(() => {
    const count = (sql, ...p) => db.prepare(sql).get(...p).n;
    return {
      zapytaniaDoMnie: count("SELECT COUNT(*) n FROM inquiries WHERE status = 'do_mnie'"),
      zapytaniaNowe: count("SELECT COUNT(*) n FROM inquiries WHERE status = 'nowe'"),
      zamowieniaNowe: count("SELECT COUNT(*) n FROM orders WHERE status = 'nowe'"),
      doOddzwonienia: count("SELECT COUNT(*) n FROM orders WHERE status = 'do_oddzwonienia'"),
      wRealizacji: count("SELECT COUNT(*) n FROM orders WHERE status IN ('w_realizacji','gotowe','w_dostawie')"),
    };
  }));

  // Zapytania
  api.get('/inquiries', wrap((req) => {
    const status = req.query.status;
    const rows = status
      ? db.prepare('SELECT * FROM inquiries WHERE status = ? ORDER BY id DESC LIMIT 200').all(status)
      : db.prepare('SELECT * FROM inquiries ORDER BY id DESC LIMIT 200').all();
    return rows;
  }));
  api.post('/inquiries', wrap(async (req) => {
    const { source, name, contact, message } = req.body ?? {};
    if (!message) throw Object.assign(new Error('Wpisz treść zapytania'), { status: 400 });
    return receiveInquiry(db, { source: source || 'telefon', senderName: name, contact, message });
  }));
  api.post('/inquiries/:id/reply', wrap((req) => replyToInquiry(db, idParam(req), req.body?.text)));
  api.post('/inquiries/:id/close', wrap((req) => closeInquiry(db, idParam(req))));

  // Zamówienia
  api.get('/orders', wrap((req) => {
    const statuses = String(req.query.status || '').split(',').filter(Boolean);
    if (!statuses.length) return db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 300').all();
    const ph = statuses.map(() => '?').join(',');
    return db
      .prepare(`SELECT * FROM orders WHERE status IN (${ph}) ORDER BY COALESCE(due_at, created_at) ASC LIMIT 300`)
      .all(...statuses);
  }));
  api.get('/orders/:id', wrap((req) => {
    const o = getById(db, 'orders', idParam(req));
    if (!o) throw new orders.OrderError('Nie znaleziono zamówienia', 404);
    const sms = db.prepare('SELECT * FROM sms_log WHERE order_id = ? ORDER BY id').all(o.id);
    return { ...o, sms };
  }));
  api.post('/orders', wrap((req) => orders.createOrder(db, req.body ?? {})));
  api.patch('/orders/:id', wrap((req) => orders.editOrder(db, idParam(req), req.body ?? {})));
  api.post('/orders/:id/approve', wrap((req) => orders.approve(db, idParam(req))));
  api.post('/orders/:id/callback', wrap((req) => orders.requestCallback(db, idParam(req), req.body?.reason)));
  api.post('/orders/:id/ready', wrap((req) => orders.markReady(db, idParam(req))));
  api.post('/orders/:id/delivery', wrap((req) => orders.scheduleDelivery(db, idParam(req), req.body?.eta)));
  api.post('/orders/:id/delivered', wrap((req) => orders.markDelivered(db, idParam(req))));
  api.post('/orders/:id/picked-up', wrap((req) => orders.markPickedUp(db, idParam(req))));
  api.post('/orders/:id/cancel', wrap((req) => orders.cancel(db, idParam(req))));

  api.get('/sms', wrap(() => db.prepare('SELECT * FROM sms_log ORDER BY id DESC LIMIT 200').all()));

  // Powiadomienia na żywo
  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    bus.on('event', send);
    req.on('close', () => {
      clearInterval(ping);
      bus.off('event', send);
    });
  });

  app.use('/api', api);
  return app;
}

// Uruchomienie bezpośrednie: `npm start`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb(config.dbPath);
  const app = createApp(db);

  const tick = () =>
    orders.sendPickupReminders(db).catch((err) => console.error('[Przypomnienia] błąd:', err));
  setInterval(tick, config.schedulerIntervalMs);
  tick();

  app.listen(config.port, () => {
    console.log(`${config.bakeryName} – panel działa na http://localhost:${config.port}`);
    if (!config.ai.apiKey) console.log('  ⚠ Brak ANTHROPIC_API_KEY – wszystkie zapytania trafią do Ciebie.');
    if (config.sms.provider !== 'smsapi' || !config.sms.token) console.log('  ⚠ SMS w trybie symulacji.');
  });
}
