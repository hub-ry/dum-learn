// learn-ai: the study + exploration-chat backend, served under /api/*.
// Runs on loopback; a reverse proxy (cloudflared, nginx, caddy) sends
// <your site>/api/* here and everything else to the static server.
// For local testing it also serves the published site for non-/api paths.
//
// Public: GET /api/status, POST /api/login. Everything else needs the
// session cookie you get by entering the passcode (LEARN_PASSCODE_FILE, default ~/.config/learn/passcode).
import { createServer } from "node:http";
import { createReadStream, readFileSync, existsSync } from "node:fs";
import { readFile, writeFile, rename, mkdir, readdir, rm, copyFile, stat, realpath } from "node:fs/promises";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createLLM, BudgetError } from "./llm.mjs";
import { checkTex, compileTex, texToText, createPublisher, writeLessonFile } from "./tex.mjs";
import * as P from "./prompts.mjs";
import { createFiles, FsError } from "./files.mjs";

const HOME = os.homedir();
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SITE = path.resolve(HERE, "..");
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8075);
const CONTENT = path.resolve(process.env.LEARN_CONTENT ?? path.join(HOME, "learn"));
const DATA = path.resolve(process.env.LEARN_DATA ?? path.join(HOME, ".local/share/learn"));
const STATIC = path.resolve(process.env.LEARN_ROOT ?? "/var/lib/learn");
const PASSFILE = path.resolve(process.env.LEARN_PASSCODE_FILE ?? path.join(HOME, ".config/learn/passcode"));
const TAB = "ai";
const TZ = "America/Indianapolis";
const SESSION_DAYS = 30;
const INTERVALS = [1, 3, 7, 14]; // days between cold re-checks

const today = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isoWeek = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const wk = 1 + Math.round(((d - first) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
};
const id = (n = 6) => randomBytes(n).toString("base64url");
const now = () => new Date().toISOString();
const slug = (s, n = 40) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n).replace(/-+$/, "") || "lesson";
const clip = (s, n) => String(s ?? "").slice(0, n);

