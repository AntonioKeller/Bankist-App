import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'node:fs';
import { config } from './config.js';

const client = config.ai.apiKey ? new Anthropic({ apiKey: config.ai.apiKey }) : null;

function knowledge() {
  const p = config.ai.knowledgePath;
  return existsSync(p) ? readFileSync(p, 'utf8') : '(brak pliku z wiedzą o cukierni)';
}

// Schemat odpowiedzi AI – wymuszony przez structured outputs.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kategoria', 'decyzja', 'powod', 'odpowiedz', 'zamowienie'],
  properties: {
    kategoria: { type: 'string', enum: ['pytanie', 'zamowienie', 'reklamacja', 'inne'] },
    decyzja: { type: 'string', enum: ['odpowiedz', 'do_wlasciciela'] },
    powod: { type: 'string', description: 'Krótko: dlaczego taka decyzja (dla właściciela).' },
    odpowiedz: {
      type: 'string',
      description: 'Gotowa odpowiedź do klienta. Przy decyzji do_wlasciciela – propozycja szkicu.',
    },
    zamowienie: {
      type: 'object',
      additionalProperties: false,
      description: 'Dane zamówienia – wypełnij, gdy kategoria = zamowienie. Nieznane pola zostaw jako pusty tekst.',
      required: ['klient', 'telefon', 'produkt', 'szczegoly', 'termin', 'sposob', 'adres', 'brakuje'],
      properties: {
        klient: { type: 'string' },
        telefon: { type: 'string' },
        produkt: { type: 'string' },
        szczegoly: { type: 'string', description: 'Smak, waga/liczba porcji, napis, dekoracje itp.' },
        termin: { type: 'string', description: 'Czas lokalny w formacie 2026-10-04T15:00 albo pusty tekst' },
        sposob: { type: 'string', enum: ['odbior', 'dostawa', 'nieznany'] },
        adres: { type: 'string' },
        brakuje: {
          type: 'array',
          items: { type: 'string' },
          description: 'Czego brakuje, aby zamówienie było kompletne (pusta lista = kompletne).',
        },
      },
    },
  },
};

function systemPrompt() {
  return `Jesteś asystentem obsługi klienta w firmie ${config.bakeryName} (cukiernia).
Odpowiadasz na wiadomości klientów z Facebooka, Instagrama i innych źródeł – po polsku, uprzejmie, ciepło i krótko (2–4 zdania), bez wymyślania faktów.

Poniżej wiedza o cukierni. Opieraj się WYŁĄCZNIE na niej:
<wiedza>
${knowledge()}
</wiedza>

Zasady decyzji:
- "odpowiedz" – proste sprawy, na które znasz odpowiedź z wiedzy powyżej (godziny, oferta, ceny z cennika, jak zamówić, dostawa).
- "do_wlasciciela" – wszystko, co wymaga decyzji człowieka: reklamacje i skargi, niestandardowe torty i wyceny spoza cennika, alergie/zdrowie, rabaty, zamówienia hurtowe/firmowe, pilne terminy (na dziś/jutro), sprawy prawne, gdy brakuje Ci informacji albo nie masz pewności.
  W takim wypadku i tak napisz szkic odpowiedzi – właściciel go poprawi.
- Jeśli wiadomość to zamówienie: kategoria "zamowienie", wypełnij pole "zamowienie" tym, co da się wyczytać,
  a w "brakuje" wypisz brakujące dane (produkt, termin, telefon, sposób odbioru, adres przy dostawie, szczegóły jak napis/smak/waga).
  Odpowiedz klientowi, że przyjęliśmy zamówienie do weryfikacji, i dopytaj o brakujące dane. Nigdy nie potwierdzaj terminu na 100%.
Dzisiejsza data: ${new Date().toLocaleDateString('pl-PL', { timeZone: config.timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`;
}

const FALLBACK = (powod) => ({
  kategoria: 'inne',
  decyzja: 'do_wlasciciela',
  powod,
  odpowiedz: '',
  zamowienie: null, // przy awarii AI nie tworzymy zamówienia automatycznie
});

/**
 * Analizuje zapytanie klienta. Zwraca obiekt zgodny z SCHEMA.
 * W razie braku klucza / błędu API sprawa zawsze trafia do właściciela.
 */
export async function analyzeInquiry({ message, senderName, source }) {
  if (!client) return FALLBACK('AI nie jest skonfigurowane (brak ANTHROPIC_API_KEY)');

  try {
    const response = await client.beta.messages.create({
      model: config.ai.model,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: systemPrompt(),
      messages: [
        {
          role: 'user',
          content: `Źródło: ${source}\nNadawca: ${senderName || 'nieznany'}\n\nWiadomość klienta:\n${message}`,
        },
      ],
    });

    if (response.stop_reason === 'refusal') return FALLBACK('AI odmówiło odpowiedzi – sprawdź ręcznie');
    if (response.stop_reason === 'max_tokens') return FALLBACK('Odpowiedź AI została ucięta');

    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) return FALLBACK('Pusta odpowiedź AI');
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return FALLBACK('AI chwilowo przeciążone (limit zapytań)');
    if (err instanceof Anthropic.APIError) return FALLBACK(`Błąd API AI: ${err.status ?? ''} ${err.message}`);
    if (err instanceof SyntaxError) return FALLBACK('Nie udało się odczytać odpowiedzi AI');
    throw err;
  }
}
