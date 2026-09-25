# Samla

Kahoot-klon med realtidsröstning. Byggd live med en klass (wu25) som demo av
AI-assisterad kodning. Eleverna läser SignalR parallellt, så jämför gärna
Socket.IO-begrepp med SignalR (rum = group, emit = SendAsync, hub = namespace).

## Stack

- Node 22, Express 4, Socket.IO 4. ESM (`"type": "module"`).
- Frontend: ren HTML/JS i `public/`, ingen byggsteg, inga ramverk.
- Allt state i minnet: frågebank (array) och spel (`Map`) i `server.js`. Ingen databas.
- `questions.json` seedar frågebanken vid start. Frågor som läggs till via admin försvinner vid omstart.
- QR-koder genereras server-side med paketet `qrcode`.

## Struktur

```
server.js          Express + Socket.IO, REST-API för frågor, all spellogik
questions.json     Seed för frågebanken: { text, options[2..4], correct }
public/admin.html  Värd/admin på /admin: frågeeditor, starta omröstning, QR, staplar, sidebar
public/index.html  Spelare: namn (kod från QR-länk eller manuellt), svara på mobilen
public/style.css   Delad stil
```

## Spelflöde

1. Läraren öppnar `/admin`, lägger till eller tar bort frågor (REST mot `/api/questions`).
2. Starta omröstning → `host:create` → spelet får en ögonblicksbild av frågebanken och en 4-siffrig kod.
   Admin visar koden och en QR-kod (`/qr/:code`) som leder till `/?code=1234`.
3. Elever scannar, skriver namn → `player:join` → dyker upp i admin-sidebaren via `game:lobby`.
   Servern ger ett `playerId` som klienten sparar i sessionStorage. Vid tappad förbindelse eller
   sidladdning skickas join igen med samma id och eleven får tillbaka sitt namn, sin poäng och
   aktuell fråga. Sen anslutning är tillåten. Dubblettnamn får suffix ("Anna 2").
4. Starta första frågan → `game:question` till rummet.
5. Elever svarar → `player:answer`. Admin får `game:answered` med `counts` och ritar staplar live.
   Spelarna får bara `answered/total`, aldrig fördelningen.
6. Visa resultat → `game:results` (fördelning, rätt svar, topplista). Nästa fråga → steg 4.
7. Efter sista frågan → `game:over` med slutresultat. Spelet tas bort.

Värden får en `hostKey` vid `host:create` (sparas i sessionStorage). Vid reconnect skickas
`host:resume` och servern svarar med en ögonblicksbild av läget. Spelet avslutas först om
värden varit borta i 60 sekunder.

Frågor kan sakna rätt svar (`correct: null`) – då är det en åsiktsomröstning utan poäng.
Poäng: 1000 för rätt svar. Topplista visas bara om spelet har minst en fråga med rätt svar.
Ingen timer. Ingen inloggning på `/admin`.

Admin visar svarsfördelningen som staplar eller cirkeldiagram (inline-SVG, valet sparas i
localStorage). Färgerna i `:root` är validerade för färgblindhet mot den mörka bakgrunden.

## REST-API

| Metod  | Sökväg               | Body / svar                                  |
|--------|----------------------|----------------------------------------------|
| GET    | `/api/questions`     | `[{ id, text, options, correct }]`           |
| POST   | `/api/questions`     | `{ text, options[2..4], correct: index|null }` → 201 |
| DELETE | `/api/questions/:id` | 204                                          |
| GET    | `/qr/:code`          | SVG med länk till `/?code=`                  |

## Socket.IO-kontrakt

Klient → server (ack används där svaret behövs direkt):

| Event           | Payload                  | Ack                          |
|-----------------|--------------------------|------------------------------|
| `host:create`   | –                        | `{ code, hostKey }` eller `{ error }` |
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
npm run dev        # node --watch, port 3000
```

Admin: http://localhost:3000/admin – spelare: http://localhost:3000/

## Deploy

Quick app på spinnrock, `samla.spinnrock.com`. Containern måste heta `samla`
och lyssna på port 3000 på nätverket `webnet`, Caddy sköter resten.

```
scp -r . spnrck.spinnrock.com:/home/spnrck/scratch/samla/   # exkl. node_modules
ssh spnrck.spinnrock.com 'cd /home/spnrck/scratch/samla && docker build -t samla . && docker rm -f samla; docker run -d --name samla --network webnet --restart unless-stopped samla'
curl -I https://samla.spinnrock.com/    # 200 = uppe, 302 → www = containern svarar inte
```

## Lärdomar från lektionen 2026-09-25

- `el.onkeydown = (e) => e.key === "Enter" && ...` blockerade all inmatning: ett `false` från en
  `on*`-egenskap avbryter händelsen. Skriv `if (...)` i stället. Playwright `fill()` går inte via
  keydown, så testa inmatning med `keyboard.type()`.
- Mobiler tappar socketen så fort skärmen släcks. Allt som identifierar en elev måste överleva
  ett nytt socket-id.

## Arbetssätt

- Svenska i kod-kommentarer, UI och dokumentation.
- Håll det litet: en fil per roll, ingen abstraktion som inte behövs för demot.
- Verifiera alltid med `/health` och två webbläsarflikar (admin + spelare) innan något kallas klart.
