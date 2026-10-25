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
const CHAT_SELECTION_CHARS = 1500;
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
function topicForPath(rel, depth = 0) {
  const l = lessonByRel(rel);
  if (l) return lessonTopic(l);
  // An infinite-learn session doc counts toward the file it started from.
  const sd = depth < 2 && Object.values(S.infinite ?? {}).find((x) => x.docFid && S.fids[x.docFid] === rel);
  const src = sd ? S.fids[sd.sourceFid] : null;
  if (src && src !== rel) return topicForPath(src, depth + 1);
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
  return { history: convo.slice(start).map(({ role, content, where }) => ({ role, content: role === "user" && where ? content + whereNote(where) : content })), trimmed: start };
}

// Where the reader was when they asked (side chat next to the PDF): page and
// any text they had selected. Sent to the model with that message only.
function whereValue(w) {
  if (!w || typeof w !== "object") return null;
  const out = {};
  const int = (v, max) => (Number.isInteger(v) && v >= 1 && v <= max ? v : null);
  if (int(w.pages, 999)) out.pages = w.pages;
  if (int(w.page, out.pages ?? 999)) out.page = w.page;
  if (typeof w.selection === "string" && w.selection.trim()) out.selection = clip(w.selection.replace(/\s+/g, " ").trim(), CHAT_SELECTION_CHARS);
  // Infinite learn: reading one of the pages written this session, or the saved session doc.
  if (int(w.section, 999)) { out.section = w.section; if (typeof w.sectionTitle === "string") out.sectionTitle = clip(w.sectionTitle.replace(/\s+/g, " ").trim(), 120); }
  if (out.section && w.scope === true) out.scope = true; // pressed c on that page: a follow-up page
  if (w.view === "doc") out.view = "doc";
  return Object.keys(out).length ? out : null;
}
function whereNote(w) {
  const bits = [];
  if (w.section && w.scope) bits.push(`This is a follow-up on the page you wrote this session${w.sectionTitle ? ` titled "${w.sectionTitle}"` : ""}.`);
  else if (w.section) bits.push(`I'm reading the page you wrote this session${w.sectionTitle ? ` titled "${w.sectionTitle}"` : ""}.`);
  else if (w.page) bits.push(`I'm reading page ${w.page}${w.pages ? ` of ${w.pages}` : ""} of the ${w.view === "doc" ? "session document" : "document"}.`);
  if (w.selection) bits.push(`I selected this text: "${w.selection}"`);
  return bits.length ? `\n\n[${bits.join(" ")}]` : "";
}

