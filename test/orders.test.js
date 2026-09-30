import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import * as orders from '../src/orders.js';

const base = { customer_name: 'Anna', phone: '600 100 200', product: 'Tort czekoladowy 2 kg' };

test('poprawne zamówienie trafia do realizacji', () => {
  const { db } = setup();
  const o = orders.createOrder(db, base);
  assert.equal(o.status, 'nowe');
  assert.equal(orders.approve(db, o.id).status, 'w_realizacji');
});

test('zamówienie do doprecyzowania trafia do oddzwonienia, a potem do realizacji', () => {
  const { db } = setup();
  const o = orders.createOrder(db, base);
  const cb = orders.requestCallback(db, o.id, 'Jaki napis?');
  assert.equal(cb.status, 'do_oddzwonienia');
  assert.equal(cb.callback_reason, 'Jaki napis?');
  const ok = orders.approve(db, o.id);
  assert.equal(ok.status, 'w_realizacji');
  assert.equal(ok.callback_reason, null);
});

test('nie da się wysłać do realizacji bez telefonu albo adresu przy dostawie', () => {
  const { db } = setup();
  const a = orders.createOrder(db, { ...base, phone: '' });
  assert.throws(() => orders.approve(db, a.id), /telefon/);
  const b = orders.createOrder(db, { ...base, fulfillment: 'dostawa' });
  assert.throws(() => orders.approve(db, b.id), /adres/);
});

test('dostawa: gotowe → termin → dostarczone, 3 SMS-y', async () => {
  const { db, sent } = setup();
  const o = orders.createOrder(db, { ...base, fulfillment: 'dostawa', address: 'ul. Słodka 1' });
  orders.approve(db, o.id);

  const r1 = await orders.markReady(db, o.id);
  assert.equal(r1.order.status, 'gotowe');
  assert.match(sent[0].message, /jest gotowe/);
  assert.equal(sent[0].to, '48600100200');

  const r2 = await orders.scheduleDelivery(db, o.id, '2026-10-04T13:00:00Z');
  assert.equal(r2.order.status, 'w_dostawie');
  assert.match(sent[1].message, /dostarczymy 04\.10.*15:00.*ul\. Słodka 1/);

  const r3 = await orders.markDelivered(db, o.id);
  assert.equal(r3.order.status, 'dostarczone');
  assert.match(sent[2].message, /zostało dostarczone/);

  const log = db.prepare('SELECT kind FROM sms_log WHERE order_id = ? ORDER BY id').all(o.id).map((r) => r.kind);
  assert.deepEqual(log, ['gotowe', 'termin_dostawy', 'dostarczone']);
});

test('odbiór osobisty: SMS "gotowe do odbioru", przypomnienie dopiero po 12 h i tylko raz', async () => {
  const { db, sent } = setup();
  const o = orders.createOrder(db, base);
  orders.approve(db, o.id);
  await orders.markReady(db, o.id);
  assert.match(sent[0].message, /gotowe do odbioru/);

  const readyAt = new Date(db.prepare('SELECT ready_at FROM orders WHERE id = ?').get(o.id).ready_at);
  const h = (n) => new Date(readyAt.getTime() + n * 3600_000);

  assert.equal((await orders.sendPickupReminders(db, h(11.9))).length, 0);
  assert.equal((await orders.sendPickupReminders(db, h(12))).length, 1);
  assert.match(sent[1].message, /Przypominamy/);
  assert.equal((await orders.sendPickupReminders(db, h(30))).length, 0, 'drugi raz nie wysyłamy');

  assert.equal(orders.markPickedUp(db, o.id).status, 'odebrane');
});

test('odebrane przed upływem 12 h → bez przypomnienia', async () => {
  const { db, sent } = setup();
  const o = orders.createOrder(db, base);
  orders.approve(db, o.id);
  await orders.markReady(db, o.id);
  orders.markPickedUp(db, o.id);
  const res = await orders.sendPickupReminders(db, new Date(Date.now() + 48 * 3600_000));
  assert.equal(res.length, 0);
  assert.equal(sent.length, 1);
});

test('błędne przejścia statusów są blokowane', async () => {
  const { db } = setup();
  const o = orders.createOrder(db, base);
  await assert.rejects(orders.markReady(db, o.id), /Niedozwolona/);
  orders.approve(db, o.id);
  await orders.markReady(db, o.id);
  await assert.rejects(orders.scheduleDelivery(db, o.id, '2026-10-04T13:00:00Z'), /odbiorem osobistym/);
  assert.throws(() => orders.markPickedUp(db, 999), /Nie znaleziono/);
});

test('błąd bramki SMS nie cofa zmiany statusu, ale jest zapisany', async () => {
  const { db } = setup();
  const { setSmsDriver } = await import('../src/sms.js');
  setSmsDriver({ send: async () => { throw new Error('Brak środków'); } });
  const o = orders.createOrder(db, base);
  orders.approve(db, o.id);
  const r = await orders.markReady(db, o.id);
  assert.equal(r.order.status, 'gotowe');
  assert.equal(r.sms.ok, false);
  assert.equal(db.prepare('SELECT status, error FROM sms_log').get().error, 'Brak środków');
});
