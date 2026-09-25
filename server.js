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

  socket.on("disconnect", (reason) => console.log("disconnect", socket.id, reason));
});

const PORT = process.env.PORT ?? 3000;
http.listen(PORT, () => console.log(`samla på :${PORT}`));
