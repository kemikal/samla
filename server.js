import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const questions = JSON.parse(readFileSync(new URL("./questions.json", import.meta.url)));

const app = express();
const http = createServer(app);
const io = new Server(http);

app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));
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
  const q = questions[game.current];
  const counts = [0, 0, 0, 0];
  for (const [id, option] of game.answers) {
    counts[option]++;
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

function sendQuestion(game) {
  const q = questions[game.current];
  game.answers = new Map();
  game.phase = "question";
  io.to(game.code).emit("game:question", {
    index: game.current,
    total: questions.length,
    text: q.text,
    options: q.options,
  });
}

io.on("connection", (socket) => {
  console.log("connect", socket.id);

  socket.on("host:create", (ack) => {
    const code = newCode();
    const game = { code, host: socket.id, players: new Map(), current: -1, answers: new Map() };
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
    game.players.set(socket.id, { name, score: 0 });
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
    if (!(option >= 0 && option < 4)) return;
    game.answers.set(socket.id, option);
    io.to(game.code).emit("game:answered", { answered: game.answers.size, total: game.players.size });
  });

  socket.on("host:next", () => {
    const game = hostGame(socket);
    if (!game) return;
    if (game.phase === "question") return sendResults(game);
    if (game.phase === "results") {
      if (game.current + 1 < questions.length) {
        game.current++;
        sendQuestion(game);
      } else {
        endGame(game);
      }
    }
  });

  socket.on("disconnect", (reason) => console.log("disconnect", socket.id, reason));
});

const PORT = process.env.PORT ?? 3000;
http.listen(PORT, () => console.log(`samla på :${PORT}`));
