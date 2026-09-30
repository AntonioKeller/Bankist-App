import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { receiveInquiry, replyToInquiry } from '../src/inquiries.js';
import { parseWebhook } from '../src/meta.js';
import { createApp } from '../src/server.js';

const aiResult = (over) => async () => ({
  kategoria: 'pytanie',
  decyzja: 'odpowiedz',
  powod: 'Proste pytanie o godziny',
  odpowiedz: 'Zapraszamy pon–pt 8–18.',
  zamowienie: { klient: '', telefon: '', produkt: '', szczegoly: '', termin: '', sposob: 'nieznany', adres: '', brakuje: [] },
  ...over,
});

test('bez klucza AI zapytanie trafia do właściciela', async () => {
  const { db } = setup();
  const q = await receiveInquiry(db, { source: 'www', message: 'Czy macie torty bezglutenowe?' });
  assert.equal(q.status, 'do_mnie');
  assert.match(q.ai_reason, /nie jest skonfigurowane/);
});

test('prosta sprawa: AI przygotowuje odpowiedź (bez tokenu Meta – jako szkic)', async () => {
  const { db } = setup();
  const q = await receiveInquiry(db, { source: 'facebook', senderId: '123', message: 'Do której otwarte?' }, { analyze: aiResult() });
  assert.equal(q.status, 'nowe');
  assert.equal(q.ai_reply, 'Zapraszamy pon–pt 8–18.');
  const { inquiry } = await replyToInquiry(db, q.id, 'Do 18:00!').catch((e) => ({ inquiry: null, e }));
  // Bez META_PAGE_TOKEN wysyłka na Messengera się nie uda – odpowiedź nie jest oznaczona jako wysłana.
  assert.equal(inquiry, null);
});

test('trudna sprawa trafia do właściciela', async () => {
  const { db } = setup();
  const q = await receiveInquiry(
    db,
    { source: 'instagram', senderId: '9', message: 'Tort był nieświeży!' },
    { analyze: aiResult({ kategoria: 'reklamacja', decyzja: 'do_wlasciciela', powod: 'Reklamacja' }) },
  );
  assert.equal(q.status, 'do_mnie');
  assert.equal(q.ai_category, 'reklamacja');
});

test('kompletne zamówienie z wiadomości → Zamówienia / nowe', async () => {
  const { db } = setup();
  const q = await receiveInquiry(
    db,
    { source: 'www', senderName: 'Ola', contact: '501502503', message: 'Tort 2kg malinowy na sobotę 15:00, odbiór' },
    {
      analyze: aiResult({
        kategoria: 'zamowienie',
        zamowienie: { klient: 'Ola', telefon: '501502503', produkt: 'Tort malinowy 2 kg', szczegoly: '', termin: '2026-10-03T15:00', sposob: 'odbior', adres: '', brakuje: [] },
      }),
    },
  );
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(q.order_id);
  assert.equal(o.status, 'nowe');
  assert.equal(o.due_at, '2026-10-03T13:00:00.000Z');
  assert.equal(o.inquiry_id, q.id);
});

test('niekompletne zamówienie → do oddzwonienia z listą braków', async () => {
  const { db } = setup();
  const q = await receiveInquiry(
    db,
    { source: 'facebook', senderId: '5', message: 'Chcę tort na urodziny' },
    {
      analyze: aiResult({
        kategoria: 'zamowienie',
        zamowienie: { klient: '', telefon: '', produkt: 'Tort urodzinowy', szczegoly: '', termin: '', sposob: 'nieznany', adres: '', brakuje: ['termin', 'smak i waga'] },
      }),
    },
  );
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(q.order_id);
  assert.equal(o.status, 'do_oddzwonienia');
  assert.match(o.callback_reason, /termin.*smak i waga.*sposób odbioru.*telefon/);
});

test('parsowanie webhooka Meta pomija echo i wiadomości bez tekstu', () => {
  const msgs = parseWebhook({
    object: 'instagram',
    entry: [{ messaging: [
      { sender: { id: '1' }, message: { text: 'Hej' } },
      { sender: { id: '2' }, message: { text: 'echo', is_echo: true } },
      { sender: { id: '3' }, message: { attachments: [] } },
    ] }],
  });
  assert.deepEqual(msgs, [{ source: 'instagram', senderId: '1', text: 'Hej' }]);
});

test('HTTP: weryfikacja webhooka Meta i klucz API dla innych źródeł', async (t) => {
  const { db } = setup();
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;

  let r = await fetch(`${url}/webhooks/meta?hub.mode=subscribe&hub.verify_token=sekret-weryfikacji&hub.challenge=42`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '42');
  r = await fetch(`${url}/webhooks/meta?hub.mode=subscribe&hub.verify_token=zly&hub.challenge=42`);
  assert.equal(r.status, 403);

  r = await fetch(`${url}/webhooks/zapytanie`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message":"x"}' });
  assert.equal(r.status, 401);
  r = await fetch(`${url}/webhooks/zapytanie`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'klucz-testowy' },
    body: JSON.stringify({ source: 'www', name: 'Jan', message: 'Ile kosztuje tort?' }),
  });
  assert.equal(r.status, 202);

  // Pełny przepływ zamówienia przez API
  const o = await (await fetch(`${url}/api/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_name: 'Ewa', phone: '600000000', product: 'Sernik' }),
  })).json();
  for (const step of ['approve', 'ready']) {
    r = await fetch(`${url}/api/orders/${o.id}/${step}`, { method: 'POST' });
    assert.equal(r.status, 200, step);
  }
  r = await fetch(`${url}/api/orders/${o.id}/delivered`, { method: 'POST' });
  assert.equal(r.status, 400);
  const detail = await (await fetch(`${url}/api/orders/${o.id}`)).json();
  assert.equal(detail.status, 'gotowe');
  assert.equal(detail.sms.length, 1);
});
