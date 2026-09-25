# Samla

Kahoot-klon med realtidsröstning. Byggd live med en klass (wu25) som demo av
AI-assisterad kodning, därefter färdigställd som exempelapp. Eleverna läser SignalR parallellt,
så jämför gärna Socket.IO-begrepp med SignalR (rum = group, emit = SendAsync, hub = namespace).

## Stack

- Node 22, Express 4, Socket.IO 4, nodemailer. ESM (`"type": "module"`).
- Frontend: ren HTML/JS i `public/`, ingen byggsteg, inga ramverk.
- Konton och sessioner sparas i `data/data.json` (`DATA_DIR`, i Docker `/data` som volym).
  Varje konto (e-postadress) har en egen frågebank. Spel lever bara i minnet.
- `questions.json` seedar frågebanken för varje nytt konto.
- QR-koder genereras server-side med paketet `qrcode`.

## Struktur

```
server.js            Express + Socket.IO, inloggning, REST-API för frågor, all spellogik
questions.json       Seed för nya kontons frågebank: { text, options[2..4], correct }
public/index.html    Spelare: namn (kod från QR-länk eller manuellt), svara på mobilen. Länk "Skapa ny omröstning"
public/login.html    Ange e-post → magisk länk skickas
public/expired.html  Visas när en länk är använd eller för gammal
public/admin.html    Värd/admin på /admin (kräver inloggning): frågeeditor, starta omröstning, QR, staplar, sidebar
public/style.css     Delad stil
```

## Inloggning (magisk länk)

1. `/login`: användaren anger e-post → `POST /api/login { email }`.
2. Servern skapar ett engångstoken (30 min) och mejlar `https://<host>/auth/<token>` via SMTP
   (Loopia, `bot@spinnrock.com`). Utan `SMTP_HOST` loggas länken i konsolen i stället.
3. `GET /auth/:token` skapar kontot om det saknas (seedas från `questions.json`), sätter cookien
   `samla_session` (HttpOnly, SameSite=Lax, 30 dagar) och skickar vidare till `/admin`.
4. `/admin`, `/api/questions*`, `/api/me` och `host:create` kräver giltig session, annars
   302 → `/login` respektive 401. Socket.IO läser cookien från handshake-headern.
5. `POST /api/logout` tar bort sessionen. Max en länk per e-post per 30 s.

Miljövariabler: `SMTP_HOST`, `SMTP_PORT` (465 = TLS), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `DATA_DIR`, `PORT`.

## Spelflöde

1. Läraren loggar in, öppnar `/admin`, lägger till eller tar bort frågor (REST mot `/api/questions`).
2. Starta omröstning → `host:create` → spelet får en ögonblicksbild av kontots frågebank och en 4-siffrig kod.
   Admin visar koden och en QR-kod (`/qr/:code`) som leder till `/?code=1234`.
3. Elever scannar, skriver namn → `player:join` → dyker upp i admin-sidebaren via `game:lobby`.
   Servern ger ett `playerId` som klienten sparar i sessionStorage. Vid tappad förbindelse eller
   sidladdning skickas join igen med samma id och eleven får tillbaka sitt namn, sin poäng och
   aktuell fråga. Sen anslutning är tillåten. Dubblettnamn får suffix ("Anna 2").
4. Starta första frågan → `game:question` till rummet.
5. Elever svarar → `player:answer`. Admin får `game:answered` med `counts` och ritar staplar live.
   Staplarna visas direkt när frågan går ut (alla på noll) och uppdateras vid varje svar.
   Spelarna får bara `answered/total`, aldrig fördelningen.
6. Visa resultat → `game:results` (fördelning, rätt svar, topplista). Nästa fråga → steg 4.
7. Efter sista frågan → `game:over` med slutresultat. Spelet tas bort.

Värden får en `hostKey` vid `host:create` (sparas i sessionStorage). Vid reconnect skickas
`host:resume` och servern svarar med en ögonblicksbild av läget. Spelet avslutas först om
värden varit borta i 60 sekunder.

Frågor kan sakna rätt svar (`correct: null`) – då är det en åsiktsomröstning utan poäng.
Poäng: 1000 för rätt svar. Topplista visas bara om spelet har minst en fråga med rätt svar.
Ingen timer.