function chatSummary(c) {
  return {
    id: c.id, title: c.title, created: c.created, updated: c.updated,
    count: c.messages.filter((m) => m.role === "user" || m.role === "assistant").length,
    context: explicitContext(c), streaming: streaming.has(c.id),
    historyTrimmed: trimHistory(c.messages).trimmed, historyBudgetTokens: CHAT_HISTORY_TOKENS,
  };
}
const chatPublic = (c) => ({ ...chatSummary(c), sessionId: c.sessionId ?? null, messages: c.messages });
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
      const sd = Object.values(S.infinite).find((x) => x.docFid === fid);
      const sc = sd ? chatById(sd.chatId) : null;
      if (sc) return { chat: chatPublic(sc), resumed: true };
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
    const where = whereValue(b.where);
    const um = { id: id(4), role: "user", content: b.content.trim(), at: now(), ...(where ? { where } : {}) };
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
    // Infinite learn (side chat next to a PDF): long answers become pages.
    const inf = b.infinite === true ? infFor(c, where) : null;
    const pageMode = Boolean(inf?.can);
    const messages = [
      { role: "system", content: `${P.CHAT_SYSTEM}${pageMode ? `\n\n${P.INFINITE_RULE}` : ""}${context ? `\n\nContext the user supplied for this conversation:\n${context}` : ""}${inf ? infChatContext(c) : ""}${trimmed ? `\n\n${trimmed} earlier messages are outside the history window. Don't assume you can recall them.` : ""}` },
      ...history,
    ];
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
    ev("start", { userMessage: um, historyTrimmed: trimmed, historyBudgetTokens: CHAT_HISTORY_TOKENS });
    ping = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(": ping\n\n"); }, 15_000);
    let reply = "", stopped = false, error = null, page = null;
    // A follow-up asked on a page written this session always becomes a page.
    if (pageMode && inf.scoped) page = { title: "", kind: "follow" };
    else {
      // In page mode the first few characters are held back: "PAGE: <title>"
      // means write a page (never shown in chat), anything else streams.
      let mode = pageMode ? null : "chat", gate = "";
      const local = new AbortController();
      const kill = () => local.abort();
      abort.signal.addEventListener("abort", kill);
      const lead = () => gate.replace(/^[\s*_`#>]+/, "");
      try {
        const out = await llm.stream(messages, {
          maxTokens: CHAT_REPLY_TOKENS, temperature: 0.6, signal: local.signal,
          onDelta: (t) => {
            reply += t;
            if (mode === "chat") return ev("delta", { t });
            gate += t;
            const l = lead();
            if (mode === null && (l.length >= 5 || (l && !"PAGE:".startsWith(l.toUpperCase())))) {
              if (/^PAGE:/i.test(l)) mode = "page";
              else { mode = "chat"; ev("delta", { t: gate }); }
            }
            if (mode === "page" && (l.slice(5).includes("\n") || gate.length > 200)) local.abort();
          },
        });
        stopped = abort.signal.aborted || (out.stopped && mode !== "page");
        if (mode === null && gate) { mode = "chat"; ev("delta", { t: gate }); }
        if (mode === "page" && !abort.signal.aborted) {
          page = { title: lead().slice(5).split("\n")[0].replace(/[*_`]/g, "").trim(), kind: "ask" };
          reply = "";
        } else reply = mode === "page" ? "" : out.text;
        if (!reply && !stopped && !page) throw new Error("AI returned an empty reply");
      } catch (e) {
        stopped = true;
        error = e;
      } finally {
        abort.signal.removeEventListener("abort", kill);
      }
    }
    let am = null, started = null;
    if (page) {
      started = infStart(c, { q: um.content, where, kind: page.kind, title: page.title || null, scope: page.kind === "follow" ? where.section : null });
      am = { id: id(4), role: "assistant", content: `${page.kind === "follow" ? "Writing a follow-up page" : "Writing a page"} below the PDF: **${started.x.title}**`, at: now(), page: { sid: started.s.id, n: started.x.n } };
      c.messages.push(am);
      c.updated = now();
    } else if (reply) {
      am = { id: id(4), role: "assistant", content: reply, at: now(), ...(stopped ? { stopped: true } : {}) };
      c.messages.push(am);
      c.updated = now();
    }
    await saveChats(); // Partial replies survive Stop, provider errors and shutdown.
    streaming.delete(cid);
    if (error) ev("error", { error: clip(error.message, 300) });
    else if (am) {
      if (started) ev("page", { session: infPublic(started.s), n: started.x.n });
      const note = inf && !page ? infNote(inf) : null;
      ev("done", { message: am, chat: chatPublic(c), usage: llm.status().today, ...(note ? { note } : {}) });
    } else ev("error", { error: "Reply stopped before any text arrived." });
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

