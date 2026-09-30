import { insert, update, getById, nowIso } from './db.js';
import { analyzeInquiry } from './ai.js';
import { sendMetaMessage } from './meta.js';
import { sendSms } from './sms.js';
import { createOrder } from './orders.js';
import { localToIso } from './templates.js';
import { notify } from './events.js';
import { config } from './config.js';

const META_SOURCES = ['facebook', 'instagram'];

/** Czy możemy automatycznie odpisać w tym kanale? */
function canAutoSend(inq) {
  return META_SOURCES.includes(inq.source) && inq.sender_id && config.meta.pageToken;
}

async function deliverReply(inq, text) {
  if (META_SOURCES.includes(inq.source) && inq.sender_id) {
    await sendMetaMessage(inq.sender_id, text);
    return true;
  }
  // Inne źródła (www, e-mail, telefon): odpowiedź wysyła właściciel ręcznie –
  // w panelu zapisujemy tylko treść, którą przekazano.
  return false;
}

/** Tworzy zamówienie na podstawie danych wyciągniętych przez AI. */
function orderFromAi(db, inq, z) {
  const brakuje = z.brakuje ?? [];
  const fulfillment = z.sposob === 'dostawa' ? 'dostawa' : 'odbior';
  if (z.sposob === 'nieznany' && !brakuje.some((b) => /odbi|dostaw/i.test(b))) brakuje.push('sposób odbioru');
  if (!z.telefon && !inq.contact && !brakuje.some((b) => /telefon/i.test(b))) brakuje.push('telefon');

  return createOrder(db, {
    customer_name: z.klient || inq.sender_name,
    phone: z.telefon || inq.contact,
    product: z.produkt,
    details: z.szczegoly,
    due_at: localToIso(z.termin),
    fulfillment,
    address: z.adres,
    notes: `Z wiadomości (${inq.source}): „${inq.message}”`,
    source: inq.source,
    inquiry_id: inq.id,
    status: brakuje.length ? 'do_oddzwonienia' : 'nowe',
    callback_reason: brakuje.length ? `Brakuje: ${brakuje.join(', ')}` : null,
  });
}

/**
 * Główny przepływ dla nowego zapytania:
 *   1. zapis + powiadomienie w panelu,
 *   2. analiza AI,
 *   3. prosta sprawa → AI odpowiada (auto, jeśli kanał na to pozwala),
 *      trudna sprawa → trafia do właściciela (+ opcjonalny SMS do właściciela),
 *   4. jeśli to zamówienie → zakładamy je w sekcji Zamówienia.
 */
export async function receiveInquiry(
  db,
  { source, senderId, senderName, contact, message },
  { analyze = analyzeInquiry } = {},
) {
  const id = insert(db, 'inquiries', {
    source: source || 'inne',
    sender_id: senderId ?? null,
    sender_name: senderName ?? null,
    contact: contact ?? null,
    message,
  });
  notify('nowe_zapytanie', { inquiryId: id });

  let inq = getById(db, 'inquiries', id);
  const ai = await analyze({ message, senderName, source: inq.source });

  let status = ai.decyzja === 'odpowiedz' ? 'nowe' : 'do_mnie';
  const fields = {
    ai_category: ai.kategoria,
    ai_decision: ai.decyzja,
    ai_reason: ai.powod,
    ai_reply: ai.odpowiedz || null,
  };

  if (ai.kategoria === 'zamowienie' && ai.zamowienie) {
    const order = orderFromAi(db, inq, ai.zamowienie);
    fields.order_id = order.id;
  }

  if (ai.decyzja === 'odpowiedz' && ai.odpowiedz && config.ai.autoReply && canAutoSend(inq)) {
    try {
      await deliverReply(inq, ai.odpowiedz);
      Object.assign(fields, { final_reply: ai.odpowiedz, replied_at: nowIso() });
      status = 'odpowiedziane';
    } catch (err) {
      console.error('[Meta] nie udało się wysłać odpowiedzi:', err.message);
      status = 'do_mnie';
      fields.ai_reason = `${ai.powod} (Nie udało się wysłać automatycznie: ${err.message})`;
    }
  }

  update(db, 'inquiries', id, { ...fields, status });
  inq = getById(db, 'inquiries', id);

  if (status === 'do_mnie') {
    notify('zapytanie_do_mnie', { inquiryId: id });
    if (config.ownerPhone) {
      await sendSms(db, {
        to: config.ownerPhone,
        kind: 'wlasciciel',
        message: `Panel ${config.bakeryName}: zapytanie #${id} (${inq.source}) wymaga Twojej odpowiedzi. ${ai.powod}`.slice(0, 300),
      });
    }
  } else {
    notify('zapytanie_zmiana', { inquiryId: id });
  }
  return inq;
}

/** Właściciel (lub zatwierdzony szkic AI) odpowiada na zapytanie. */
export async function replyToInquiry(db, id, text) {
  const inq = getById(db, 'inquiries', id);
  if (!inq) throw Object.assign(new Error('Nie znaleziono zapytania'), { status: 404 });
  if (!text?.trim()) throw Object.assign(new Error('Treść odpowiedzi jest pusta'), { status: 400 });
  const sent = await deliverReply(inq, text.trim());
  update(db, 'inquiries', id, { final_reply: text.trim(), replied_at: nowIso(), status: 'odpowiedziane' });
  notify('zapytanie_zmiana', { inquiryId: id });
  return { inquiry: getById(db, 'inquiries', id), sentToChannel: sent };
}

export function closeInquiry(db, id) {
  if (!getById(db, 'inquiries', id)) throw Object.assign(new Error('Nie znaleziono zapytania'), { status: 404 });
  update(db, 'inquiries', id, { status: 'zamkniete' });
  notify('zapytanie_zmiana', { inquiryId: id });
  return getById(db, 'inquiries', id);
}
