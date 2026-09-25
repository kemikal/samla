import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import nodemailer from "nodemailer";
import { randomUUID, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Persistens: konton (e-post -> egen frågebank) och sessioner sparas i en JSON-fil.
// Nya konton får seed-frågorna från questions.json. Spel lever fortfarande bara i minnet.
// ---------------------------------------------------------------------------
const seedQuestions = JSON.parse(readFileSync(new URL("./questions.json", import.meta.url)));
const DATA_DIR = process.env.DATA_DIR ?? fileURLToPath(new URL("./data", import.meta.url));
const DATA_FILE = join(DATA_DIR, "data.json");
mkdirSync(DATA_DIR, { recursive: true });
const db = existsSync(DATA_FILE)
  ? JSON.parse(readFileSync(DATA_FILE, "utf8"))
  : { accounts: {}, sessions: {} };

function save() {
  mkdirSync(DATA_DIR, { recursive: true }); // mappen kan ha försvunnit under körning
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DATA_FILE);
}

function getAccount(email) {
  if (!db.accounts[email]) {
    db.accounts[email] = {
      nextId: seedQuestions.length + 1,
      questions: seedQuestions.map((q, i) => ({ id: i + 1, correct: null, ...q })),
      created: new Date().toISOString(),
    };
    save();
    console.log("konto skapat", email);
  }
  return db.accounts[email];
}

// ---------------------------------------------------------------------------
// E-post via SMTP (Loopia, bot@spinnrock.com). Utan SMTP_HOST loggas länken i stället,
// så lokal utveckling fungerar utan konto.
// ---------------------------------------------------------------------------
const SMTP_HOST = process.env.SMTP_HOST ?? "";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 465);
const SMTP_USER = process.env.SMTP_USER ?? "";
const SMTP_PASS = process.env.SMTP_PASS ?? "";
const MAIL_FROM = process.env.MAIL_FROM ?? SMTP_USER;
const mailActive = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
const transport = mailActive
  ? nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } })
  : null;

async function sendMail({ to, subject, text, html }) {
  if (!mailActive) {
    console.log(`[mail inaktiv] Till: ${to} | ${subject}\n${text}`);
    return;
  }
  await transport.sendMail({ from: MAIL_FROM, to, subject, text, html });
  console.log(`[mail] skickat till ${to}: ${subject}`);
}

// ---------------------------------------------------------------------------
// Inloggning med magisk länk. Token är engångs och giltig i 30 min, sessionen 30 dagar.
// ---------------------------------------------------------------------------
const TOKEN_TTL_MS = 30 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_COOLDOWN_MS = 30 * 1000;
const COOKIE = "samla_session";
const magicTokens = new Map(); // token -> { email, expires }
const lastLogin = new Map(); // email -> tidpunkt för senaste utskick

const normalizeEmail = (s) => String(s ?? "").trim().toLowerCase();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((c) => c.trim().split("=")).filter(([k, v]) => k && v).map(([k, v]) => [k, decodeURIComponent(v)])
  );
}

function sessionEmail(cookieHeader) {
  const sid = parseCookies(cookieHeader)[COOKIE];
  const s = sid && db.sessions[sid];
  if (!s) return null;
  if (s.expires < Date.now()) {
    delete db.sessions[sid];
    save();
    return null;
  }
  return s.email;
}

function baseUrl(req) {
  const host = req.get("host");
  const proto = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https";
  return `${proto}://${host}`;
}

// Kräver inloggning för REST-anrop, lägger e-posten på req.email
function requireAuth(req, res, next) {
  const email = sessionEmail(req.headers.cookie);
  if (!email) return res.status(401).json({ error: "Inte inloggad" });
  req.email = email;
  next();
}

const app = express();
const http = createServer(app);
const io = new Server(http);

const publicDir = fileURLToPath(new URL("./public", import.meta.url));
app.set("trust proxy", 1);
app.use(express.json());

// Adminsidan kräver inloggning, annars till inloggningen
app.get("/admin", (req, res) => {
  if (!sessionEmail(req.headers.cookie)) return res.redirect("/login");
  res.sendFile("admin.html", { root: publicDir });
});
app.get("/login", (req, res) => {
  if (sessionEmail(req.headers.cookie)) return res.redirect("/admin");
  res.sendFile("login.html", { root: publicDir });
});
app.use(express.static(publicDir, { index: "index.html" }));