// --------------------------------------------------------- infinite learn ---
// In the side chat next to a PDF, an answer longer than two sentences becomes
// the next page of a running LaTeX "session doc" instead of a chat reply. The
// model either answers short or replies "PAGE: <title>"; the server then
// writes the page (body only), compiles it on its own (shown below the PDF
// right away), then rebuilds the whole session doc (source + every page) and
// saves it as ai/sessions/<date>-<topic>.tex so it can be reopened later.
// Pages are only written on demand: a question, a c follow-up on a page, or
// ONE "continue" when he scrolls to the end within minutes of asking.
S.infinite ??= {};
const INF_DIR = path.join(DATA, "infinite");
const INF_MAX_PAGES = Math.max(1, Number(process.env.LEARN_INFINITE_MAX_PAGES ?? 12));
const INF_CONTINUE_MS = 4 * 60_000;
const INF_PAGE_TOKENS = 2200;
// Links in session pages point back here; plain text when unset.
const SITE_URL = (process.env.LEARN_SITE_URL ?? (process.env.LEARN_ORIGIN ?? "").split(",")[0].trim()).replace(/\/+$/, "");
const SESSIONS_DIR = `${TAB}/sessions`;
const ASKED_MACRO = String.raw`\providecommand{\learnasked}[3]{\par\noindent\begin{tcolorbox}[colback=learncode,colframe=learnmuted,boxrule=0.4pt,arc=2pt,left=6pt,right=6pt,top=4pt,bottom=4pt]{\small\textcolor{learnmuted}{#1}\enspace #2}\par\smallskip{\footnotesize\textcolor{learnmuted}{#3}}\end{tcolorbox}\medskip}`;
const BODY_START = "% learn:page-body", BODY_END = "% learn:page-end";
for (const s of Object.values(S.infinite)) {
  for (const x of s.sections) if (x.status === "writing") Object.assign(x, { status: "failed", error: "interrupted by a restart", progress: null });
}

const infDone = (x) => x.status === "ready";
const infPages = (s) => s.sections.reduce((n, x) => n + (infDone(x) ? x.pages ?? 1 : x.status === "writing" ? 1 : 0), 0);
const infWriting = () => Object.values(S.infinite).some((s) => s.sections.some((x) => x.status === "writing"));
const infCapped = (s) => s.sections.filter((x) => x.status !== "failed").length >= INF_MAX_PAGES || infPages(s) >= INF_MAX_PAGES;
const liveRel = (fid) => { const r = fid ? S.fids[fid] : null; return r && !r.startsWith(".trash/") ? r : null; };
function infContinueBlock(s) {
  const last = s.sections.at(-1);
  if (!last || !infDone(last)) return "nothing to continue yet";
  if (infCapped(s)) return `this session is at its ${INF_MAX_PAGES}-page cap`;
  if (infWriting()) return "still writing a page";
  if (s.contUsed) return "already continued once since your last question";
  if (Date.now() - Date.parse(s.lastAskAt ?? 0) > INF_CONTINUE_MS) return "continue only follows a question from the last few minutes";
  return null;
}
function infPublic(s) {
  return {
    id: s.id, chatId: s.chatId, title: s.title, source: liveRel(s.sourceFid), doc: liveRel(s.docFid),
    created: s.created, updated: s.updated, lastAskAt: s.lastAskAt, contUsed: Boolean(s.contUsed),
    sections: s.sections.map(({ n, title, q, kind, status, pages, error, progress, scope }) => ({ n, title, q, kind, status, pages: pages ?? null, error: error ?? null, progress: progress ?? null, scope: scope ?? null })),
    pages: infPages(s), maxPages: INF_MAX_PAGES, capped: infCapped(s), writing: s.sections.some((x) => x.status === "writing"),
    docPagesAt: s.docPagesAt ?? {}, docError: s.docError ?? null, continueBlocked: infContinueBlock(s),
  };
}

