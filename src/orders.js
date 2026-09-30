import { getById, insert, update, nowIso } from './db.js';
import { sendSms } from './sms.js';
import { smsTemplates } from './templates.js';
import { notify } from './events.js';
import { config } from './config.js';

/*
 * Cykl życia zamówienia
 *
 *   nowe ──(zatwierdź)──────────────► w_realizacji
 *     └──(wymaga doprecyzowania)──► do_oddzwonienia ──(zatwierdź)──► w_realizacji
 *
 *   DOSTAWA:  w_realizacji ─(gotowe, SMS)─► gotowe ─(termin, SMS)─► w_dostawie ─(dostarczono, SMS)─► dostarczone
 *   ODBIÓR:   w_realizacji ─(gotowe, SMS)─► gotowe ─(odebrane)─► odebrane
 *             + po 12 h bez odbioru automatyczne SMS-przypomnienie (scheduler.js)
 */
export const STATUSES = [
  'nowe',
  'do_oddzwonienia',
  'w_realizacji',
  'gotowe',
  'w_dostawie',
  'dostarczone',
  'odebrane',
  'anulowane',
];

export class OrderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const EDITABLE = ['customer_name', 'phone', 'product', 'details', 'due_at', 'fulfillment', 'address', 'notes'];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k] === '' ? null : obj[k];
  return out;
}

function load(db, id) {
  const o = getById(db, 'orders', id);
  if (!o) throw new OrderError('Nie znaleziono zamówienia', 404);
  return o;
}

function requireStatus(order, ...allowed) {
  if (!allowed.includes(order.status)) {
    throw new OrderError(`Niedozwolona operacja dla statusu „${order.status}”`, 409);
  }
}

function validateFulfillment(v) {
  if (v !== undefined && !['odbior', 'dostawa'].includes(v)) {
    throw new OrderError('Sposób realizacji musi być „odbior” albo „dostawa”');
  }
}

export function createOrder(db, data) {
  validateFulfillment(data.fulfillment);
  const status = data.status === 'do_oddzwonienia' ? 'do_oddzwonienia' : 'nowe';
  const id = insert(db, 'orders', {
    ...pick(data, EDITABLE),
    status,
    callback_reason: data.callback_reason || null,
    source: data.source || 'reczne',
    inquiry_id: data.inquiry_id ?? null,
  });
  notify(status === 'do_oddzwonienia' ? 'zamowienie_do_oddzwonienia' : 'nowe_zamowienie', { orderId: id });
  return load(db, id);
}

export function editOrder(db, id, data) {
  const o = load(db, id);
  if (['dostarczone', 'odebrane', 'anulowane'].includes(o.status)) {
    throw new OrderError('Zamówienie jest zamknięte – nie można go edytować', 409);
  }
  validateFulfillment(data.fulfillment);
  update(db, 'orders', id, pick(data, EDITABLE));
  return load(db, id);
}

/** a. Poprawne zamówienie → do realizacji */
export function approve(db, id) {
  const o = load(db, id);
  requireStatus(o, 'nowe', 'do_oddzwonienia');
  if (!o.product) throw new OrderError('Uzupełnij produkt przed wysłaniem do realizacji');
  if (!o.phone) throw new OrderError('Uzupełnij telefon klienta – jest potrzebny do SMS-ów');
  if (o.fulfillment === 'dostawa' && !o.address) throw new OrderError('Uzupełnij adres dostawy');
  update(db, 'orders', id, { status: 'w_realizacji', approved_at: nowIso(), callback_reason: null });
  notify('zamowienie_zmiana', { orderId: id });
  return load(db, id);
}

/** b. Wymaga doprecyzowania → do oddzwonienia */
export function requestCallback(db, id, reason) {
  const o = load(db, id);
  requireStatus(o, 'nowe');
  update(db, 'orders', id, { status: 'do_oddzwonienia', callback_reason: reason || 'Do doprecyzowania' });
  notify('zamowienie_do_oddzwonienia', { orderId: id });
  return load(db, id);
}