app.post("/api/login", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!validEmail(email)) return res.status(400).json({ error: "Ange en giltig e-postadress" });
  const last = lastLogin.get(email) ?? 0;
  if (Date.now() - last < LOGIN_COOLDOWN_MS) return res.status(429).json({ error: "Vänta en halv minut innan du begär en ny länk" });
  lastLogin.set(email, Date.now());
  const token = randomBytes(32).toString("base64url");
  magicTokens.set(token, { email, expires: Date.now() + TOKEN_TTL_MS });
  const link = `${baseUrl(req)}/auth/${token}`;
  const text = `Hej!\n\nHär är länken till din omröstning i Samla:\n${link}\n\nLänken fungerar i 30 minuter och kan bara användas en gång.\nHar du inte begärt den kan du ignorera det här mejlet.`;
  const html = `<p>Hej!</p><p>Här är länken till din omröstning i Samla:</p><p><a href="${link}">${link}</a></p><p>Länken fungerar i 30 minuter och kan bara användas en gång.<br>Har du inte begärt den kan du ignorera det här mejlet.</p>`;
  try {
    await sendMail({ to: email, subject: "Din länk till Samla", text, html });
  } catch (err) {
    console.error("[mail] misslyckades till", email, err.message);
    magicTokens.delete(token);
    lastLogin.delete(email);
    return res.status(502).json({ error: "Kunde inte skicka mejlet, försök igen om en stund" });
  }
  res.json({ ok: true });
});

app.get("/auth/:token", (req, res) => {
  const t = magicTokens.get(req.params.token);
  magicTokens.delete(req.params.token);
  if (!t || t.expires < Date.now()) return res.status(400).sendFile("expired.html", { root: publicDir });
  getAccount(t.email);
  const sid = randomBytes(32).toString("base64url");
  db.sessions[sid] = { email: t.email, expires: Date.now() + SESSION_TTL_MS };
  save();
  const secure = baseUrl(req).startsWith("https") ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
  console.log("inloggad", t.email);
  res.redirect("/admin");
});

app.post("/api/logout", (req, res) => {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (sid && db.sessions[sid]) {
    delete db.sessions[sid];
    save();
  }
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => res.json({ email: req.email }));

// QR-kod som SVG med länk till spelarsidan med koden ifylld
app.get("/qr/:code", async (req, res) => {
  const url = `${baseUrl(req)}/?code=${encodeURIComponent(req.params.code)}`;
  res.type("svg").send(await QRCode.toString(url, { type: "svg", margin: 1 }));
});

// REST-API för den inloggades frågebank
app.get("/api/questions", requireAuth, (req, res) => res.json(getAccount(req.email).questions));
app.post("/api/questions", requireAuth, (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "Frågetext saknas" });
  const account = getAccount(req.email);
  let q;
  if (req.body?.type === "text") {
    // Fritext: spelarna skriver 1–3 ord, inga alternativ och inget rätt svar
    q = { id: account.nextId++, type: "text", text, options: [], correct: null };
  } else {
    const options = (Array.isArray(req.body?.options) ? req.body.options : [])
      .map((o) => String(o ?? "").trim())
      .filter(Boolean);
    // correct är null för en åsiktsomröstning, annars index i options
    const raw = req.body?.correct;
    const correct = raw === null || raw === undefined || raw === "" ? null : Number(raw);
    if (options.length < 2 || options.length > 4) return res.status(400).json({ error: "Ange 2–4 alternativ" });
    if (correct !== null && !(correct >= 0 && correct < options.length)) return res.status(400).json({ error: "Ogiltigt rätt svar" });
    q = { id: account.nextId++, type: "choice", text, options, correct };
  }
  account.questions.push(q);
  save();
  res.status(201).json(q);
});
app.delete("/api/questions/:id", requireAuth, (req, res) => {
  const account = getAccount(req.email);
  const i = account.questions.findIndex((q) => q.id === Number(req.params.id));
  if (i < 0) return res.status(404).json({ error: "Finns inte" });
  account.questions.splice(i, 1);
  save();
  res.status(204).end();
});
app.get("/health", (_req, res) =>
  res.json({ ok: true, clients: io.engine.clientsCount, accounts: Object.keys(db.accounts).length, games: games.size, mail: mailActive })
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
    Object.assign(snap, distribution(game));
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
  if (!isText(q) && q.correct !== null) {
    for (const [id, option] of game.answers) {
      if (option === q.correct) game.players.get(id).score += 1000;
    }
  }
  game.phase = "results";
  io.to(game.code).emit("game:results", {
    ...distribution(game),
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
  return { index: game.current, total: game.questions.length, type: q.type ?? "choice", text: q.text, options: q.options };
}

const isText = (q) => q.type === "text";

// Fritextsvar: max 3 ord och 40 tecken, överflödiga mellanslag tas bort. null om ogiltigt.
function cleanText(raw) {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s || s.length > 40 || s.split(" ").length > 3) return null;
  return s;
}

// Fritextsvar grupperade skiftlägesokänsligt, vanligaste först. Första stavningen visas.
function textAnswers(game) {
  const groups = new Map();
  for (const text of game.answers.values()) {
    const key = text.toLowerCase();
    const g = groups.get(key) ?? { text, count: 0 };
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, "sv"));
}

