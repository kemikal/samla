# Samla

Kahoot-klon med realtidsröstning. Byggd live med en klass (wu25) som demo av
AI-assisterad kodning. Eleverna läser SignalR parallellt, så jämför gärna
Socket.IO-begrepp med SignalR (rum = group, emit = SendAsync, hub = namespace).

## Stack

- Node 22, Express 4, Socket.IO 4. ESM (`"type": "module"`).
- Frontend: ren HTML/JS i `public/`, ingen byggsteg, inga ramverk.
- Allt spelstate i minnet (`Map` i `server.js`). Ingen databas.
- Frågor i `questions.json`.

## Struktur

```
server.js        Express + Socket.IO, all spellogik
questions.json   Frågebank: { text, options[4], correct }
public/index.html  Spelare: joina med kod + namn, svara på mobilen
public/host.html   Värd: visar rumskod, startar, ser svarsfördelning
public/style.css   Delad stil
```

## Spelflöde

1. Värd öppnar `/host.html` → `host:create` → får 4-siffrig rumskod.
2. Spelare öppnar `/` → `player:join` med kod + namn → hamnar i lobbyn.
3. Värd trycker Starta → `game:question` till alla i rummet.
4. Spelare svarar → `player:answer`. Värd ser antal svar live.
5. Värd trycker Nästa → `game:results` (fördelning, rätt svar, topplista), sedan nästa fråga.
6. Efter sista frågan → `game:over` med topplista.

Poäng: 1000 för rätt svar, 0 för fel. Ingen tidsbonus, ingen timer.

## Socket.IO-kontrakt

Klient → server (ack används där svaret behövs direkt):

| Event           | Payload                  | Ack                          |
|-----------------|--------------------------|------------------------------|
| `host:create`   | –                        | `{ code }`                   |
| `host:start`    | `{ code }`               | –                            |
| `host:next`     | `{ code }`               | –                            |
| `player:join`   | `{ code, name }`         | `{ ok }` eller `{ error }`   |
| `player:answer` | `{ code, option }`       | –                            |

Server → klient (till rummet `code`):

| Event           | Payload                                                    |
|-----------------|------------------------------------------------------------|
| `game:lobby`    | `{ code, players: [name] }`                                |
| `game:question` | `{ index, total, text, options }` (aldrig `correct`)       |
| `game:answered` | `{ answered, total }`                                      |
| `game:results`  | `{ counts: [n,n,n,n], correct, leaderboard: [{name,score}] }` |
| `game:over`     | `{ leaderboard }`                                          |

Regler: värden ligger i rummet men markeras som `host`, aldrig i `players`.
Skicka aldrig rätt svar till spelare innan `game:results`.

## Kör lokalt

```
npm install
npm run dev        # node --watch, port 3000
```

Värd: http://localhost:3000/host.html – spelare: http://localhost:3000/

## Deploy

Quick app på spinnrock, `samla.spinnrock.com`. Containern måste heta `samla`
och lyssna på port 3000 på nätverket `webnet`, Caddy sköter resten.

```
scp -r . spnrck.spinnrock.com:/home/spnrck/scratch/samla/   # exkl. node_modules
ssh spnrck.spinnrock.com 'cd /home/spnrck/scratch/samla && docker build -t samla . && docker rm -f samla; docker run -d --name samla --network webnet --restart unless-stopped samla'
curl -I https://samla.spinnrock.com/    # 200 = uppe, 302 → www = containern svarar inte
```

## Arbetssätt

- Svenska i kod-kommentarer, UI och dokumentation.
- Håll det litet: en fil per roll, ingen abstraktion som inte behövs för demot.
- Verifiera alltid med `/health` och två webbläsarflikar (host + spelare) innan något kallas klart.
