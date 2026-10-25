// Time tracker shared by the files viewer and /explore/. Each page sets
// window.learnTimeKey = () => "file:<tab>/<path>" | "chat:<id>" | null.
// Time counts only while that key is set, the tab is visible and there was
// input in the last IDLE_MS; it is sent to /api/time about once a minute and
// when the page is hidden. Nothing is sent without a session (401 = stop).
const TICK_MS = 5000;
const IDLE_MS = 150_000;
const FLUSH_MS = 60_000;
let last = Date.now();
let pending = {};
let enabled = null; // unknown until /api/status answers

const bump = () => { last = Date.now(); };
for (const ev of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) addEventListener(ev, bump, { passive: true, capture: true });
addEventListener("scroll", bump, { passive: true, capture: true });

function active() {
  return document.visibilityState === "visible" && Date.now() - last < IDLE_MS;
}

setInterval(() => {
  if (enabled === false || !active()) return;
  const key = window.learnTimeKey?.();
  if (key) pending[key] = (pending[key] ?? 0) + TICK_MS / 1000;
}, TICK_MS);

function flush() {
  const entries = Object.entries(pending).map(([key, secs]) => ({ key, secs: Math.round(secs) })).filter((e) => e.secs > 0);
  pending = {};
  if (!entries.length || enabled === false) return;
  fetch("/api/time", {
    method: "POST", keepalive: true, credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  }).then((r) => { if (r.status === 401) enabled = false; }).catch(() => {});
}
setInterval(flush, FLUSH_MS);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
addEventListener("pagehide", flush);

fetch("/api/status", { credentials: "same-origin" }).then((r) => r.json()).then((s) => { enabled = !!s.authed; }).catch(() => {});
// Signing in later (study/explore login) turns it back on.
window.learnTimeEnable = () => { enabled = true; };
window.learnTimeFlush = flush;
