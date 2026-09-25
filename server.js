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

io.on("connection", (socket) => {
  console.log("connect", socket.id);

  // TODO (live): host:create, player:join, host:start, player:answer, host:next

  socket.on("disconnect", (reason) => console.log("disconnect", socket.id, reason));
});

const PORT = process.env.PORT ?? 3000;
http.listen(PORT, () => console.log(`samla på :${PORT}`));