// Text for LaTeX: ASCII only, special characters escaped.
function texEscape(str) {
  return String(str ?? "").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...")
    .normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim()
    .replace(/[\\{}$&#%_~^<>|]/g, (ch) => ({ "\\": "\\textbackslash{}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}", "<": "\\textless{}", ">": "\\textgreater{}", "|": "\\textbar{}" })[ch] ?? `\\${ch}`);
}
function texLink(rel, page, label) {
  const text = texEscape(label);
  if (!SITE_URL || !rel) return text;
  const url = `${SITE_URL}/#/${rel.split("/").map(encodeURIComponent).join("/")}${page ? `?page=${page}` : ""}`.replace(/_/g, "%5F");
  return `\\href{${url.replace(/[#%]/g, (ch) => `\\${ch}`)}}{${text}}`;
}
function infHeader(s, x) {
  const sec = x.scope ? s.sections.find((y) => y.n === x.scope) : null;
  const viewRel = x.where?.view === "doc" ? liveRel(s.docFid) : liveRel(s.sourceFid);
  const bits = [];
  if (sec) bits.push(`follow-up on ${texEscape(sec.title)}`);
  const label = x.where?.view === "doc" ? "this session" : s.title;
  bits.push(`from ${texLink(viewRel, x.where?.page, x.where?.page ? `p.${x.where.page} of ${label}` : label)}`);
  if (x.where?.selection) bits.push(`on "${texEscape(clip(x.where.selection, 160))}${x.where.selection.length > 160 ? "..." : ""}"`);
  const head = x.kind === "continue" ? "Continued:" : x.kind === "follow" ? "Follow-up:" : "You asked:";
  return `\\learnasked{${head}}{${texEscape(clip(x.q, 300))}}{${bits.join(", ")}}`;
}

// The part of the session doc before the pages: the source document itself
// (its preamble, retitled "Session: ...", and body) when it is a usable
// LaTeX file, otherwise a short title page.
async function infPrefix(s) {
  const rel = liveRel(s.sourceFid);
  let raw = "";
  if (!s.plainPrefix && rel?.endsWith(".tex")) raw = await readFile(path.join(CONTENT, rel), "utf8").catch(() => "");
  const m = raw.match(/^([\s\S]*?)\\begin\{document\}([\s\S]*)\\end\{document\}/);
  if (m && !checkTex(raw).length) {
    let pre = m[1], titled = false;
    pre = pre.replace(/\\title\{([^{}]*)\}/, (_, t) => { titled = true; return `\\title{Session: ${t}}`; });
    if (!titled) pre += `\\title{Session: ${texEscape(s.title)}}\n`;
    if (!/\\usepackage\{tikz\}/.test(pre)) pre += "\\usepackage{tikz}\n";
    return { preamble: `${pre.trimEnd()}\n${ASKED_MACRO}\n`, body: m[2], fromSource: true };
  }
  return {
    preamble: `\\documentclass[11pt]{article}\n\\usepackage{learn}\n\\usepackage{tikz}\n\\title{Session: ${texEscape(s.title)}}\n\\author{}\n\\date{${s.day}}\n${ASKED_MACRO}\n`,
    body: `\\maketitle\nPages written while reading ${texLink(rel, null, s.title)}.\n`, fromSource: false,
  };
}
const prefixPages = new Map(); // sha of prefix doc -> pages
async function infPrefixPages(s) {
  let pre = await infPrefix(s);
  for (let i = 0; i < 2; i++) {
    const doc = `${pre.preamble}\\begin{document}\n${pre.body}\\end{document}\n`;
    const key = sha(doc).toString("hex");
    if (prefixPages.has(key)) return { pre, pages: prefixPages.get(key) };
    const r = await compileTex(doc, CONTENT);
    if (r.ok && r.pages) { prefixPages.set(key, r.pages); return { pre, pages: r.pages }; }
    if (!pre.fromSource) break;
    s.plainPrefix = true; // the source won't compile as a prefix: fall back to a title page
    pre = await infPrefix(s);
  }
  throw new Error("couldn't build the start of the session document");
}
const countSections = (t) => (t.match(/\\section\{/g) ?? []).length;
function pageBody(raw) {
  const m = raw.match(/<tex>([\s\S]*?)(<\/tex>|$)/);
  let t = (m ? m[1] : raw).trim().replace(/^```(latex|tex)?\s*/i, "").replace(/```$/, "").trim();
  const doc = t.match(/\\begin\{document\}([\s\S]*?)(\\end\{document\}|$)/);
  if (doc) t = doc[1];
  t = t.replace(/\\(documentclass|usepackage)(\[[^\]]*\])?\{[^}]*\}/g, "").replace(/\\(title|author|date)\{[^}]*\}/g, "").replace(/\\maketitle/g, "").replace(/\\(begin|end)\{document\}/g, "").trim();
  if (!/\\section\*?\{/.test(t.slice(0, 400))) t = `\\section{Answer}\n${t}`;
  return `${t}\n`;
}
function wrapPage(pre, header, body, pageOffset, sectionOffset) {
  return `${pre.preamble}\\begin{document}\n\\setcounter{page}{${pageOffset + 1}}\\setcounter{section}{${sectionOffset}}\n${header}\n${BODY_START}\n${body}${BODY_END}\n\\end{document}\n`;
}
function unwrapPage(doc) {
  const a = doc.indexOf(BODY_START), b = doc.indexOf(BODY_END);
  if (a >= 0 && b > a) return `${doc.slice(a + BODY_START.length, b).trim()}\n`;
  const m = doc.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
  return `${(m ? m[1] : doc).split("\n").filter((l) => !/^\s*\\(setcounter|learnasked)\b/.test(l)).join("\n").trim()}\n`;
}
const sectionTitle = (body) => (body.match(/\\section\*?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/)?.[1] ?? "").replace(/\\[a-zA-Z]+\s*/g, "").replace(/[{}\\$]/g, "").trim();
const readBody = (s, n) => readFile(path.join(INF_DIR, s.id, `${n}.tex`), "utf8").catch(() => "");

async function infWritePage(s, x) {
  const set = (patch) => { Object.assign(x, patch); s.updated = now(); return save(); };
  try {
    const dir = path.join(INF_DIR, s.id);
    await mkdir(dir, { recursive: true });
    const c = chatById(s.chatId);
    const prev = s.sections.filter((y) => infDone(y) && y.n < x.n);
    const scopeN = x.kind === "continue" ? prev.at(-1)?.n : x.scope;
    const scope = scopeN ? clip(texToText(`\\begin{document}${await readBody(s, scopeN)}\\end{document}`), 4000) : "";
    const whereText = [
      x.where?.page ? `page ${x.where.page} of ${x.where.view === "doc" ? "the session document" : "the document"}` : "",
      scopeN ? `the page "${s.sections.find((y) => y.n === scopeN)?.title}"` : "",
      x.where?.selection ? `he selected: "${x.where.selection}"` : "",
    ].filter(Boolean).join("; ") || "(not given)";
    const prefix = infPrefixPages(s); // compile the prefix while the model writes
    prefix.catch(() => {});
    let chars = 0;
    const { text: raw } = await llm.stream([
      { role: "system", content: P.sessionPageSystem({ question: x.q, where: whereText, kind: x.kind, source: clip(c ? explicitContext(c) : "", 6000), pages: prev.map((y) => `${y.title}${y.q && y.kind !== "continue" ? ` (he asked: ${clip(y.q, 140)})` : ""}`).join("\n"), scope }) },
      { role: "user", content: P.sessionPageUser({ question: x.q, title: x.title }) },
    ], { maxTokens: INF_PAGE_TOKENS, temperature: 0.4, onDelta: (t) => { chars += t.length; x.progress = `writing (${(chars / 1000).toFixed(1)}k chars)`; } });
    let body = pageBody(raw);
    const t0 = sectionTitle(body);
    if (t0) x.title = clip(t0, 80);
    const { pre, pages: p0 } = await prefix;
    const prevBodies = await Promise.all(prev.map((y) => readBody(s, y.n)));
    const pageOffset = p0 + prev.reduce((n, y) => n + (y.pages ?? 1), 0);
    const sectionOffset = countSections(pre.body) + prevBodies.reduce((n, t) => n + countSections(t), 0);
    await set({ progress: "compiling" });
    let doc = wrapPage(pre, x.header, body, pageOffset, sectionOffset), r = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const problems = checkTex(doc);
      r = problems.length ? { ok: false, log: `Rejected before compiling: ${problems.join("; ")}` } : await compileTex(doc, CONTENT, { pdfOut: path.join(dir, `${x.n}.pdf`) });
      if (r.ok || attempt === 3) break;
      await set({ progress: `fixing a LaTeX error (try ${attempt + 1}/3)` });
      const fixed = await llm.chat([
        { role: "system", content: P.FIX_SYSTEM },
        { role: "user", content: `Keep every line that starts with "% learn:" exactly as it is.\n\nErrors:\n${r.log}\n\nDocument:\n${doc}` },
      ], { maxTokens: 4500, temperature: 0.1 });
      const m = fixed.match(/<tex>([\s\S]*?)(<\/tex>|$)/);
      doc = (m ? m[1] : fixed).trim().replace(/^```(latex|tex)?\s*/i, "").replace(/```$/, "").trim() + "\n";
    }
    if (!r?.ok) throw new Error("that page wouldn't compile, so it was skipped");
    body = unwrapPage(doc);
    await writeFile(path.join(dir, `${x.n}.tex`), body);
    await set({ status: "ready", pages: r.pages ?? 1, progress: null, error: null });
    infRebuildDoc(s).catch((e) => console.error(`infinite ${s.id}: doc rebuild failed: ${e.message}`));
  } catch (e) {
    await set({ status: "failed", progress: null, error: e instanceof BudgetError ? e.message : clip(e.message, 300) });
  }
}

