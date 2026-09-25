import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";

// Frågebank i minnet, seedad från questions.json. Varje fråga får ett id.
let nextId = 1;
const questions = JSON.parse(readFileSync(new URL("./questions.json", import.meta.url)))
  .map((q) => ({ id: nextId++, correct: null, ...q }));

const app = express();
const http = createServer(app);
const io = new Server(http);

const publicDir = fileURLToPath(new URL("./public", import.meta.url));
app.use(express.json());
app.use(express.static(publicDir));
app.get("/admin", (_req, res) => res.sendFile("admin.html", { root: publicDir }));

// QR-kod som SVG med länk till spelarsidan med koden ifylld
app.get("/qr/:code", async (req, res) => {
  const host = req.get("host");
  const proto = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https";
  const url = `${proto}://${host}/?code=${encodeURIComponent(req.params.code)}`;
  res.type("svg").send(await QRCode.toString(url, { type: "svg", margin: 1 }));
});

// REST-API för frågebanken
app.get("/api/questions", (_req, res) => res.json(questions));
app.post("/api/questions", (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  const options = (Array.isArray(req.body?.options) ? req.body.options : [])
    .map((o) => String(o ?? "").trim())
    .filter(Boolean);
  // correct är null för en åsiktsomröstning, annars index i options
  const raw = req.body?.correct;
  const correct = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  if (!text) return res.status(400).json({ error: "Frågetext saknas" });
  if (options.length < 2 || options.length > 4) return res.status(400).json({ error: "Ange 2–4 alternativ" });
  if (correct !== null && !(correct >= 0 && correct < options.length)) return res.status(400).json({ error: "Ogiltigt rätt svar" });
  const q = { id: nextId++, text, options, correct };
  questions.push(q);
  res.status(201).json(q);
});
app.delete("/api/questions/:id", (req, res) => {
  const i = questions.findIndex((q) => q.id === Number(req.params.id));
  if (i < 0) return res.status(404).json({ error: "Finns inte" });
  questions.splice(i, 1);
  res.status(204).end();
});
app.get("/health", (_req, res) =>
  res.json({ ok: true, clients: io.engine.clientsCount, questions: questions.length })
);

// Alla spel lever i minnet: rumskod -> spel
const games = new Map();
// Så länge får värden vara borta innan spelet avslutas
const HOST_GRACE_MS = 60000;

function newCode() {
  let code;
  do code = String(Math.floor(1000 + Math.random() * 9000));
  while (games.has(code));
  return code;
}

function lobby(game) {
  return {
    code: game.code,
    players: [...game.players.values()].map(({ name, score, connected }) => ({ name, score, connected })),
  };
}

function toHost(game, event, payload) {
  if (game.host) io.to(game.host).emit(event, payload);
}

function snapshot(game) {
  const snap = { phase: game.phase ?? "lobby", lobby: lobby(game) };
  if (game.current >= 0) {
    snap.question = questionPayload(game);
    snap.counts = answerCounts(game);
    snap.answered = game.answers.size;
    snap.total = activePlayers(game);
  }
  if (game.phase === "results") {
    snap.correct = game.questions[game.current].correct;
    snap.scored = scored(game);
    snap.leaderboard = leaderboard(game);
  }
  return snap;
}

function hostGame(socket) {
  const game = games.get(socket.data.code);
  return game && game.host === socket.id ? game : null;
}

// Poäng och topplista är bara relevanta om någon fråga har ett rätt svar
function scored(game) {
  return game.questions.some((q) => q.correct !== null && q.correct !== undefined);
}