await mkdir(path.join(DATA, "backups"), { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------- state ---

const STATE_FILE = path.join(DATA, "state.json");
const SESS_FILE = path.join(DATA, "sessions.json");
const EMPTY = { version: 1, activeGoalId: null, goals: [], lessons: {}, cards: [], drills: [], reflections: [], meta: null, activity: {}, attempts: [] };
let S = structuredClone(EMPTY);
try { S = { ...S, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }; } catch {}
let sessions = {};
try { sessions = JSON.parse(readFileSync(SESS_FILE, "utf8")); } catch {}

// Exploration chats (/explore). A corrupt chats.json stops startup instead of
// being overwritten with an empty store.
const CHATS_FILE = path.join(DATA, "chats.json");
const CHAT_HISTORY_TOKENS = 6000;
const CHAT_CONTEXT_CHARS = 14000;
const CHAT_MESSAGE_CHARS = 8000;
const CHAT_TITLE_CHARS = 200;
const CHAT_REPLY_TOKENS = 1600;
const C = (() => {
  try { return JSON.parse(readFileSync(CHATS_FILE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return { version: 1, chats: [] }; throw e; }
})();
if (!C || !Array.isArray(C.chats)) throw new Error("chats.json must contain a chats array");
let savingChats = Promise.resolve();
function saveChats() {
  const json = JSON.stringify(C);
  savingChats = savingChats.catch(() => {}).then(async () => {
    const tmp = `${CHATS_FILE}.tmp`;
    await writeFile(tmp, json, { mode: 0o600 });
    await rename(tmp, CHATS_FILE);
  });
  return savingChats;
}

// Lessons that were generating when the service stopped can be retried.
for (const l of Object.values(S.lessons)) if (l.status === "generating") { l.status = "failed"; l.error = "interrupted by a restart"; }

let saving = Promise.resolve();
function save() {
  saving = saving.then(async () => {
    const tmp = `${STATE_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(S, null, 1), { mode: 0o600 });
    await rename(tmp, STATE_FILE);
    await dailyBackup();
  }).catch((e) => console.error("save failed:", e.message));
  return saving;
}
async function saveSessions() {
  const tmp = `${SESS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(sessions), { mode: 0o600 });
  await rename(tmp, SESS_FILE);
}
// Once a day: copy state and tar the lesson sources. Keep 30 days.
let lastBackup = "";
async function dailyBackup() {
  const d = today();
  if (lastBackup === d) return;
  lastBackup = d;
  const dir = path.join(DATA, "backups");
  await copyFile(STATE_FILE, path.join(dir, `state-${d}.json`));
  if (existsSync(CHATS_FILE)) await copyFile(CHATS_FILE, path.join(dir, `chats-${d}.json`));
  if (existsSync(path.join(CONTENT, TAB))) {
    await new Promise((r) => execFile("tar", ["czf", path.join(dir, `lessons-${d}.tgz`), "-C", CONTENT, TAB], () => r()));
  }
  const files = (await readdir(dir)).sort();
  for (const prefix of ["state-", "lessons-", "chats-"]) {
    const mine = files.filter((f) => f.startsWith(prefix));
    for (const f of mine.slice(0, Math.max(0, mine.length - 30))) await rm(path.join(dir, f), { force: true });
  }
}

// ---- explainers + time (the simplified learn page)
// The old study data (goals, cards, drills, reflections, attempts, activity,
// meta) stays in state.json untouched; nothing reads or changes it any more.
S.time ??= {};
const TOPIC_CHARS = 32;
function topicValue(v) {
  if (typeof v !== "string") throw new HttpError(400, "topic must be text");
  const t = v.toLowerCase().replace(/[^a-z0-9+#./ -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, TOPIC_CHARS).trim();
  if (!t) throw new HttpError(400, "give it a topic");
  return t;
}
const lessonTopic = (l) => l.topic || (l.topics?.[0] ? String(l.topics[0]).replace(/-/g, " ") : "") || TAB;
// Where an explainer lives, as "tab/folder/file.tex" under ~/learn. Older
// lessons only have `file` (relative to the ai tab).
const lessonRel = (l) => l.path ?? (l.file ? `${TAB}/${l.file}` : null);
function setLessonRel(l, rel) {
  const [tab, ...rest] = rel.split("/");
  Object.assign(l, { path: rel, tab, file: rest.join("/") });
}
// Prerequisite branches: a lesson's parentId is the explainer it was branched
// off from. chainOf gives root > ... > l.
function chainOf(l) {
  const out = [];
  for (let c = l, i = 0; c && i < 10; i++, c = c.parentId ? S.lessons[c.parentId] : null) out.unshift(c);
  return out;
}
const lessonByRel = (rel) => Object.values(S.lessons).find((l) => lessonRel(l) === rel);
const lessonByFile = (rel) => lessonByRel(`${TAB}/${rel}`);
const lessonPublic = (l) => {
  if (!l) return l;
  const rel = lessonRel(l);
  const [tab, ...rest] = rel ? rel.split("/") : [null];
  return {
    id: l.id, title: l.title, prompt: l.prompt, topic: lessonTopic(l), summary: l.summary ?? "",
    status: l.status, progress: l.progress ?? null, error: l.error ?? null, format: l.format ?? null,
    tab, file: rel ? rest.join("/") : null, path: rel, folder: l.folder ?? null,
    missing: !!rel && l.status === "ready" && !existsSync(path.join(CONTENT, rel)),
    kind: l.kind ?? "explainer", experimental: l.kind === "history",
    parentId: l.parentId ?? null,
    children: Object.values(S.lessons).filter((c) => c.parentId === l.id && c.kind !== "history").map((c) => c.id),
    histories: Object.values(S.lessons).filter((c) => c.parentId === l.id && c.kind === "history").map((c) => c.id),
    trail: chainOf(l).map((x) => ({ id: x.id, title: x.title, status: x.status })),
    created: l.created, started: l.started ?? null,
    link: rel ? `#/${rel}` : null,
  };
};

// Stable ids for files, so time spent and file chats stay attached when a
// file or its folder is moved: S.fids[fid] = "tab/path". Time is stored as
// "fid:<id>", chats carry fileId. Moves rewrite the path, never the id.
S.fids ??= {};
S.actions ??= [];
let fidIndex = null;
const fidByPath = () => (fidIndex ??= new Map(Object.entries(S.fids).map(([k, v]) => [v, k])));
function fidFor(rel) {
  let f = fidByPath().get(rel);
  if (!f) { f = id(5); S.fids[f] = rel; fidIndex.set(rel, f); }
  return f;
}
const under = (p, from) => p === from || p.startsWith(`${from}/`);
// A file or folder moved from -> to: re-point every reference to it.
function remap(from, to) {
  const swap = (p) => (p && under(p, from) ? to + p.slice(from.length) : p);
  for (const [f, p] of Object.entries(S.fids)) S.fids[f] = swap(p);
  fidIndex = null;
  for (const l of Object.values(S.lessons)) {
    const r = lessonRel(l);
    if (r && under(r, from)) setLessonRel(l, swap(r));
    if (l.folder && under(l.folder, from)) l.folder = swap(l.folder);
  }
  for (const c of C.chats) if (c.fileKey && under(c.fileKey, from)) c.fileKey = swap(c.fileKey);
}
// One-time migration of path-keyed data to ids.
{
  let changed = false;
  for (const day of Object.values(S.time)) {
    for (const k of Object.keys(day)) {
      if (!k.startsWith("file:")) continue;
      const nk = `fid:${fidFor(k.slice(5))}`;
      day[nk] = (day[nk] ?? 0) + day[k];
      delete day[k];
      changed = true;
    }
  }
  for (const c of C.chats) {
    if (c.fileId) continue;
    const rel = c.fileKey ?? (c.lessonId && S.lessons[c.lessonId] ? lessonRel(S.lessons[c.lessonId]) : null);
    if (rel) { c.fileId = fidFor(rel); c.fileKey = rel; changed = true; }
  }
  if (changed) { console.log("migrated time + chats to stable file ids"); queueMicrotask(() => { save(); saveChats(); }); }
}
function overview() {
  const explainers = Object.values(S.lessons).filter((l) => !String(lessonRel(l) ?? "").startsWith(".trash/")).sort((a, b) => b.created.localeCompare(a.created)).map(lessonPublic);
  return { explainers, topics: [...new Set(explainers.map((l) => l.topic))].sort() };
}

// Time spent: S.time[day][key] = seconds, key "file:<tab>/<path>" or
// "chat:<id>". Topics are resolved when reading, so editing a tag re-files
// the time already spent on that explainer.
const TIME_KEY = /^(file:[\w.+-]+(\/[\w.+-]+){0,7}|chat:[\w-]{1,40})$/;
const validTimeKey = (k) => typeof k === "string" && k.length <= 300 && TIME_KEY.test(k) && !k.split("/").some((x) => x === ".." || x === "." || x.endsWith(":.."));
function topicForPath(rel) {
  const l = lessonByRel(rel);
  if (l) return lessonTopic(l);
  const [tab, ...rest] = rel.replace(/^\.trash\/[^/]+\//, "").split("/");
  return rest.length > 1 ? `${tab}/${rest[0]}` : tab;
}
function topicForKey(key) {
  if (key.startsWith("chat:")) {
    const c = chatById(key.slice(5));
    const rel = c?.fileId ? S.fids[c.fileId] : c?.fileKey;
    return rel ? topicForPath(rel) : "chat";
  }
  if (key.startsWith("fid:")) return S.fids[key.slice(4)] ? topicForPath(S.fids[key.slice(4)]) : "other";
  return topicForPath(key.slice(5));
}

// ------------------------------------------------------------------ auth ---

function passcode() {
  try { return readFileSync(PASSFILE, "utf8").trim(); } catch { return null; }
}
const sha = (s) => createHash("sha256").update(s).digest();
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function session(req) {
  const tok = cookies(req).learn_s;
  if (!tok) return null;
  const key = sha(tok).toString("hex");
  const s = sessions[key];
  if (!s || s.exp < Date.now()) return null;
  return { key, ...s };
}
const clientIp = (req) => req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?";

// Simple sliding-window limiter: name -> key -> timestamps.
const windows = new Map();
function limited(name, key, max, ms) {
  const m = windows.get(name) ?? new Map();
  windows.set(name, m);
  const t = Date.now();
  const xs = (m.get(key) ?? []).filter((x) => t - x < ms);
  m.set(key, xs);
  if (xs.length >= max) return true;
  xs.push(t);
  return false;
}
const hits = (name, key, ms) => ((windows.get(name)?.get(key)) ?? []).filter((x) => Date.now() - x < ms).length;

// ------------------------------------------------------------------- http ---

const JSONH = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function send(res, status, obj, extra = {}) {
  res.writeHead(status, { ...JSONH, ...extra });
  res.end(JSON.stringify(obj));
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function body(req, { optional = false } = {}) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, "request too large");
    chunks.push(c);
  }
  if (optional && !size) return {};
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send JSON");
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new HttpError(400, "bad JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "send a JSON object");
  return value;
}

const ALLOWED_ORIGINS = new Set([...(process.env.LEARN_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean), `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

// AI spend gate: per-session and global windows on top of the daily budget.
function aiGate(sess) {
  if (limited("ai-session", sess.key, 30, 10 * 60_000)) throw new HttpError(429, "slow down: max 30 AI requests per 10 minutes");
  if (limited("ai-global", "all", 60, 10 * 60_000)) throw new HttpError(429, "AI is busy; try again in a few minutes");
}

const routes = [];
const route = (method, pattern, handler, { auth = true, ai = false, raw = false } = {}) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler, auth, ai, raw });

// ---- public
route("GET", "/api/status", async (req) => ({ ok: true, authed: !!session(req), ai: !!process.env.DEEPSEEK_API_KEY && !!passcode() }), { auth: false });

route("POST", "/api/login", async (req, res) => {
  const ip = clientIp(req);
  if (hits("login-fail", ip, 15 * 60_000) >= 5 || hits("login-fail", "all", 60 * 60_000) >= 30) {
    throw new HttpError(429, "too many wrong passcodes; wait 15 minutes");
  }
  const { passcode: given } = await body(req);
  const real = passcode();
  if (!real) throw new HttpError(503, "passcode not configured");
  const ok = typeof given === "string" && timingSafeEqual(sha(given.trim()), sha(real));
  if (!ok) {
    limited("login-fail", ip, 1e9, 15 * 60_000);
    limited("login-fail", "all", 1e9, 60 * 60_000);
    await new Promise((r) => setTimeout(r, 600));
    throw new HttpError(401, "wrong passcode");
  }
  const tok = randomBytes(32).toString("base64url");
  for (const [k, s] of Object.entries(sessions)) if (s.exp < Date.now()) delete sessions[k];
  sessions[sha(tok).toString("hex")] = { created: Date.now(), exp: Date.now() + SESSION_DAYS * 86400_000, ip };
  await saveSessions();
  const secure = req.headers["x-forwarded-proto"] === "https" || req.headers["cf-connecting-ip"] ? "; Secure" : "";
  res.setHeader("Set-Cookie", `learn_s=${tok}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  return { ok: true };
}, { auth: false });

route("POST", "/api/logout", async (req, res, sess) => {
  delete sessions[sess.key];
  await saveSessions();
  res.setHeader("Set-Cookie", "learn_s=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0");
  return { ok: true };
});

// ---- overview: the explainer list (no streaks, goals or counters)
route("GET", "/api/state", async () => overview());

// ---- explainers: one prompt -> a short LaTeX PDF in ~/learn/ai/explainers/
route("POST", "/api/lessons", async (req) => {
  const b = await body(req);
  return { lesson: lessonPublic(await startExplainer(b.prompt, { folder: b.folder })) };
}, { ai: true });

// Starts writing an explainer in the background. folder: "tab/folder" (made
// if needed); parentId/assumes: set when this is a prerequisite branch or a
// parent written after its prerequisites.
const busyWriting = () => Object.values(S.lessons).some((l) => l.status === "generating");
async function startExplainer(promptIn, { folder, parentId, context, kind = "explainer", stuck, sourceRel, topic, concept } = {}) {
  const prompt = clip(promptIn, 1500).trim();
  if (!prompt) throw new HttpError(400, "what are you stuck on?");
  if (busyWriting()) throw new HttpError(429, "an explainer is already being written; wait for it to finish");
  let dir = `${TAB}/explainers`;
  if (folder != null && folder !== "") {
    dir = files.norm(String(folder));
    const info = await files.inspect(dir);
    if (info.exists && !info.dir) throw new HttpError(400, `${dir} is a file, not a folder`);
  }
  const l = {
    id: id(), kind, title: prompt.replace(/\s+/g, " ").slice(0, 80), prompt, goalId: null, topics: [], topic: topic ?? null,
    status: "generating", progress: "writing", created: now(), started: now(), folder: dir,
    ...(parentId ? { parentId } : {}), ...(context ? { context: clip(context, 300) } : {}),
    ...(kind === "history" ? { stuck: clip(stuck ?? "", 400), sourceRel: sourceRel ?? null, fixedTopic: topic ?? null, concept: clip(concept ?? "", 200) || null } : {}),
  };
  S.lessons[l.id] = l;
  await save();
  generateExplainer(l).catch((e) => console.error("explainer failed:", e.message));
  return l;
}

route("GET", "/api/lessons/([\\w-]+)", async (req, res, sess, [lid]) => {
  const l = S.lessons[lid];
  if (!l) throw new HttpError(404, "no such explainer");
  return { lesson: lessonPublic(l) };
});

route("POST", "/api/lessons/([\\w-]+)/retry", async (req, res, sess, [lid]) => {
  const l = S.lessons[lid];
  if (!l || l.status !== "failed") throw new HttpError(400, "only failed explainers can be retried");
  if (Object.values(S.lessons).some((x) => x.status === "generating")) throw new HttpError(429, "an explainer is already being written");
  Object.assign(l, { status: "generating", progress: "writing", error: null, started: now() });
  await save();
  generateExplainer(l).catch((e) => console.error("explainer failed:", e.message));
  return { lesson: lessonPublic(l) };
}, { ai: true });

route("POST", "/api/lessons/([\\w-]+)/topic", async (req, res, sess, [lid]) => {
  const l = S.lessons[lid];
  if (!l) throw new HttpError(404, "no such explainer");
  const b = await body(req);
  l.topic = topicValue(b.topic);
  await save();
  return { lesson: lessonPublic(l), ...overview() };
});

route("POST", "/api/lessons/([\\w-]+)/delete", async (req, res, sess, [lid]) => {
  const l = S.lessons[lid];
  if (!l) throw new HttpError(404, "no such explainer");
  if (l.status === "generating") throw new HttpError(409, "wait for it to finish");
  delete S.lessons[lid];
  if (lessonRel(l)) {
    // Keep the source in the backups dir instead of deleting it outright.
    const src = path.join(CONTENT, lessonRel(l));
    if (existsSync(src)) await rename(src, path.join(DATA, "backups", `deleted-${Date.now()}-${path.basename(src)}`));
    publish().catch(() => {});
  }
  await save();
  return overview();
});

// ---- time spent learning
route("POST", "/api/time", async (req, res, sess) => {
  if (limited("time", sess.key, 20, 60_000)) throw new HttpError(429, "too many time updates");
  const b = await body(req);
  const entries = Array.isArray(b.entries) ? b.entries.slice(0, 20) : [];
  const day = (S.time[today()] ??= {});
  let n = 0;
  for (const e of entries) {
    const secs = Math.round(Number(e?.secs));
    if (!validTimeKey(e?.key) || !(secs > 0)) continue;
    if (e.key.startsWith("file:")) {
      const rel = e.key.slice(5);
      if (!existsSync(path.join(CONTENT, rel)) && !fidByPath().has(rel)) continue;
      e.key = `fid:${fidFor(rel)}`;
    }
    if (day[e.key] === undefined && Object.keys(day).length >= 300) continue;
    day[e.key] = Math.min(86_400, (day[e.key] ?? 0) + Math.min(secs, 600));
    n++;
  }
  if (n) await save();
  return { ok: true, recorded: n };
});
route("GET", "/api/time", async () => {
  const rows = [];
  for (const [day, keys] of Object.entries(S.time)) {
    const by = {};
    for (const [k, secs] of Object.entries(keys)) { const t = topicForKey(k); by[t] = (by[t] ?? 0) + secs; }
    for (const [topic, secs] of Object.entries(by)) rows.push({ day, topic, secs });
  }
  return { today: today(), rows };
});

const publish = createPublisher(SITE);

function parseLesson(text) {
  const meta = text.match(/<meta>([\s\S]*?)<\/meta>/);
  const tex = text.match(/<tex>([\s\S]*?)(<\/tex>|$)/);
  if (!meta || !tex) throw new Error("lesson response missing <meta> or <tex>");
  let m;
  try { m = JSON.parse(meta[1].trim()); } catch { throw new Error("lesson meta is not valid JSON"); }
  return { meta: m, tex: tex[1].trim().replace(/^```(latex|tex)?\s*/i, "").replace(/```$/, "").trim() + "\n" };
}

// The {{context}} for the teaching prompt: where this sits in a branch, what
// he just read, what he was looking at.
function explainerContext(l) {
  const parts = [];
  const parent = l.parentId ? S.lessons[l.parentId] : null;
  if (parent) parts.push(`This is a prerequisite branch: he paused "${parent.title}" to learn this first (trail: ${chainOf(l).map((x) => x.title).join(" > ")}). Scope it to what "${parent.title}" needs. In Go further, point back up to "${parent.title}" as the next thing to read.`);
  const kids = Object.values(S.lessons).filter((c) => c.parentId === l.id && c.status === "ready" && c.kind !== "history");
  if (kids.length) parts.push(`He just read explainers on ${kids.map((c) => `"${c.title}"`).join(", ")} as prerequisites for this one. Assume them: refer back to them by name instead of re-teaching them.`);
  if (l.context) parts.push(l.context);
  const recent = Object.values(S.lessons).filter((x) => x.status === "ready" && x.id !== l.id).slice(-8).map((x) => x.title);
  if (recent.length) parts.push(`Recent explainers he has read: ${recent.join("; ")}.`);
  return parts.join(" ");
}

async function generateExplainer(l) {
  const set = async (patch) => { Object.assign(l, patch); await save(); };
  try {
    let chars = 0;
    const history = l.kind === "history";
    const msgs = history
      ? [
        { role: "system", content: P.historySystem({ topic: l.concept ?? l.prompt, stuck: l.stuck, source: await sourceText(l.sourceRel) }) },
        { role: "user", content: P.historyUser({ topic: l.concept ?? l.prompt, stuck: l.stuck }) },
      ]
      : [
        { role: "system", content: P.explainerSystem({ topic: l.prompt, context: explainerContext(l) }) },
        { role: "user", content: P.explainerUser({ prompt: l.prompt, topics: overview().topics.filter((t) => t !== TAB) }) },
      ];
    const { text: raw } = await llm.stream(msgs, {
      maxTokens: history ? 3000 : 4500, temperature: history ? 0.2 : 0.4,
      // Live progress (kept in memory; GET /api/lessons/:id reads it).
      onDelta: (t) => { chars += t.length; l.progress = `writing (${(chars / 1000).toFixed(1)}k chars)`; },
    });
    let { meta, tex } = parseLesson(raw);
    let topic = TAB;
    try { topic = topicValue(String(meta.topic ?? "")); } catch {}
    if (l.fixedTopic) topic = l.fixedTopic; // a history lesson files under its explainer's topic
    let title = clip(meta.title, 200) || l.title;
    if (history && !/^history\b/i.test(title)) title = `History: ${title}`;
    await set({ title, summary: clip(meta.summary, 400), topic, progress: "compiling the PDF" });

    let ok = false, attempts = 0, lastErr = "";
    while (attempts < 3) {
      attempts++;
      const problems = checkTex(tex);
      const r = problems.length ? { ok: false, log: `Rejected before compiling: ${problems.join("; ")}` } : await compileTex(tex, CONTENT);
      if (r.ok) {
        ok = true;
        // Over the page limit: one tightening pass (kept only if it compiles and is shorter).
        const maxPages = history ? 2 : 3;
        if (r.pages && r.pages > maxPages && !l._tightened) {
          l._tightened = true;
          await set({ progress: `tightening to ${maxPages} pages` });
          const out = await llm.chat([
            { role: "system", content: P.tightenSystem({ maxPages, pages: r.pages, history }) },
            { role: "user", content: tex },
          ], { maxTokens: 4000, temperature: 0.1 }).catch(() => "");
          const m = out.match(/<tex>([\s\S]*?)(<\/tex>|$)/);
          const t2 = (m ? m[1] : out).trim().replace(/^```(latex|tex)?\s*/i, "").replace(/```$/, "").trim() + "\n";
          if (t2.includes("\\begin{document}") && !checkTex(t2).length) {
            const r2 = await compileTex(t2, CONTENT);
            if (r2.ok && (r2.pages ?? 99) < r.pages) tex = t2;
          }
        }
        break;
      }
      lastErr = r.log;
      if (attempts >= 3) break;
      await set({ progress: `fixing a LaTeX error (try ${attempts + 1}/3)` });
      const fixed = await llm.chat([
        { role: "system", content: P.FIX_SYSTEM },
        { role: "user", content: `Errors:\n${r.log}\n\nDocument:\n${tex}` },
      ], { maxTokens: 4500, temperature: 0.1 });
      const m = fixed.match(/<tex>([\s\S]*?)(<\/tex>|$)/);
      tex = (m ? m[1] : fixed).trim().replace(/^```(latex|tex)?\s*/i, "").replace(/```$/, "").trim() + "\n";
    }

    const folder = l.folder ?? `${TAB}/explainers`;
    await files.ensureDir(folder);
    const base = `${today()}-${slug(l.title)}`;
    let rel = `${folder}/${base}.${ok ? "tex" : "txt"}`;
    for (let i = 2; existsSync(path.join(CONTENT, rel)); i++) rel = `${folder}/${base}-${i}.${ok ? "tex" : "txt"}`;
    const target = (await files.inspect(rel)).full;
    if (ok) {
      await writeLessonFile(target, tex);
    } else {
      console.error(`LaTeX failed 3 times for ${l.id}, saving plain text: ${lastErr.slice(0, 300)}`);
      await writeLessonFile(target, texToText(tex));
    }
    setLessonRel(l, rel);
    await set({ format: ok ? "pdf" : "text", progress: "publishing" });
    try {
      await publish();
    } catch (e) {
      // A broken publish must not leave a bad file in the content root.
      if (ok) await rename(path.join(CONTENT, rel), path.join(DATA, "backups", `unpublished-${Date.now()}-${path.basename(rel)}`)).catch(() => {});
      throw e;
    }
    await set({ status: "ready", progress: null, error: ok ? null : "LaTeX would not compile, so this one is plain text" });
  } catch (e) {
    await set({ status: "failed", progress: null, error: e instanceof BudgetError ? e.message : clip(e.message, 400) });
  }
}

// --------------------------------------------------------------- command ---
// The command box: plain English -> whitelisted file actions (see
// files.mjs), explainers, opening files and file chats. The AI only proposes;
// every path is re-validated here. Moves/mkdir/retag apply at once and can be
// undone; deletes wait for a confirm; nothing is ever overwritten.
const files = createFiles({ root: CONTENT, trash: path.join(DATA, "trash") });
const MUTATING = new Set(["mkdir", "move", "delete", "retag"]);
const pendingConfirms = new Map(); // token -> { sessKey, actions, expires }
const cmdHistory = new Map(); // sessKey -> recent [{role, content}]
let opsLock = Promise.resolve();
const locked = (fn) => { const run = opsLock.then(fn, fn); opsLock = run.catch(() => {}); return run; };

async function applyStep(a) {
  switch (a?.op) {
    case "mkdir": return files.makeDir(a.path);
    case "move": {
      const r = await files.move(a.from, a.to);
      remap(r.from, r.to);
      return r;
    }
    case "delete": {
      // Park the explainer records and file ids of what was trashed so they
      // don't collide with a file that takes its place; undo un-parks them.
      const r = await files.trashItem(a.path);
      const parked = `.trash/${id(8)}/${r.undo.rel}`;
      remap(r.undo.rel, parked);
      r.undo.parked = parked;
      return r;
    }
    case "retag": {
      const rel = files.norm(String(a.path ?? ""));
      const l = lessonByRel(rel);
      if (!l) throw new FsError(`${rel} isn't an explainer; other files count by their folder`);
      const prev = l.topic ?? null;
      l.topic = topicValue(String(a.topic ?? ""));
      return { text: `tagged "${l.title}" as ${l.topic}`, undo: { op: "retag", lid: l.id, prev }, changed: false };
    }
    default: throw new FsError(`unknown action ${a?.op}`);
  }
}
async function undoSteps(steps) {
  const lines = [], moves = [];
  for (const u of [...steps].reverse()) {
    if (u.op === "retag") { if (S.lessons[u.lid]) S.lessons[u.lid].topic = u.prev; lines.push("put the old tag back"); continue; }
    lines.push(await files.undoStep(u));
    if (u.op === "restore" && u.parked) remap(u.parked, u.rel);
    if (u.op === "move") { remap(u.to, u.from); moves.push([u.to, u.from]); }
  }
  return { lines, moves };
}
async function runBatch(actions, text) {
  return locked(async () => {
    const done = [], lines = [], moves = [];
    let changed = false;
    try {
      for (const a of actions) {
        const r = await applyStep(a);
        done.push(r.undo); lines.push(r.text);
        changed ||= r.changed;
        if (r.from) moves.push([r.from, r.to]);
      }
    } catch (e) {
      await undoSteps(done).catch((u) => console.error("rollback failed:", u.message));
      await save(); await saveChats();
      throw new HttpError(400, `${e.message}${done.length ? " (nothing was changed)" : ""}`);
    }
    if (changed) {
      try { await publish(); }
      catch {
        await undoSteps(done).catch((u) => console.error("rollback failed:", u.message));
        await publish().catch(() => {});
        await save(); await saveChats();
        throw new HttpError(500, "the site wouldn't rebuild after that, so everything was put back");
      }
    }
    const batch = { id: id(), at: now(), text: clip(text, 200), steps: done, lines };
    S.actions.push(batch);
    if (S.actions.length > 100) S.actions.splice(0, S.actions.length - 100);
    await save(); await saveChats();
    return { lines, undo: batch.id, changed: changed || done.length > 0, moves };
  });
}
async function undoBatch(bid) {
  return locked(async () => {
    const batch = bid ? S.actions.find((x) => x.id === bid) : [...S.actions].reverse().find((x) => !x.undone);
    if (!batch) throw new HttpError(400, "nothing to undo");
    if (batch.undone) throw new HttpError(400, "already undone");
    const { lines, moves } = await undoSteps(batch.steps).catch((e) => { throw new HttpError(409, `couldn't undo: ${e.message}`); });
    batch.undone = now();
    await publish().catch(() => {});
    await save(); await saveChats();
    return { reply: `Undid: ${batch.text}`, lines, moves, changed: true, undo: null };
  });
}

async function readManifest() {
  try { return JSON.parse(await readFile(path.join(STATIC, "manifest.json"), "utf8")); } catch { return { tabs: [] }; }
}
async function listing() {
  const titles = new Map();
  for (const t of (await readManifest()).tabs) for (const it of t.items) titles.set(`${t.name}/${it.path}`, it.title);
  const lines = [];
  for (const e of await files.tree()) {
    if (lines.length >= 400) { lines.push("... (more not shown)"); break; }
    if (e.dir) { lines.push(`${e.path}/`); continue; }
    const l = lessonByRel(e.path);
    const title = l?.title ?? titles.get(e.path);
    lines.push(`${e.path}${title && title !== path.basename(e.path) ? `  "${title}"` : ""}${l ? `  [${lessonTopic(l)}]` : ""}`);
  }
  return lines.join("\n");
}
const ORGANIZE = /\b(open|show|move|mv|rename|delete|remove|trash|folders?|dir|directory|put|into|tag|retag|topic|find|search|list|where|undo|create|make|mkdir|chat|this|that|it|file|files|pdf|notes|my|got|have|explainers?|lessons?|stuff|anything|any|history|stuck|confus\w*|struggl\w*)\b|\bdon'?t get\b|\//i;

async function fileFor(p) {
  const rel = files.norm(String(p ?? ""));
  const info = await files.inspect(rel);
  if (!info.exists || !info.file) throw new FsError(`${rel} isn't a file I can see`);
  return rel;
}
async function describe(rel) {
  const l = lessonByRel(rel);
  if (l) return l.title;
  for (const t of (await readManifest()).tabs) for (const it of t.items) if (`${t.name}/${it.path}` === rel) return it.title;
  return path.basename(rel);
}

async function execute(plan, sess, text, open = null) {
  const openCtx = open ? `He was reading ${open} when he asked.` : null;
  const out = { reply: clip(plan.reply ?? "", 600), lines: [], results: [], pending: null, undo: null, changed: false, moves: [], open: null, chat: null, lesson: null, errors: [] };
  const actions = (Array.isArray(plan.actions) ? plan.actions : []).slice(0, 8).filter((a) => a && typeof a === "object");
  let mut = actions.filter((a) => MUTATING.has(a.op));
  // A move onto an existing file is an overwrite: trash the old file first
  // (undo brings it back) and ask for the same one-tap confirm as a delete.
  const replaced = [];
  mut = (await Promise.all(mut.map(async (a) => {
    if (a.op !== "move") return [a];
    try {
      const from = files.norm(String(a.from ?? ""));
      let to = files.norm(String(a.to ?? "")), ti = await files.inspect(to);
      if (ti.exists && ti.dir) to = `${to}/${path.posix.basename(from)}`;
      if (!path.posix.extname(to)) to += path.posix.extname(from);
      ti = await files.inspect(to);
      const fi = await files.inspect(from);
      if (fi.exists && fi.file && ti.exists && ti.file && from !== to) {
        replaced.push(to);
        return [{ op: "delete", path: to, replace: true }, { op: "move", from, to }];
      }
    } catch {}
    return [a];
  }))).flat();
  if (mut.some((a) => a.op === "delete")) {
    // Deletes (and anything batched with them) wait for a one-tap confirm.
    const what = [];
    for (const a of mut) {
      if (a.op === "delete" && a.replace) {
        what.push(`replace ${files.norm(String(a.path))} (the old copy goes to trash)`);
      } else if (a.op === "delete") {
        const rel = files.norm(String(a.path ?? ""));
        const info = await files.inspect(rel);
        if (!info.exists) throw new HttpError(400, `${rel} doesn't exist`);
        what.push(`delete ${rel}${info.dir ? "/ and everything in it" : ""}`);
      } else what.push(a.op === "move" ? `move ${a.from} \u2192 ${a.to}` : `${a.op} ${a.path}`);
    }
    const token = id(9);
    pendingConfirms.set(token, { sessKey: sess.key, actions: mut, text, expires: Date.now() + 10 * 60_000 });
    out.pending = { token, text: `${what.join("; ")}?` };
  } else if (mut.length) {
    try { Object.assign(out, await runBatch(mut, text)); }
    catch (e) { out.errors.push(e.message); out.failed = true; }
  }
  for (const a of actions) {
    try {
      if (a.op === "open") {
        const rel = await fileFor(a.path);
        out.open = { tab: rel.split("/")[0], path: rel.split("/").slice(1).join("/"), rel, title: await describe(rel) };
      } else if (a.op === "find") {
        for (const p of (Array.isArray(a.paths) ? a.paths : []).slice(0, 8)) {
          const rel = await fileFor(p).catch(() => null);
          if (rel && !out.results.some((r) => r.rel === rel)) out.results.push({ rel, tab: rel.split("/")[0], path: rel.split("/").slice(1).join("/"), title: await describe(rel) });
        }
        if (!out.results.length) out.lines.push("nothing matched");
      } else if (a.op === "chat") {
        const rel = await fileFor(a.path);
        out.chat = { file: rel, question: clip(a.question ?? "", 1000), title: await describe(rel) };
      } else if (a.op === "explain") {
        Object.assign(out, await requestExplainer(sess, a.prompt ?? text, { folder: a.folder, context: openCtx, ...(JUST.test(text) ? { check: false } : {}) }));
      } else if (a.op === "history") {
        const r = await requestHistory(sess, { path: a.path || null, topic: a.topic, stuck: a.stuck ?? text });
        out.lesson = r.lesson;
        out.reply ||= r.reply;
      } else if (a.op === "undo") {
        Object.assign(out, await undoBatch(null), { reply: out.reply || "Undone." });
      }
    } catch (e) {
      out.errors.push(e.message);
    }
  }
  return out;
}

route("POST", "/api/command", async (req, res, sess) => {
  if (limited("cmd", sess.key, 20, 60_000)) throw new HttpError(429, "slow down a little");
  const b = await body(req);
  const text = clip(b.text, 1000).trim();
  if (!text) throw new HttpError(400, "say what you want");
  let open = null;
  try { if (b.open) open = files.norm(String(b.open)); } catch {}
  if (/^(u|undo)$/i.test(text)) return undoBatch(null);
  // A plain learning question goes straight to an explainer (no routing call).
  if (!ORGANIZE.test(text.replace(JUST, "")) && !b.route) {
    return execute({ reply: "", actions: [{ op: "explain", prompt: text }] }, sess, text, open);
  }
  const hist = cmdHistory.get(sess.key) ?? [];
  const plan = await llm.chat([
    { role: "system", content: P.COMMAND_SYSTEM },
    ...hist,
    { role: "user", content: P.commandUser({ listing: await listing(), open, text }) },
  ], { json: true, maxTokens: 700, temperature: 0 });
  const out = await execute(plan ?? {}, sess, text, open);
  hist.push({ role: "user", content: `Request: ${text}` }, { role: "assistant", content: JSON.stringify({ reply: out.reply, actions: plan?.actions ?? [], result: [...out.lines, ...out.errors] }).slice(0, 1500) });
  cmdHistory.set(sess.key, hist.slice(-6));
  return out;
}, { ai: true });
route("POST", "/api/command/confirm", async (req, res, sess) => {
  const b = await body(req);
  const p = pendingConfirms.get(String(b.token ?? ""));
  if (!p || p.sessKey !== sess.key || p.expires < Date.now()) throw new HttpError(400, "that confirm expired; ask again");
  pendingConfirms.delete(String(b.token));
  return { reply: "Done.", ...(await runBatch(p.actions, p.text)) };
});
route("POST", "/api/command/cancel", async (req) => {
  const b = await body(req);
  pendingConfirms.delete(String(b.token ?? ""));
  return { reply: "Cancelled; nothing changed.", lines: [], changed: false };
});
route("POST", "/api/command/undo", async (req) => {
  const b = await body(req, { optional: true });
  return undoBatch(typeof b.id === "string" ? b.id : null);
});

// ---------------------------------------------------------- prerequisites ---
// ---- experimental history lessons
// "I still don't get it": a short true history of how the idea came to be,
// saved as a child of the explainer it came from (or under ai/history for a
// plain file / bare topic), tagged with the same topic.
async function sourceText(rel) {
  if (!rel) return "(none: he asked about the concept directly)";
  try {
    const info = await files.inspect(rel);
    if (!info.exists || !info.file) return "(the file is gone)";
    const raw = await readFile(info.full, "utf8");
    return clip(rel.endsWith(".tex") ? texToText(raw) : raw, 6000);
  } catch { return "(couldn't read it)"; }
}
async function requestHistory(sess, { path: p, topic, stuck } = {}) {
  let rel = null;
  if (p) rel = await fileFor(p);
  const src = rel ? lessonByRel(rel) : null;
  const concept = clip(String(topic ?? "").trim(), 200) || (src ? src.title : rel ? await describe(rel) : "");
  if (!concept) throw new HttpError(400, "history of what?");
  let tag = null;
  try { tag = src ? lessonTopic(src) : topic ? topicValue(String(topic)) : null; } catch {}
  if (tag === TAB) tag = null;
  const folder = src && rel ? `${path.posix.dirname(rel)}/${slug(src.title, 40)}` : `${TAB}/history`;
  const l = await startExplainer(`the history of ${concept}`, { kind: "history", stuck, sourceRel: rel, topic: tag, folder, parentId: src?.id, concept });
  return { lesson: lessonPublic(l), reply: `Writing a short history of ${concept} (experimental).` };
}
route("POST", "/api/history", async (req, res, sess) => {
  if (limited("history", sess.key, 6, 60 * 60_000)) throw new HttpError(429, "that's a lot of history lessons this hour");
  const b = await body(req);
  return requestHistory(sess, { path: b.path ? String(b.path) : null, topic: b.topic ? String(b.topic) : null, stuck: b.stuck ? clip(String(b.stuck), 400) : null });
}, { ai: true });

// Before writing an explainer, a quick cheap check: does this build on
// something he hasn't covered? If so, ask (one question) whether to branch
// off to it first. Skipped for "just explain ...", and below depth 3.
const JUST = /\b(just explain( it)?|no prereqs?|skip (the )?prereqs?)\b[:,.]?\s*/i;
const MAX_DEPTH = 3;
const pendingBranches = new Map(); // token -> { sessKey, prompt, folder, parentId, context, prereqs, expires }

async function knownSummary() {
  const lines = [];
  for (const l of Object.values(S.lessons).filter((x) => x.status === "ready" || x.status === "waiting").slice(-60)) lines.push(`- explainer: ${l.title}${l.topic ? ` [${l.topic}]` : ""}`);
  const mins = new Map();
  for (const day of Object.values(S.time)) for (const [k, v] of Object.entries(day)) { const t = topicForKey(k); mins.set(t, (mins.get(t) ?? 0) + v); }
  const top = [...mins].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) lines.push(`- time spent: ${top.map(([t, v]) => `${t} ${Math.round(v / 60)}m`).join(", ")}`);
  for (const t of (await readManifest()).tabs) {
    if (t.name === TAB) continue;
    const titles = t.items.map((it) => it.title).slice(0, 60);
    if (titles.length) lines.push(`- ${t.name} notes: ${titles.join("; ")}`);
  }
  return lines.join("\n").slice(0, 6000);
}

async function requestExplainer(sess, promptIn, { folder, parentId, context, check = true } = {}) {
  let prompt = clip(promptIn, 1500).trim();
  const just = JUST.test(prompt);
  if (just) prompt = prompt.replace(JUST, "").trim() || prompt;
  if (busyWriting()) throw new HttpError(429, "an explainer is already being written; wait for it to finish");
  const parent = parentId ? S.lessons[parentId] : null;
  const depth = parent ? chainOf(parent).length : 0;
  if (check && !just && depth < MAX_DEPTH && prompt) {
    let missing = [];
    try {
      const r = await llm.chat([
        { role: "system", content: P.PREREQ_SYSTEM },
        { role: "user", content: P.prereqUser({ topic: prompt, known: await knownSummary(), trail: parent ? chainOf(parent).map((x) => x.title) : [] }) },
      ], { json: true, maxTokens: 200, temperature: 0 });
      missing = (Array.isArray(r?.missing) ? r.missing : []).filter((m) => m?.name).slice(0, 3)
        .map((m) => ({ name: clip(String(m.name), 60), why: clip(String(m.why ?? ""), 140) }));
    } catch (e) {
      if (e instanceof BudgetError) throw e;
      console.error("prereq check failed:", e.message);
    }
    if (missing.length) {
      const token = id(9);
      for (const [k, v] of pendingBranches) if (v.expires < Date.now()) pendingBranches.delete(k);
      pendingBranches.set(token, { sessKey: sess.key, prompt, folder, parentId, context, prereqs: missing, expires: Date.now() + 30 * 60_000 });
      return { branch: { token, topic: prompt, prereqs: missing, trail: parent ? chainOf(parent).map((x) => ({ id: x.id, title: x.title })) : [] } };
    }
  }
  return { lesson: lessonPublic(await startExplainer(prompt, { folder, parentId, context })) };
}

// Answer to "This builds on X. Branch off to X first?":
// choice "skip" writes the original now; a number branches to that prereq.
route("POST", "/api/branch", async (req, res, sess) => {
  const b = await body(req);
  const p = pendingBranches.get(String(b.token ?? ""));
  if (!p || p.sessKey !== sess.key || p.expires < Date.now()) throw new HttpError(400, "that question expired; ask again");
  if (b.choice === "skip") {
    pendingBranches.delete(String(b.token));
    return { lesson: lessonPublic(await startExplainer(p.prompt, { folder: p.folder, parentId: p.parentId, context: p.context })) };
  }
  const pick = p.prereqs[Number(b.choice)];
  if (!pick) throw new HttpError(400, "pick one of the listed prerequisites");
  if (busyWriting()) throw new HttpError(429, "an explainer is already being written; wait for it to finish");
  pendingBranches.delete(String(b.token));
  // The original waits (no file yet) while he reads the prerequisite, which
  // goes in a subfolder next to where the original will be written.
  const dir = p.folder ? files.norm(String(p.folder)) : `${TAB}/explainers`;
  const w = {
    id: id(), kind: "explainer", title: p.prompt.replace(/\s+/g, " ").slice(0, 80), prompt: p.prompt, goalId: null, topics: [], topic: null,
    status: "waiting", progress: null, created: now(), folder: dir,
    ...(p.parentId ? { parentId: p.parentId } : {}), ...(p.context ? { context: p.context } : {}),
  };
  S.lessons[w.id] = w;
  await save();
  const sub = `${dir}/${slug(w.title, 40)}`;
  const r = await requestExplainer(sess, `${pick.name}${pick.why ? ` (needed for ${w.title}: ${pick.why})` : ""}`, { folder: sub, parentId: w.id });
  return { ...r, waiting: lessonPublic(w) };
}, { ai: true });

// "Back up to <parent>": write the waiting parent now, assuming the
// prerequisites he just read. Already written? Just hand it back to open.
route("POST", "/api/lessons/([\\w-]+)/write", async (req, res, sess, [lid]) => {
  const l = S.lessons[lid];
  if (!l) throw new HttpError(404, "no such explainer");
  if (l.status !== "waiting") return { lesson: lessonPublic(l) };
  if (busyWriting()) throw new HttpError(429, "an explainer is already being written; wait for it to finish");
  Object.assign(l, { status: "generating", progress: "writing", error: null, started: now() });
  await save();
  generateExplainer(l).catch((e) => console.error("explainer failed:", e.message));
  return { lesson: lessonPublic(l) };
}, { ai: true });

// ------------------------------------------------------------------ chat ---

const streaming = new Map();
const chatById = (cid) => C.chats.find((c) => c.id === cid);
const explicitContext = (c) => typeof c.context === "string" ? c.context : "";

// The budget applies only to conversation history, not the explicit context.
// Token counts are estimates (3.5 characters/token plus message overhead).
// Old messages are omitted from requests, never removed from saved chats.
function trimHistory(messages) {
  const convo = messages.filter((m) => m.role === "user" || m.role === "assistant");
  let start = convo.length, used = 0;
  while (start > 0) {
    const tokens = Math.ceil(convo[start - 1].content.length / 3.5) + 4;
    if (used + tokens > CHAT_HISTORY_TOKENS) break;
    used += tokens;
    start--;
  }
  while (start < convo.length && convo[start].role !== "user") start++;
  return { history: convo.slice(start).map(({ role, content }) => ({ role, content })), trimmed: start };
}

function chatSummary(c) {
  return {
    id: c.id, title: c.title, created: c.created, updated: c.updated,
    count: c.messages.filter((m) => m.role === "user" || m.role === "assistant").length,
    context: explicitContext(c), streaming: streaming.has(c.id),
    historyTrimmed: trimHistory(c.messages).trimmed, historyBudgetTokens: CHAT_HISTORY_TOKENS,
  };
}
const chatPublic = (c) => ({ ...chatSummary(c), messages: c.messages });
function requireChat(cid, { idle = false } = {}) {
  const c = chatById(cid);
  if (!c) throw new HttpError(404, "no such chat");
  if (idle && streaming.has(cid)) throw new HttpError(409, "stop the reply or wait for it to finish");
  return c;
}
function contextValue(value) {
  if (typeof value !== "string") throw new HttpError(400, "context must be text");
  if (value.length > CHAT_CONTEXT_CHARS) throw new HttpError(400, `context is limited to ${CHAT_CONTEXT_CHARS} characters`);
  return value;
}
function titleValue(value) {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "give this chat a title");
  if (value.length > CHAT_TITLE_CHARS) throw new HttpError(400, `title is limited to ${CHAT_TITLE_CHARS} characters`);
  return value.trim();
}

route("GET", "/api/chats", async () => ({ chats: C.chats.slice().sort((a, b) => b.updated.localeCompare(a.updated)).map(chatSummary) }));
route("POST", "/api/chats", async (req) => {
  const b = await body(req, { optional: true });
  const at = now();
  let context = b.context === undefined ? "" : contextValue(b.context);
  let title = b.title === undefined ? "New chat" : titleValue(b.title);
  let fileKey, fileId;
  if (b.lessonId !== undefined || b.file !== undefined) {
    // "Ask about this": pin the explainer's / PDF's own text as the context.
    let rel, label, summary = "";
    if (b.lessonId !== undefined) {
      const l = typeof b.lessonId === "string" ? S.lessons[b.lessonId] : null;
      if (!l || l.status !== "ready" || !lessonRel(l)) throw new HttpError(400, "explainer not ready");
      rel = lessonRel(l); label = l.title; summary = l.summary ?? "";
    } else {
      rel = typeof b.file === "string" ? b.file : "";
      if (!/^[\w.+-]+(\/[\w.+-]+){1,7}$/.test(rel) || rel.split("/").some((x) => x === ".." || x === ".") || !/\.(tex|txt|md|py|cpp|c|h|hpp|sh|js|ts|json)$/.test(rel)) throw new HttpError(400, "bad file");
      const l = lessonByRel(rel);
      label = l?.title ?? rel.split("/").slice(1).join("/"); summary = l?.summary ?? "";
    }
    const root = await realpath(CONTENT);
    const full = await realpath(path.join(CONTENT, rel)).catch(() => null);
    if (!full || !full.startsWith(root + path.sep)) throw new HttpError(404, "no such file");
    // Resume the most recent chat already pinned to this file (by stable id,
    // so it survives the file being moved or renamed).
    const fid = fidFor(rel);
    if (!b.fresh) {
      const prev = C.chats.filter((c) => c.fileId === fid || (!c.fileId && c.fileKey === rel)).sort((a, b2) => b2.updated.localeCompare(a.updated))[0];
      if (prev) { prev.fileId = fid; prev.fileKey = rel; return { chat: chatPublic(prev), resumed: true }; }
    }
    fileId = fid;
    const raw = await readFile(full, "utf8").catch(() => "");
    const text = full.endsWith(".tex") ? texToText(raw) : raw;
    context = clip(`Document: ${label}\n${summary ? `Summary: ${summary}\n` : ""}\n${text}`, CHAT_CONTEXT_CHARS);
    title = clip(`About: ${label}`, CHAT_TITLE_CHARS);
    fileKey = rel;
  }
  const c = { id: id(), title, created: at, updated: at, context, ...(fileKey ? { fileKey, fileId } : {}), messages: [] };
  C.chats.push(c);
  await saveChats();
  return { chat: chatPublic(c) };
});
route("GET", "/api/chats/([\\w-]+)", async (req, res, sess, [cid]) => ({ chat: chatPublic(requireChat(cid)) }));
route("POST", "/api/chats/([\\w-]+)/delete", async (req, res, sess, [cid]) => {
  const c = requireChat(cid, { idle: true });
  C.chats.splice(C.chats.indexOf(c), 1);
  await saveChats();
  return { ok: true };
});
route("POST", "/api/chats/([\\w-]+)/context", async (req, res, sess, [cid]) => {
  const b = await body(req);
  const context = contextValue(b.context);
  const c = requireChat(cid, { idle: true });
  c.context = context;
  c.updated = now();
  await saveChats();
  return { chat: chatPublic(c) };
});
route("POST", "/api/chats/([\\w-]+)/title", async (req, res, sess, [cid]) => {
  const b = await body(req);
  const title = titleValue(b.title);
  const c = requireChat(cid, { idle: true });
  c.title = title;
  c.updated = now();
  await saveChats();
  return { chat: chatPublic(c) };
});

// SSE: start {userMessage,historyTrimmed,historyBudgetTokens}, delta {t},
// done {message,chat,usage}, error {error}. Disconnecting stops generation.
route("POST", "/api/chats/([\\w-]+)/messages", async (req, res, sess, [cid]) => {
  const b = await body(req);
  if (typeof b.content !== "string" || !b.content.trim()) throw new HttpError(400, "write a message first");
  if (b.content.length > CHAT_MESSAGE_CHARS) throw new HttpError(400, `messages are limited to ${CHAT_MESSAGE_CHARS} characters`);
  const c = requireChat(cid, { idle: true });
  if (shuttingDown) throw new HttpError(503, "server is restarting");
  const abort = new AbortController();
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  streaming.set(cid, { abort, finished });
  const onClose = () => { if (!res.writableFinished) abort.abort(); };
  res.on("close", onClose);
  const ev = (name, data) => {
    if (!res.destroyed && !res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  let ping;
  try {
    const um = { id: id(4), role: "user", content: b.content.trim(), at: now() };
    c.messages.push(um);
    if (c.title === "new chat" || c.title === "New chat") c.title = clip(um.content.replace(/\s+/g, " "), 70);
    c.updated = now();
    await saveChats(); // Acknowledge the user's message only after it is saved.
    if (res.destroyed) return;
    if (abort.signal.aborted) {
      send(res, 503, { error: "server is restarting; your message was saved" });
      return;
    }

    const { history, trimmed } = trimHistory(c.messages);
    const context = explicitContext(c);
    const messages = [
      { role: "system", content: `${P.CHAT_SYSTEM}${context ? `\n\nContext the user supplied for this conversation:\n${context}` : ""}${trimmed ? `\n\n${trimmed} earlier messages are outside the history window. Don't assume you can recall them.` : ""}` },
      ...history,
    ];
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
    ev("start", { userMessage: um, historyTrimmed: trimmed, historyBudgetTokens: CHAT_HISTORY_TOKENS });
    ping = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(": ping\n\n"); }, 15_000);
    let reply = "", stopped = false, error = null;
    try {
      const out = await llm.stream(messages, {
        maxTokens: CHAT_REPLY_TOKENS, temperature: 0.6, signal: abort.signal,
        onDelta: (t) => { reply += t; ev("delta", { t }); },
      });
      reply = out.text;
      stopped = out.stopped || abort.signal.aborted;
      if (!reply && !stopped) throw new Error("AI returned an empty reply");
    } catch (e) {
      stopped = true;
      error = e;
    }
    let am = null;
    if (reply) {
      am = { id: id(4), role: "assistant", content: reply, at: now(), ...(stopped ? { stopped: true } : {}) };
      c.messages.push(am);
      c.updated = now();
    }
    await saveChats(); // Partial replies survive Stop, provider errors and shutdown.
    streaming.delete(cid);
    if (error) ev("error", { error: clip(error.message, 300) });
    else if (am) ev("done", { message: am, chat: chatPublic(c), usage: llm.status().today });
    else ev("error", { error: "Reply stopped before any text arrived." });
  } catch (e) {
    if (!res.headersSent) throw e;
    console.error(`chat ${cid}: ${e.message}`);
    ev("error", { error: "Couldn't save the reply. Your chat may not be up to date on disk." });
  } finally {
    clearInterval(ping);
    streaming.delete(cid);
    res.off("close", onClose);
    finish();
    if (res.headersSent && !res.writableEnded) res.end();
  }
}, { ai: true, raw: true });

// ---------------------------------------------------------------- static ---
// Local testing only: the public hostname sends non-/api paths to learn.service.
const CSP = "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".pdf": "application/pdf", ".woff2": "font/woff2" };
async function serveStatic(req, res, urlPath) {
  let rel = path.posix.normalize(decodeURIComponent(urlPath)).replace(/^\/+/, "");
  if (rel.split("/").some((s) => s.startsWith("."))) return send(res, 404, { error: "not found" });
  let full = path.join(STATIC, rel);
  try {
    if ((await stat(full)).isDirectory()) full = path.join(full, "index.html");
    full = await realpath(full);
    if (!full.startsWith(STATIC + path.sep)) throw new Error();
  } catch { return send(res, 404, { error: "not found" }); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(full)] ?? "text/plain; charset=utf-8", "Cache-Control": "no-cache", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" });
  createReadStream(full).pipe(res);
}

// ------------------------------------------------------------------ main ---

const llm = createLLM({ dataDir: DATA, today });
let shuttingDown = false;
const server = createServer(async (req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0];
  if (shuttingDown) return send(res, 503, { error: "server is restarting" });
  if (!urlPath.startsWith("/api/")) {
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, urlPath).catch(() => res.destroy());
    return send(res, 405, { error: "method not allowed" });
  }
  try {
    if (limited("req-ip", clientIp(req), 240, 60_000)) throw new HttpError(429, "too many requests");
    const r = routes.find((x) => x.method === req.method && x.re.test(urlPath));
    if (!r) throw new HttpError(routes.some((x) => x.re.test(urlPath)) ? 405 : 404, "not found");
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) throw new HttpError(403, "bad origin");
    }
    let sess = null;
    if (r.auth) {
      sess = session(req);
      if (!sess) throw new HttpError(401, "enter the passcode first");
    }
    if (r.ai) aiGate(sess);
    const out = await r.handler(req, res, sess, urlPath.match(r.re).slice(1));
    if (!r.raw) send(res, 200, out);
  } catch (e) {
    if (res.headersSent) { console.error(`${req.method} ${urlPath} (after headers): ${e.message}`); return res.end(); }
    const status = e instanceof HttpError ? e.status : e instanceof FsError ? 400 : e instanceof BudgetError ? 429 : 500;
    if (status === 500) console.error(`${req.method} ${urlPath}: ${e.stack ?? e.message}`);
    send(res, status, { error: status === 500 ? clip(e.message, 300) : e.message });
  }
});

server.listen(PORT, HOST, () => console.log(`learn-ai: http://${HOST}:${PORT} (data ${DATA}, content ${CONTENT})`));
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const closed = new Promise((resolve) => server.close(resolve));
  const pending = [...streaming.values()];
  for (const active of pending) active.abort.abort();
  await Promise.all(pending.map((active) => active.finished));
  await closed;
  await saveChats();
  await saving;
}
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
  if (shuttingDown) return;
  shutdown().then(() => process.exit(0)).catch((e) => { console.error(`shutdown save failed: ${e.message}`); process.exit(1); });
});