/** Zamówienie gotowe → SMS do klienta (treść zależy od sposobu realizacji) */
export async function markReady(db, id) {
  const o = load(db, id);
  requireStatus(o, 'w_realizacji');
  update(db, 'orders', id, { status: 'gotowe', ready_at: nowIso() });
  const updated = load(db, id);
  const kind = updated.fulfillment === 'dostawa' ? 'gotowe' : 'gotowe_odbior';
  const sms = await sendSms(db, { to: updated.phone, message: smsTemplates[kind](updated), orderId: id, kind });
  notify('zamowienie_zmiana', { orderId: id });
  return { order: updated, sms };
}

/** Dostawa: ustalenie terminu → SMS z terminem */
export async function scheduleDelivery(db, id, etaIso) {
  const o = load(db, id);
  if (o.fulfillment !== 'dostawa') throw new OrderError('To zamówienie jest z odbiorem osobistym');
  // Termin można też poprawić, gdy zamówienie jest już „w dostawie” – klient dostanie nowy SMS.
  requireStatus(o, 'gotowe', 'w_dostawie');
  const eta = new Date(etaIso);
  if (!etaIso || Number.isNaN(eta.getTime())) throw new OrderError('Podaj poprawny termin dostawy');
  update(db, 'orders', id, { status: 'w_dostawie', delivery_eta: eta.toISOString() });
  const updated = load(db, id);
  const sms = await sendSms(db, {
    to: updated.phone,
    message: smsTemplates.termin_dostawy(updated),
    orderId: id,
    kind: 'termin_dostawy',
  });
  notify('zamowienie_zmiana', { orderId: id });
  return { order: updated, sms };
}

/** Dostawa: dostarczono → SMS potwierdzający */
export async function markDelivered(db, id) {
  const o = load(db, id);
  if (o.fulfillment !== 'dostawa') throw new OrderError('To zamówienie jest z odbiorem osobistym');
  requireStatus(o, 'w_dostawie');
  update(db, 'orders', id, { status: 'dostarczone', delivered_at: nowIso() });
  const updated = load(db, id);
  const sms = await sendSms(db, {
    to: updated.phone,
    message: smsTemplates.dostarczone(updated),
    orderId: id,
    kind: 'dostarczone',
  });
  notify('zamowienie_zmiana', { orderId: id });
  return { order: updated, sms };
}

/** Odbiór osobisty: klient odebrał */
export function markPickedUp(db, id) {
  const o = load(db, id);
  if (o.fulfillment !== 'odbior') throw new OrderError('To zamówienie jest z dostawą');
  requireStatus(o, 'gotowe');
  update(db, 'orders', id, { status: 'odebrane', picked_up_at: nowIso() });
  notify('zamowienie_zmiana', { orderId: id });
  return load(db, id);
}

export function cancel(db, id) {
  const o = load(db, id);
  if (['dostarczone', 'odebrane', 'anulowane'].includes(o.status)) {
    throw new OrderError('Zamówienie jest już zamknięte', 409);
  }
  update(db, 'orders', id, { status: 'anulowane' });
  notify('zamowienie_zmiana', { orderId: id });
  return load(db, id);
}

/**
 * Wysyła przypomnienia dla zamówień z odbiorem osobistym, które są gotowe
 * od co najmniej `config.pickupReminderHours` godzin i nie zostały odebrane.
 * Każde zamówienie dostaje maksymalnie jedno przypomnienie.
 */
export async function sendPickupReminders(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - config.pickupReminderHours * 3600_000).toISOString();
  const due = db
    .prepare(
      `SELECT * FROM orders
       WHERE status = 'gotowe' AND fulfillment = 'odbior'
         AND reminder_sent_at IS NULL AND ready_at <= ?`,
    )
    .all(cutoff);

  const results = [];
  for (const o of due) {
    // Najpierw oznaczamy, żeby przy równoległym uruchomieniu nie wysłać dwa razy.
    const claimed = db
      .prepare('UPDATE orders SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL')
      .run(nowIso(now), o.id);
    if (!claimed.changes) continue;
    const sms = await sendSms(db, {
      to: o.phone,
      message: smsTemplates.przypomnienie(o),
      orderId: o.id,
      kind: 'przypomnienie',
    });
    notify('przypomnienie_wyslane', { orderId: o.id });
    results.push({ orderId: o.id, sms });
  }
  return results;
}