function leaderboard(game) {
  return [...game.players.values()]
    .map((p) => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function sendResults(game) {
  const q = game.questions[game.current];
  const counts = answerCounts(game);
  if (q.correct !== null) {
    for (const [id, option] of game.answers) {
      if (option === q.correct) game.players.get(id).score += 1000;
    }
  }
  game.phase = "results";
  io.to(game.code).emit("game:results", {
    counts,
    correct: q.correct,
    scored: scored(game),
    leaderboard: leaderboard(game),
  });
  toHost(game, "game:lobby", lobby(game));
}

function endGame(game) {
  clearTimeout(game.hostTimer);
  io.to(game.code).emit("game:over", { scored: scored(game), leaderboard: leaderboard(game) });
  games.delete(game.code);
  console.log("spel slut", game.code);
}

function questionPayload(game) {
  const q = game.questions[game.current];
  return { index: game.current, total: game.questions.length, text: q.text, options: q.options };
}

function uniqueName(game, name) {
  const taken = new Set([...game.players.values()].map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
}

function answerCounts(game) {
  const counts = game.questions[game.current].options.map(() => 0);
  for (const option of game.answers.values()) counts[option]++;
  return counts;
}

function activePlayers(game) {
  return [...game.players.values()].filter((p) => p.connected).length;
}

function sendQuestion(game) {
  const q = game.questions[game.current];
  game.answers = new Map();
  game.phase = "question";
  io.to(game.code).emit("game:question", questionPayload(game));
}

io.on("connection", (socket) => {
  console.log("connect", socket.id);

  socket.on("host:create", (ack) => {
    const code = newCode();
    const game = {
      code,
      host: socket.id,
      hostKey: randomUUID(),
      questions: questions.map((q) => ({ ...q })),
      players: new Map(),
      current: -1,
      answers: new Map(),
    };
    if (game.questions.length === 0) return ack({ error: "Inga frågor att ställa" });
    games.set(code, game);
    socket.join(code);
    socket.data.code = code;
    socket.data.role = "host";
    console.log("spel skapat", code);
    ack({ code, hostKey: game.hostKey });
    io.to(code).emit("game:lobby", lobby(game));
  });

  // Värden återansluter efter tappad förbindelse eller sidladdning
  socket.on("host:resume", ({ code, hostKey } = {}, ack) => {
    const game = games.get(String(code ?? ""));
    if (!game || game.hostKey !== hostKey) return ack({ error: "Spelet finns inte längre" });
    clearTimeout(game.hostTimer);
    game.host = socket.id;
    socket.join(game.code);
    socket.data.code = game.code;
    socket.data.role = "host";
    console.log("värd återansluten", game.code);
    ack({ ok: true, code: game.code, state: snapshot(game) });
  });

  // Join används både första gången och vid återanslutning (samma playerId).
  // Sen anslutning är tillåten: spelaren får aktuell fråga direkt.
  socket.on("player:join", ({ code, name, playerId } = {}, ack) => {
    const game = games.get(String(code ?? "").trim());
    if (!game) return ack({ error: "Hittar inget spel med den koden" });
    let player = playerId && game.players.get(playerId);
    if (player) {
      player.connected = true;
      player.socketId = socket.id;
      console.log("återansluten", player.name, "->", game.code);
    } else {
      name = String(name ?? "").trim().slice(0, 20);
      if (!name) return ack({ error: "Skriv ett namn" });
      playerId = randomUUID();
      player = { name: uniqueName(game, name), score: 0, connected: true, socketId: socket.id };
      game.players.set(playerId, player);
      console.log("spelare", player.name, "->", game.code);
    }
    socket.join(game.code);
    socket.data.code = game.code;
    socket.data.role = "player";
    socket.data.playerId = playerId;
    const state = { phase: game.phase ?? "lobby" };
    if (game.phase === "question") {
      state.question = questionPayload(game);
      state.answer = game.answers.get(playerId) ?? null;
    }
    ack({ ok: true, name: player.name, playerId, state });
    io.to(game.code).emit("game:lobby", lobby(game));
    if (game.current >= 0) {
      toHost(game, "game:answered", {
        answered: game.answers.size,
        total: activePlayers(game),
        counts: game.phase === "question" ? answerCounts(game) : undefined,
      });
    }
  });

  socket.on("host:start", () => {
    const game = hostGame(socket);
    if (!game || game.current >= 0) return;
    game.current = 0;
    console.log("spel startat", game.code);
    sendQuestion(game);
  });

  socket.on("player:answer", ({ option } = {}) => {
    const game = games.get(socket.data.code);
    const playerId = socket.data.playerId;
    if (!game || game.phase !== "question" || !game.players.has(playerId)) return;
    if (game.answers.has(playerId)) return; // ett svar per fråga
    option = Number(option);
    if (!(option >= 0 && option < game.questions[game.current].options.length)) return;
    game.answers.set(playerId, option);
    // Fördelningen går bara till värden, spelarna ska inte påverkas av varandra
    const progress = { answered: game.answers.size, total: activePlayers(game) };
    io.to(game.code).except(game.host ?? "").emit("game:answered", progress);
    toHost(game, "game:answered", { ...progress, counts: answerCounts(game) });
  });

  socket.on("host:next", () => {
    const game = hostGame(socket);
    if (!game) return;
    if (game.phase === "question") return sendResults(game);
    if (game.phase === "results") {
      if (game.current + 1 < game.questions.length) {
        game.current++;
        sendQuestion(game);
      } else {
        endGame(game);
      }
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("disconnect", socket.id, reason);
    const game = games.get(socket.data.code);
    if (!game) return;
    if (socket.data.role === "host") {
      if (game.host !== socket.id) return; // redan återansluten
      game.host = null;
      game.hostTimer = setTimeout(() => endGame(game), HOST_GRACE_MS);
      return;
    }
    const player = game.players.get(socket.data.playerId);
    if (!player || player.socketId !== socket.id) return; // redan återansluten med ny socket
    player.connected = false;
    io.to(game.code).emit("game:lobby", lobby(game));
    if (game.current >= 0) {
      toHost(game, "game:answered", {
        answered: game.answers.size,
        total: activePlayers(game),
        counts: game.phase === "question" ? answerCounts(game) : undefined,
      });
    }
  });
});

const PORT = process.env.PORT ?? 3000;
http.listen(PORT, () => console.log(`samla på :${PORT}`));