// The full session doc (source + every ready page). Validated with a real
// compile before it is written into the content tree, then published.
const infLocks = new Map();
function infRebuildDoc(s) {
  const run = (infLocks.get(s.id) ?? Promise.resolve()).then(() => rebuildNow(s));
  infLocks.set(s.id, run.catch(() => {}));
  return run;
}
async function rebuildNow(s) {
  const ready = s.sections.filter(infDone);
  if (!ready.length) return;
  const { pre } = await infPrefixPages(s);
  const bodies = await Promise.all(ready.map((y) => readBody(s, y.n)));
  const tex = `${pre.preamble}\\begin{document}\n${pre.body}${ready.map((y, i) => `\n\\clearpage\n${infHeader(s, y)}\n${bodies[i]}`).join("")}\\end{document}\n`;
  const problems = checkTex(tex);
  const r = problems.length ? { ok: false, log: problems.join("; ") } : await compileTex(tex, CONTENT);
  if (!r.ok) { s.docError = `the full session doc didn't compile: ${clip(r.log, 200)}`; await save(); return; }
  s.docPagesAt = { ...s.docPagesAt, [ready.length]: r.pages };
  let rel = liveRel(s.docFid);
  if (rel && !existsSync(path.join(CONTENT, rel))) rel = null;
  let previous = null;
  if (!rel) {
    await files.ensureDir(SESSIONS_DIR);
    const base = `${s.day}-${slug(s.title)}`;
    rel = `${SESSIONS_DIR}/${base}.tex`;
    for (let i = 2; existsSync(path.join(CONTENT, rel)); i++) rel = `${SESSIONS_DIR}/${base}-${i}.tex`;
    s.docFid = fidFor(rel);
  } else previous = await readFile(path.join(CONTENT, rel), "utf8").catch(() => null);
  const target = (await files.inspect(rel)).full;
  await writeLessonFile(target, tex);
  s.docError = null;
  await save();
  try {
    await publish();
  } catch (e) {
    // Never leave a file that breaks the site build in the content tree.
    if (previous !== null) await writeLessonFile(target, previous).catch(() => {});
    else await rename(target, path.join(DATA, "backups", `unpublished-${Date.now()}-${path.basename(rel)}`)).catch(() => {});
    s.docError = "publishing the session doc failed";
    await save();
    throw e;
  }
}