Svarsfördelningen visas som staplar med antal och procent. Cirkeldiagrammet från lektionen är
borttaget. Färgerna i `:root` är validerade för färgblindhet mot den mörka bakgrunden.

## REST-API

| Metod  | Sökväg               | Body / svar                                  |
|--------|----------------------|----------------------------------------------|
| POST   | `/api/login`         | `{ email }` → `{ ok }`, 400/429 vid fel      |
| GET    | `/auth/:token`       | Sätter sessionscookie, 302 → `/admin`        |
| POST   | `/api/logout`        | `{ ok }`                                     |
| GET    | `/api/me`            | `{ email }` (401 utan session)               |
| GET    | `/api/questions`     | `[{ id, text, options, correct }]` för kontot |
| POST   | `/api/questions`     | `{ text, options[2..4], correct: index|null }` → 201 |
| DELETE | `/api/questions/:id` | 204                                          |
| GET    | `/qr/:code`          | SVG med länk till `/?code=`                  |
| GET    | `/health`            | `{ ok, clients, accounts, games, mail }`     |

## Socket.IO-kontrakt

Klient → server (ack används där svaret behövs direkt):

| Event           | Payload                  | Ack                          |
|-----------------|--------------------------|------------------------------|
| `host:create`   | – (session via cookie)   | `{ code, hostKey }` eller `{ error }` |
| `host:resume`   | `{ code, hostKey }`      | `{ ok, code, state }` eller `{ error }` |
| `host:start`    | `{ code }`               | –                            |
| `host:next`     | `{ code }`               | –                            |
| `player:join`   | `{ code, name, playerId? }` | `{ ok, name, playerId, state }` eller `{ error }` |
| `player:answer` | `{ code, option }`       | –                            |

Server → klient (till rummet `code`):

| Event           | Payload                                                    |
|-----------------|------------------------------------------------------------|
| `game:lobby`    | `{ code, players: [{ name, score, connected }] }`          |
| `game:question` | `{ index, total, text, options }` (aldrig `correct`)       |
| `game:answered` | `{ answered, total }` till spelare, `+ counts` till värden |
| `game:results`  | `{ counts, correct, scored, leaderboard: [{name,score}] }` |
| `game:over`     | `{ scored, leaderboard }`                                  |

Regler: värden ligger i rummet men markeras som `host`, aldrig i `players`.
Skicka aldrig rätt svar till spelare innan `game:results`.

## Kör lokalt

```
npm install
npm run dev        # node --watch, port 3000, mail inaktiv: länken loggas i terminalen
```

Admin: http://localhost:3000/admin – spelare: http://localhost:3000/

## Deploy

Quick app på spinnrock, `samla.spinnrock.com`. Containern måste heta `samla`
och lyssna på port 3000 på nätverket `webnet`, Caddy sköter resten.
SMTP-uppgifterna ligger i `/home/spnrck/scratch/samla/.env` på servern (inte i git).
Data ligger i volymen `samla-data`.

```
scp -r . spnrck.spinnrock.com:/home/spnrck/scratch/samla/   # exkl. node_modules, data, .env
ssh spnrck.spinnrock.com 'cd /home/spnrck/scratch/samla && docker build -t samla . && docker rm -f samla; docker run -d --name samla --network webnet --restart unless-stopped --env-file .env -v samla-data:/data samla'
curl https://samla.spinnrock.com/health    # {"ok":true,...,"mail":true}, 302 → www = containern svarar inte
```

## Lärdomar från lektionen 2026-09-25

- `el.onkeydown = (e) => e.key === "Enter" && ...` blockerade all inmatning: ett `false` från en
  `on*`-egenskap avbryter händelsen. Skriv `if (...)` i stället. Playwright `fill()` går inte via
  keydown, så testa inmatning med `keyboard.type()`.
- Mobiler tappar socketen så fort skärmen släcks. Allt som identifierar en elev måste överleva
  ett nytt socket-id.

## Arbetssätt

- Svenska i kod-kommentarer, UI och dokumentation.
- Håll det litet: en fil per roll, ingen abstraktion som inte behövs.
- Verifiera alltid med `/health` och två webbläsarflikar (admin + spelare) innan något kallas klart.
