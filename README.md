# Cukiernia A.Keller – panel wewnętrzny

Aplikacja do własnego użytku cukierni: zbiera zapytania klientów, odpowiada na proste
sprawy przez AI (Claude), trudne przekazuje właścicielowi, prowadzi zamówienia
i wysyła klientom SMS-y na każdym etapie realizacji.

## Sekcje

### 1. Zapytania / komentarze
- Wiadomości z **Messengera i Instagrama** (webhook Meta) oraz z **innych źródeł**
  (formularz www, e-mail przez Make/Zapier – `POST /webhooks/zapytanie`) trafiają do panelu.
  Można je też dodać ręcznie (np. po telefonie).
- Każda nowa wiadomość = **powiadomienie** w panelu (dymek + powiadomienie systemowe przeglądarki).
- **AI** czyta wiadomość, korzystając z pliku `data/wiedza.md` (oferta, ceny, godziny, dostawa):
  - **prosta sprawa** → AI odpowiada samo (na Messengerze/Instagramie wysyła od razu,
    jeśli `AI_AUTO_REPLY=true`; w innych kanałach zostawia gotowy szkic),
  - **trudna sprawa** (reklamacja, wycena niestandardowa, alergie, pilny termin, brak wiedzy)
    → trafia do zakładki **„Do mnie”** z powodem i szkicem odpowiedzi. Opcjonalnie SMS do właściciela (`OWNER_PHONE`).
  - jeśli wiadomość to **zamówienie** → AI zakłada je w sekcji Zamówienia.

### 2. Zamówienia
- **a. Poprawne zamówienie** → przycisk **„Do realizacji”**.
- **b. Wymaga doprecyzowania** → trafia do listy **„Do oddzwonienia”** (z informacją, czego brakuje,
  i przyciskiem „Zadzwoń”). Po rozmowie: „Edytuj” → „Ustalone – do realizacji”.
- Zamówienia od AI, w których czegoś brakuje, od razu lądują w „Do oddzwonienia”.

### 3. Realizacja
| Rodzaj | Krok | SMS do klienta |
|---|---|---|
| **Dostawa** | Gotowe | „zamówienie jest gotowe” |
| | Ustalenie terminu dostawy | „dostarczymy DD.MM, GG:MM pod adres…” |
| | Dostarczono | „zamówienie zostało dostarczone” |
| **Odbiór osobisty** | Gotowe | „gotowe do odbioru” |
| | brak odbioru po 12 h | automatyczne **przypomnienie** (jedno) |
| | Odebrane | – |

Historia wszystkich SMS-ów (także błędów wysyłki) jest w zakładce **SMS**.

## Uruchomienie

Wymagany Node.js 22.5+ (baza SQLite wbudowana w Node – bez dodatkowej instalacji).

```bash
npm install
cp .env.example .env     # uzupełnij klucze
npm start                # http://localhost:3000
npm test                 # testy
```

Bez żadnych kluczy aplikacja działa w trybie próbnym: SMS-y tylko w logach,
wszystkie zapytania trafiają do Ciebie.

## Konfiguracja (`.env`)

| Zmienna | Opis |
|---|---|
| `APP_PASSWORD` | hasło do panelu (**ustaw na serwerze!**) |
| `ANTHROPIC_API_KEY` | klucz AI z console.anthropic.com |
| `AI_AUTO_REPLY` | `true` – AI samo odpisuje na proste pytania; `false` – tylko szkice |
| `SMS_PROVIDER`, `SMSAPI_TOKEN`, `SMS_SENDER` | bramka SMS [SMSAPI.pl](https://www.smsapi.pl) |
| `META_VERIFY_TOKEN`, `META_APP_SECRET`, `META_PAGE_TOKEN` | integracja Messenger/Instagram |
| `INBOUND_API_KEY` | klucz dla `POST /webhooks/zapytanie` (inne źródła) |
| `OWNER_PHONE` | SMS do Ciebie przy trudnych sprawach |
| `PICKUP_REMINDER_HOURS` | po ilu godzinach przypomnienie o odbiorze (domyślnie 12) |

Treści SMS-ów są w `src/templates.js`, wiedza dla AI w `data/wiedza.md` – **uzupełnij ją**.

## Podłączenie Meta (Messenger + Instagram)
1. developers.facebook.com → aplikacja typu *Business* → produkt **Messenger** (i **Instagram**).
2. Webhook: URL `https://TWOJA-DOMENA/webhooks/meta`, token weryfikacyjny = `META_VERIFY_TOKEN`,
   subskrypcja `messages`.
3. Wygeneruj token strony → `META_PAGE_TOKEN`; sekret aplikacji → `META_APP_SECRET`.

Serwer musi być dostępny z internetu (np. VPS, Railway, Render, Fly.io).

## Inne źródła – przykład
```bash
curl -X POST https://TWOJA-DOMENA/webhooks/zapytanie \
  -H "Content-Type: application/json" -H "x-api-key: $INBOUND_API_KEY" \
  -d '{"source":"www","name":"Anna","contact":"600100200","message":"Ile kosztuje tort 2 kg?"}'
```

## Struktura
```
src/server.js      – serwer HTTP, API panelu, webhooki, harmonogram przypomnień
src/inquiries.js   – przepływ zapytań (AI → odpowiedź / do właściciela / zamówienie)
src/ai.js          – analiza wiadomości przez Claude (structured outputs)
src/orders.js      – statusy zamówień i realizacja + SMS-y + przypomnienia 12 h
src/sms.js         – SMSAPI.pl / symulacja
src/meta.js        – webhook i Send API Meta
public/            – panel (HTML/CSS/JS)
data/wiedza.md     – wiedza o cukierni dla AI
```