function infStart(c, { q, where, kind, title, scope = null }) {
  let s = c.sessionId ? S.infinite[c.sessionId] : null;
  if (!s) {
    const sid = id(5);
    const label = clip(c.title.replace(/^About: /, "").replace(/\.tex$/, "").split("/").pop(), 80) || "session";
    s = S.infinite[sid] = { id: sid, chatId: c.id, sourceFid: c.fileId, title: label, day: today(), created: now(), updated: now(), sections: [], docFid: null, docPagesAt: {}, lastAskAt: null, contUsed: false };
    c.sessionId = sid;
  }
  const n = (s.sections.at(-1)?.n ?? 0) + 1;
  const x = { n, title: clip(title || q, 80), q: clip(q, 600), kind, where: where ?? null, scope, status: "writing", progress: "starting", created: now() };
  x.header = infHeader(s, x);
  s.sections.push(x);
  if (kind === "continue") s.contUsed = true;
  else { s.lastAskAt = now(); s.contUsed = false; }
  s.updated = now();
  save();
  infWritePage(s, x);
  return { s, x };
}
// Whether this chat message may become a page.
function infFor(c, where) {
  const rel = liveRel(c.fileId) ?? c.fileKey;
  if (!rel || !rel.endsWith(".tex")) return null;
  const s = c.sessionId ? S.infinite[c.sessionId] : null;
  const capped = Boolean(s && infCapped(s));
  const busy = infWriting();
  const scoped = Boolean(where?.scope && where.section && s?.sections.some((y) => y.n === where.section && infDone(y)));
  return { s, capped, busy, can: !capped && !busy, scoped };
}
function infNote(inf) {
  if (inf?.capped) return `This session is at its ${INF_MAX_PAGES}-page cap, so answers stay in chat now. Press new for a fresh session.`;
  if (inf?.busy) return "Still writing the last page, so this answer stayed in chat.";
  return null;
}
function infChatContext(c) {
  const s = c.sessionId ? S.infinite[c.sessionId] : null;
  const ready = s?.sections.filter(infDone) ?? [];
  return ready.length ? `\n\nPages already written below the PDF this session: ${ready.map((y) => `"${y.title}"`).join(", ")}.` : "";
}

