// Infinite learn: in the side chat next to a PDF, answers longer than a
// couple of sentences become pages of a running LaTeX "session document"
// shown below the PDF you're reading (the server writes and compiles them;
// see /api/infinite/* in ai/server.mjs). Pages are only written on demand:
// a question, a follow-up (c on a written page), or one "continue" page when
// you reach the bottom shortly after asking something. Toggle in the chat
// header; remembered.
const K_ON = "learn.infinite";
const CONTINUE_MS = 4 * 60 * 1000;
const POLL_MS = 2500;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const app = () => window.learnApp;
const inf = { on: store.get(K_ON) !== "0", file: null, view: null, session: null, token: 0, timer: 0, follow: null, contFor: null, lastStatus: "" };
const btn = document.getElementById("sc-inf");

async function api(method, url, body) {
  const r = await fetch(url, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(data.error || `request failed (${r.status})`); e.status = r.status; throw e; }
  return data;
}

function paintToggle() {
  if (!btn) return;
  btn.textContent = `infinite: ${inf.on ? "on" : "off"}`;
  btn.setAttribute("aria-pressed", String(inf.on));
  btn.title = inf.on
    ? "Long answers become pages below the PDF (click to keep everything in chat)"
    : "Everything stays in chat (click to turn long answers into pages below the PDF)";
}
btn?.addEventListener("click", () => {
  inf.on = !inf.on;
  store.set(K_ON, inf.on ? "1" : "0");
  paintToggle();
  apply();
});

// Which session pages are already inside the open PDF (the saved session
// doc), so only later ones are appended. docPagesAt[k] = page count of the
// doc built from the first k ready sections.
function docMap(s, base) {
  const ready = s.sections.filter((x) => x.status === "ready");
  if (inf.view !== "doc") return { inDoc: 0, tags: [] };
  const at = Object.entries(s.docPagesAt ?? {}).map(([k, v]) => [Number(k), v]).filter(([k]) => k <= ready.length);
  let k = at.filter(([, v]) => v === base).map(([n]) => n).sort((a, b) => b - a)[0];
  if (k === undefined) k = at.filter(([, v]) => v <= base).map(([n]) => n).sort((a, b) => b - a)[0] ?? 0;
  const tags = [];
  let end = base;
  for (let i = k - 1; i >= 0; i--) {
    const pages = ready[i].pages ?? 1;
    tags.unshift({ from: end - pages + 1, to: end, n: ready[i].n, title: ready[i].title });
    end -= pages;
  }
  return { inDoc: k, tags };
}

function tailFor(s) {
  const writing = s.sections.find((x) => x.status === "writing");
  if (writing) return { kind: "writing", text: `writing next page\u2026 \u201C${writing.title}\u201D${writing.progress ? ` (${writing.progress})` : ""}` };
  const last = s.sections.at(-1);
  if (last?.status === "failed") return { kind: "error", text: `Couldn't write \u201C${last.title}\u201D: ${last.error || "something went wrong"}. Ask again to retry.` };
  if (s.capped) return { kind: "note", text: `This session reached its ${s.maxPages}-page cap, so answers stay in chat now. Press new in the chat for a fresh session.` };
  return null;
}

let applying = Promise.resolve();
function apply({ scrollTo = null } = {}) {
  const token = inf.token;
  applying = applying.then(async () => {
    const a = app();
    if (!a?.setAppendix) return;
    const s = inf.session;
    const base = await a.whenReady();
    if (token !== inf.token || base === null) return;
    if (!s) { await a.setAppendix({ sections: [], tags: [], tail: null }); return; }
    const { inDoc, tags } = docMap(s, base);
    const ready = s.sections.filter((x) => x.status === "ready");
    // Turning infinite off hides nothing already written; it only stops new pages.
    const sections = ready.slice(inDoc).map((x) => ({ key: `${s.id}:${x.n}:${x.pages ?? 1}`, url: `/api/infinite/${encodeURIComponent(s.id)}/${x.n}.pdf`, n: x.n, title: x.title }));
    await a.setAppendix({ sections, tags, tail: tailFor(s) });
    if (token !== inf.token) return;
    if (scrollTo !== null) a.scrollToSection(scrollTo);
  }).catch((e) => console.error("infinite:", e));
  return applying;
}

