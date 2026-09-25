import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

// Frågebank i minnet, seedad från questions.json. Varje fråga får ett id.
let nextId = 1;
const questions = JSON.parse(readFileSync(new URL("./questions.json", import.meta.url)))
  .map((q) => ({ id: nextId++, ...q }));

const app = express();
const http = createServer(app);
const io = new Server(http);

const publicDir = fileURLToPath(new URL("./public", import.meta.url));
app.use(express.json());
app.use(express.static(publicDir));
app.get("/admin", (_req, res) => res.sendFile("admin.html", { root: publicDir }));

// QR-kod som SVG med länk till spelarsidan med koden ifylld
app.get("/qr/:code", async (req, res) => {
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  const url = `${proto}://${req.get("host")}/?code=${encodeURIComponent(req.params.code)}`;
  res.type("svg").send(await QRCode.toString(url, { type: "svg", margin: 1 }));
});

// REST-API för frågebanken
app.get("/api/questions", (_req, res) => res.json(questions));
app.post("/api/questions", (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  const options = (Array.isArray(req.body?.options) ? req.body.options : [])
    .map((o) => String(o ?? "").trim())
    .filter(Boolean);
  const correct = Number(req.body?.correct);
  if (!text) return res.status(400).json({ error: "Frågetext saknas" });
  if (options.length < 2 || options.length > 4) return res.status(400).json({ error: "Ange 2–4 alternativ" });
  if (!(correct >= 0 && correct < options.length)) return res.status(400).json({ error: "Ogiltigt rätt svar" });
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

function newCode() {
  let code;
  do code = String(Math.floor(1000 + Math.random() * 9000));
  while (games.has(code));
  return code;
}

function lobby(game) {
  return { code: game.code, players: [...game.players.values()].map((p) => p.name) };
}

function hostGame(socket) {
  const game = games.get(socket.data.code);
  return game && game.host === socket.id ? game : null;
}

function leaderboard(game) {
  return [...game.players.values()]
    .map((p) => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function sendResults(game) {
  const q = game.questions[game.current];
  const counts = answerCounts(game);
  for (const [id, option] of game.answers) {
    if (option === q.correct) game.players.get(id).score += 1000;
  }
  game.phase = "results";
  io.to(game.code).emit("game:results", { counts, correct: q.correct, leaderboard: leaderboard(game) });
}

function endGame(game) {
  io.to(game.code).emit("game:over", { leaderboard: leaderboard(game) });
  games.delete(game.code);
  console.log("spel slut", game.code);
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
  io.to(game.code).emit("game:question", {
    index: game.current,
    total: game.questions.length,
    text: q.text,
    options: q.options,
  });
}

io.on("connection", (socket) => {
  console.log("connect", socket.id);

  socket.on("host:create", (ack) => {
    const code = newCode();
    const game = {
      code,
      host: socket.id,
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
    ack({ code });
    io.to(code).emit("game:lobby", lobby(game));
  });

  socket.on("player:join", ({ code, name } = {}, ack) => {
    const game = games.get(String(code ?? "").trim());
    name = String(name ?? "").trim().slice(0, 20);
    if (!game) return ack({ error: "Hittar inget spel med den koden" });
    if (game.current >= 0) return ack({ error: "Spelet har redan startat" });
    if (!name) return ack({ error: "Skriv ett namn" });
    const taken = [...game.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return ack({ error: "Namnet är upptaget" });
    game.players.set(socket.id, { name, score: 0, connected: true });
    socket.join(game.code);
    socket.data.code = game.code;
    socket.data.role = "player";
    console.log("spelare", name, "->", game.code);
    ack({ ok: true });
    io.to(game.code).emit("game:lobby", lobby(game));
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
    if (!game || game.phase !== "question" || !game.players.has(socket.id)) return;
    if (game.answers.has(socket.id)) return; // ett svar per fråga
    option = Number(option);
    if (!(option >= 0 && option < game.questions[game.current].options.length)) return;
    game.answers.set(socket.id, option);
    // Fördelningen går bara till värden, spelarna ska inte påverkas av varandra
    const progress = { answered: game.answers.size, total: activePlayers(game) };
    io.to(game.code).except(game.host).emit("game:answered", progress);
    io.to(game.host).emit("game:answered", { ...progress, counts: answerCounts(game) });
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
    if (socket.data.role === "host") return endGame(game);
    const player = game.players.get(socket.id);
    if (!player) return;
    if (game.current < 0) {
      game.players.delete(socket.id);
      io.to(game.code).emit("game:lobby", lobby(game));
    } else {
      player.connected = false;
      io.to(game.code).emit("game:answered", { answered: game.answers.size, total: activePlayers(game) });
    }
  });
});

const PORT = process.env.PORT ?? 3000;
http.listen(PORT, () => console.log(`samla på :${PORT}`));