// Det värden behöver för att rita fördelningen: counts för flerval, answers för fritext
function distribution(game) {
  const q = game.questions[game.current];
  return isText(q) ? { answers: textAnswers(game) } : { counts: answerCounts(game) };
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
  game.answers = new Map();
  game.phase = "question";
  io.to(game.code).emit("game:question", questionPayload(game));
}

io.on("connection", (socket) => {
  console.log("connect", socket.id);

  // Bara inloggade får skapa spel; spelet tar en ögonblicksbild av kontots frågebank
  socket.on("host:create", (ack) => {
    const email = sessionEmail(socket.handshake.headers.cookie);
    if (!email) return ack({ error: "Du måste vara inloggad för att starta en omröstning" });
    const account = getAccount(email);
    if (account.questions.length === 0) return ack({ error: "Inga frågor att ställa" });
    const code = newCode();
    const game = {
      code,
      owner: email,
      host: socket.id,
      hostKey: randomUUID(),
      questions: account.questions.map((q) => ({ ...q })),
      players: new Map(),
      current: -1,
      answers: new Map(),
    };
    games.set(code, game);
    socket.join(code);
    socket.data.code = code;
    socket.data.role = "host";
    console.log("spel skapat", code, "av", email);
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
        ...(game.phase === "question" ? distribution(game) : {}),
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

  // Flerval: { option: index }. Fritext: { text: "1–3 ord" }. Ack är valfritt, används för fel.
  socket.on("player:answer", ({ option, text } = {}, ack = () => {}) => {
    const game = games.get(socket.data.code);
    const playerId = socket.data.playerId;
    if (!game || game.phase !== "question" || !game.players.has(playerId)) return ack({ error: "Ingen fråga pågår" });
    if (game.answers.has(playerId)) return ack({ error: "Du har redan svarat" }); // ett svar per fråga
    const q = game.questions[game.current];
    let answer;
    if (isText(q)) {
      answer = cleanText(text);
      if (answer === null) return ack({ error: "Skriv 1–3 ord, max 40 tecken" });
    } else {
      answer = Number(option);
      if (!(answer >= 0 && answer < q.options.length)) return ack({ error: "Ogiltigt alternativ" });
    }
    game.answers.set(playerId, answer);
    ack({ ok: true, answer });
    // Fördelningen går bara till värden, spelarna ska inte påverkas av varandra
    const progress = { answered: game.answers.size, total: activePlayers(game) };
    io.to(game.code).except(game.host ?? "").emit("game:answered", progress);
    toHost(game, "game:answered", { ...progress, ...distribution(game) });
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
        ...(game.phase === "question" ? distribution(game) : {}),
      });
    }
  });
});

const PORT = process.env.PORT ?? 3000;
http.listen(PORT, () => console.log(`samla på :${PORT}`, mailActive ? `(mail via ${SMTP_USER})` : "(mail inaktiv, länkar loggas)"));
