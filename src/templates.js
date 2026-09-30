import { config } from './config.js';

export function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('pl-PL', {
    timeZone: config.timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Treści SMS-ów. Krótko – żeby zmieścić się w 1–2 SMS-ach.
export const smsTemplates = {
  // Dostawa
  gotowe: (o) =>
    `${config.bakeryName}: Twoje zamówienie nr ${o.id} jest gotowe. Wkrótce podamy termin dostawy. Dziękujemy!`,
  termin_dostawy: (o) =>
    `${config.bakeryName}: Zamówienie nr ${o.id} dostarczymy ${formatDateTime(o.delivery_eta)}` +
    (o.address ? ` pod adres: ${o.address}` : '') +
    '. Do zobaczenia!',
  dostarczone: (o) =>
    `${config.bakeryName}: Zamówienie nr ${o.id} zostało dostarczone. Smacznego i dziękujemy za zaufanie!`,

  // Odbiór osobisty
  gotowe_odbior: (o) =>
    `${config.bakeryName}: Twoje zamówienie nr ${o.id} jest gotowe do odbioru. Zapraszamy!`,
  przypomnienie: (o) =>
    `${config.bakeryName}: Przypominamy - zamówienie nr ${o.id} czeka na odbiór. Zapraszamy!`,
};

/**
 * Zamienia czas lokalny (np. "2026-10-04T15:00" w strefie cukierni) na ISO UTC.
 * Zwraca null, gdy tekst nie jest poprawną datą.
 */
export function localToIso(local, timeZone = config.timeZone) {
  if (!local) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(local)) {
    const d = new Date(local);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const asUtc = new Date(local + (local.length <= 10 ? 'T12:00' : '') + 'Z');
  if (Number.isNaN(asUtc.getTime())) return null;
  // Przesunięcie strefy w tym momencie (uwzględnia czas letni/zimowy).
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(asUtc).map((p) => [p.type, p.value]),
  );
  const zoned = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return new Date(asUtc.getTime() - (zoned - asUtc.getTime())).toISOString();
}