function stopPoll() { clearTimeout(inf.timer); inf.timer = 0; }
function poll() {
  stopPoll();
  const s = inf.session;
  if (!s || !s.sections.some((x) => x.status === "writing")) return;
  const token = inf.token;
  inf.timer = setTimeout(async () => {
    try {
      const { session } = await api("GET", `/api/infinite/${encodeURIComponent(s.id)}`);
      if (token !== inf.token) return;
      const before = new Map(inf.session.sections.map((x) => [x.n, x.status]));
      inf.session = session;
      const fresh = session.sections.filter((x) => x.status === "ready" && before.get(x.n) !== "ready");
      const jump = fresh.find((x) => x.n === inf.follow);
      if (jump) inf.follow = null;
      await apply({ scrollTo: jump ? jump.n : null });
    } catch (e) {
      if (e.status === 401 || e.status === 404) return;
    }
    if (token === inf.token) poll();
  }, POLL_MS);
}

// learn:open — look up the session for this file (the source PDF or the
// saved session doc itself).
async function load() {
  inf.token++;
  stopPoll();
  inf.session = null; inf.view = null; inf.follow = null;
  const file = app()?.openKey?.() ?? null;
  // Remembered only once learn mode is up, so the has-study observer below retries.
  inf.file = document.body.classList.contains("has-study") ? file : null;
  if (!file || !app()?.isPdf?.() || !inf.file) return;
  const token = inf.token;
  try {
    const { session, view } = await api("POST", "/api/infinite/lookup", { file });
    if (token !== inf.token || !session) return;
    inf.session = session; inf.view = view;
    await apply();
    poll();
  } catch {}
}
document.addEventListener("learn:open", load);
new MutationObserver(() => { if (document.body.classList.contains("has-study") && inf.file !== (app()?.openKey?.() ?? null)) load(); })
  .observe(document.body, { attributes: true, attributeFilter: ["class"] });

// One "continue" page when you reach the bottom soon after asking something.
document.addEventListener("learn:nearbottom", async () => {
  const s = inf.session;
  if (!inf.on || !s || s.capped || s.writing || s.contUsed || !s.lastAskAt) return;
  const last = s.sections.at(-1);
  if (!last || last.status !== "ready") return;
  if (Date.now() - Date.parse(s.lastAskAt) > CONTINUE_MS || inf.contFor === s.lastAskAt) return;
  inf.contFor = s.lastAskAt;
  const token = inf.token;
  try {
    const { session, chat } = await api("POST", `/api/infinite/${encodeURIComponent(s.id)}/continue`, {});
    if (token !== inf.token) return;
    inf.session = session;
    window.learnSide?.refresh?.(chat);
    await apply();
    poll();
  } catch (e) {
    if (e.status !== 409) console.warn("continue:", e.message);
  }
});

window.learnInfinite = {
  on: () => inf.on,
  // Send chat questions in page mode? Only beside a PDF.
  active: () => inf.on && Boolean(app()?.isPdf?.()),
  view: () => inf.view,
  // The chat started a page (SSE "page" event).
  onPage(session, n) {
    if (!session) return;
    const file = app()?.openKey?.();
    if (!inf.session || inf.session.id !== session.id) inf.view = session.doc && session.doc === file ? "doc" : "source";
    inf.session = session; inf.follow = n;
    apply(); // the new page is scrolled to once it's ready (see poll)
    poll();
  },
  // A fresh chat starts a fresh session (pages written so far stay in their session doc).
  reload: () => load(),
  goto(n) {
    if (inf.session && app()?.scrollToSection?.(n)) return true;
    return false;
  },
};
paintToggle();