route("POST", "/api/infinite/lookup", async (req) => {
  const b = await body(req);
  const rel = typeof b.file === "string" ? b.file : "";
  const fid = fidByPath().get(rel);
  if (!fid) return { session: null };
  let s = Object.values(S.infinite).find((x) => x.docFid === fid);
  if (s) return { session: infPublic(s), view: "doc" };
  const prev = C.chats.filter((c) => c.fileId === fid).sort((a, b2) => b2.updated.localeCompare(a.updated))[0];
  s = prev?.sessionId ? S.infinite[prev.sessionId] : null;
  return { session: s ? infPublic(s) : null, view: "source" };
});
route("GET", "/api/infinite/([\\w-]+)", async (req, res, sess, [sid]) => {
  const s = S.infinite[sid];
  if (!s) throw new HttpError(404, "no such session");
  return { session: infPublic(s) };
});
route("GET", "/api/infinite/([\\w-]+)/(\\d{1,3})\\.pdf", async (req, res, sess, [sid, n]) => {
  const s = S.infinite[sid];
  const x = s?.sections.find((y) => y.n === Number(n));
  if (!x || !infDone(x)) throw new HttpError(404, "no such page");
  const data = await readFile(path.join(INF_DIR, sid, `${x.n}.pdf`)).catch(() => null);
  if (!data) throw new HttpError(404, "no such page");
  res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": data.length, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
  res.end(data);
}, { raw: true });
route("POST", "/api/infinite/([\\w-]+)/continue", async (req, res, sess, [sid]) => {
  const s = S.infinite[sid];
  if (!s) throw new HttpError(404, "no such session");
  const c = chatById(s.chatId);
  if (!c) throw new HttpError(404, "that session's chat is gone");
  const blocked = infContinueBlock(s);
  if (blocked) throw new HttpError(409, blocked);
  const last = s.sections.at(-1);
  const { x } = infStart(c, { q: `Keep going from "${last.title}"`, kind: "continue", title: `More on ${last.title}` });
  c.messages.push({ id: id(4), role: "assistant", content: `Kept going below the PDF: **${x.title}**`, at: now(), page: { sid: s.id, n: x.n }, auto: true });
  c.updated = now();
  await saveChats();
  return { session: infPublic(s), chat: chatPublic(c) };
}, { ai: true });

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
