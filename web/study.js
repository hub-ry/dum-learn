// "learn" mode: one prompt box that turns what you're stuck
// on into a short LaTeX PDF explainer, the list of past explainers, and a
// "time" view (bar chart of time spent by topic). Talks to /api/* (learn-ai);
// hidden entirely if the API is not reachable. AI text is only ever inserted
// with textContent, never as HTML.

const $ = (id) => document.getElementById(id);
const els = { btn: $("study-btn"), view: $("study-view"), pane: $("study-view-pane"), title: $("study-title"), mode: $("mode"), status: $("status"), hints: $("hints") };

const st = {
  on: false, authed: false, view: "learn", data: null, sel: 0, msg: null, poll: 0, tick: 0,
  time: null, chart: "topic", range: "all", editing: null, submitting: false,
};
const ui = {}; // persistent nodes of the learn view (so typing is never clobbered)

// ------------------------------------------------------------------ api ---

async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && url !== "/api/login") { st.authed = false; st.data = null; render(); }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// ------------------------------------------------------------------ dom ---

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
const SVG = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}
const btn = (key, label, fn, cls = "") => h("button", { type: "button", class: `act ${cls}`, onclick: fn, "data-key": key || null }, key ? h("b", {}, key) : null, key ? " " : "", label);

function dur(secs) {
  secs = Math.round(secs);
  if (secs < 60) return `${secs}s`;
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
const shortDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

// -------------------------------------------------------------- explainers ---

// Newest first, with prerequisite branches nested right under the explainer
// they were branched off from.
function explainers() {
  const all = st.data?.explainers ?? [];
  if (all.length === st._n && st._src === all) return st._order;
  const ids = new Set(all.map((l) => l.id));
  const kids = new Map();
  for (const l of all) if (l.parentId && ids.has(l.parentId)) (kids.get(l.parentId) ?? kids.set(l.parentId, []).get(l.parentId)).push(l);
  const out = [];
  const walk = (l, depth) => { l._depth = depth; out.push(l); for (const c of kids.get(l.id) ?? []) walk(c, depth + 1); };
  for (const l of all) if (!l.parentId || !ids.has(l.parentId)) walk(l, 0);
  st._src = all; st._n = all.length; st._order = out;
  return out;
}
const byId = (lid) => (st.data?.explainers ?? []).find((l) => l.id === lid);
const generating = () => explainers().find((l) => l.status === "generating");

async function refresh() {
  const keep = explainers()[st.sel]?.id;
  st.data = await api("GET", "/api/state");
  const idx = keep ? explainers().findIndex((l) => l.id === keep) : -1;
  st.sel = idx >= 0 ? idx : Math.min(st.sel, Math.max(0, explainers().length - 1));
}

// The learn prompt goes through the command box, so "explain semaphores,
// put it in OS" or "open my mutex notes" work here too.
async function submit() {
  const prompt = ui.input.value.trim();
  if (!prompt || st.submitting || generating()) return;
  st.submitting = true; st.msg = null; st.branch = null; renderLearn();
  try {
    if (window.learnCommand) await window.learnCommand.run(prompt, { quiet: true });
    else track((await api("POST", "/api/lessons", { prompt })).lesson);
    ui.input.value = "";
  } catch (e) { st.msg = e.message; }
  st.submitting = false;
  renderLearn();
}

// Follow an explainer that is being written (from here or the command box).
async function track(lesson) {
  st.branch = null;
  if (!st.on) await enter({ view: "learn" });
  else if (st.view !== "learn") setView("learn");
  await refresh().catch(() => {});
  if (!byId(lesson.id)) st.data?.explainers.unshift(lesson);
  st._n = -1;
  st.sel = Math.max(0, explainers().findIndex((l) => l.id === lesson.id));
  if (lesson.status === "generating") { st.autoOpen = lesson.id; startPoll(); }
  else if (lesson.status === "ready") open(lesson);
  renderLearn();
}

// "This builds on X. Branch off to X first?" One question at a time.
async function ask(branch) {
  if (!st.on) await enter({ view: "learn" });
  else if (st.view !== "learn") setView("learn");
  st.branch = branch; st.msg = null;
  ui.input?.blur();
  renderLearn();
}
async function answer(choice) {
  const b = st.branch;
  if (!b || st.submitting) return;
  st.submitting = true; renderLearn();
  try {
    const r = await api("POST", "/api/branch", { token: b.token, choice });
    st.branch = null;
    if (r.branch) await ask(r.branch);
    if (r.lesson) await track(r.lesson);
    else await refresh();
  } catch (e) { st.msg = e.message; }
  st.submitting = false;
  renderLearn();
}
// "Back up to <parent>": write the waiting parent (assuming what he just
// read), or open it if it's already written.
async function backUp(l) {
  const parent = l?.parentId ? byId(l.parentId) : null;
  if (!parent) return;
  if (parent.status === "ready") return open(parent);
  if (parent.status === "generating") { st.sel = explainers().indexOf(parent); return renderLearn(); }
  try {
    const { lesson } = await api("POST", `/api/lessons/${parent.id}/write`);
    await track(lesson);
  } catch (e) { st.msg = e.message; renderLearn(); }
}

function startPoll() {
  stopPoll();
  st.poll = setInterval(async () => {
    const g = generating();
    if (!g) return stopPoll();
    try {
      const { lesson } = await api("GET", `/api/lessons/${g.id}`);
      Object.assign(g, lesson);
      if (lesson.status !== "generating") {
        stopPoll();
        await refresh().catch(() => {});
        if (lesson.status === "ready" && st.autoOpen === lesson.id && st.on && st.view === "learn") open(lesson);
        st.autoOpen = null;
      }
      renderLearn();
    } catch {}
  }, 1500);
  st.tick = setInterval(() => renderProgress(), 1000);
}
function stopPoll() { clearInterval(st.poll); clearInterval(st.tick); st.poll = st.tick = 0; }

function open(l) {
  if (!l?.file || l.status !== "ready") return;
  if (l.missing) { st.msg = "that file was moved or deleted outside the site"; return renderLearn(); }
  leave();
  window.learnApp?.openPath(l.tab ?? "ai", l.file);
}
// Experimental: "I still don't get it" -> a short history of the idea,
// saved as a child of the explainer (or under ai/history for other files).
async function historyLesson(rel, stuck) {
  if (!rel) return;
  try { const { lesson } = await api("POST", "/api/history", { path: rel, ...(stuck ? { stuck } : {}) }); await track(lesson); }
  catch (e) { if (!st.on) await enter({ view: "learn" }); st.msg = e.message; renderLearn(); }
}
function chatAbout(l) {
  if (!l?.path || l.status !== "ready") return;
  // Open it in the viewer with the side chat beside it (web/sidechat.js).
  const [tab, ...rest] = l.path.split("/");
  window.learnApp?.openPath(tab, rest.join("/")).then(() => window.learnSide?.open());
}
async function writeWaiting(l) {
  try { const { lesson } = await api("POST", `/api/lessons/${l.id}/write`); await track(lesson); }
  catch (e) { st.msg = e.message; renderLearn(); }
}
async function retry(l) {
  try { const { lesson } = await api("POST", `/api/lessons/${l.id}/retry`); Object.assign(l, lesson); st.autoOpen = l.id; startPoll(); }
  catch (e) { st.msg = e.message; }
  renderLearn();
}
async function saveTopic(l, value) {
  st.editing = null;
  if (value.trim() && value.trim() !== l.topic) {
    try { const r = await api("POST", `/api/lessons/${l.id}/topic`, { topic: value }); st.data = { explainers: r.explainers, topics: r.topics }; st.time = null; }
    catch (e) { st.msg = e.message; }
  }
  renderLearn();
}

// ------------------------------------------------------------------ views ---

function buildLearn() {
  ui.input = h("textarea", { id: "ask", rows: "3", placeholder: "what are you stuck on?  e.g. what is a mutex", spellcheck: "true", "aria-label": "what are you stuck on" });
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  ui.send = h("button", { type: "submit", class: "act primary" }, h("b", {}, "enter"), " explain it");
  ui.form = h("form", { class: "ask", onsubmit: (e) => { e.preventDefault(); submit(); } },
    ui.input, h("div", { class: "row" }, ui.send, h("span", { class: "muted small" }, "a short PDF in the usual style · shift+enter for a new line")));
  ui.trail = h("nav", { class: "trail", "aria-label": "branch trail" });
  ui.branch = h("div", { class: "branch-q", "aria-live": "polite" });
  ui.progress = h("div", { class: "progress", "aria-live": "polite" });
  ui.list = h("ul", { class: "explainers", role: "listbox", "aria-label": "past explainers" });
  ui.root = h("div", { class: "learn-wrap" }, ui.form, ui.trail, ui.branch, ui.progress, h("h3", { class: "sub" }, "past explainers"), ui.list);
}

function renderProgress() {
  const g = generating();
  ui.progress.replaceChildren();
  if (st.msg) ui.progress.append(h("p", { class: "error" }, st.msg));
  if (!g) return;
  const secs = g.started ? Math.max(0, Math.round((Date.now() - new Date(g.started)) / 1000)) : 0;
  const steps = ["writing", "compiling", "publishing"];
  const at = Math.max(0, steps.findIndex((x) => String(g.progress ?? "").startsWith(x)));
  ui.progress.append(h("div", { class: "box gen" },
    h("div", { class: "row" }, h("span", { class: "spin" }), h("span", {}, g.title)),
    h("div", { class: "steps" }, steps.map((x, i) => h("span", { class: i < at ? "done" : i === at ? "now" : "" }, x))),
    h("div", { class: "muted small" }, `${g.progress ?? ""} · ${secs}s`)));
}

function renderList() {
  ui.list.replaceChildren();
  const list = explainers();
  if (!list.length) { ui.list.append(h("li", { class: "muted empty-li" }, "Nothing yet. Ask something above.")); return; }
  list.forEach((l, i) => {
    let topic;
    if (st.editing === l.id) {
      topic = h("input", { class: "topic-edit", value: l.topic, maxlength: "32", "aria-label": "topic" });
      topic.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); saveTopic(l, topic.value); }
        else if (e.key === "Escape") { e.preventDefault(); st.editing = null; renderLearn(); }
      });
      topic.addEventListener("blur", () => { if (st.editing === l.id) saveTopic(l, topic.value); });
      setTimeout(() => { topic.focus(); topic.select(); }, 0);
    } else {
      topic = h("button", { type: "button", class: "topic", title: "edit topic (e)", onclick: (e) => { e.stopPropagation(); st.editing = l.id; renderLearn(); } }, l.topic);
    }
    const right = l.status === "waiting"
      ? h("button", { type: "button", class: "key-btn", title: "write it now, assuming its prerequisites", onclick: (e) => { e.stopPropagation(); writeWaiting(l); } }, "waiting \u00B7 write")
      : l.status === "ready"
      ? h("button", { type: "button", class: "key-btn chat-mini", title: "chat about it (c)", onclick: (e) => { e.stopPropagation(); chatAbout(l); } }, "chat")
      : l.status === "failed" ? h("button", { type: "button", class: "key-btn error", onclick: (e) => { e.stopPropagation(); retry(l); } }, "failed · retry")
      : h("span", { class: "busy small" }, "writing…");
    ui.list.append(h("li", {
      class: `${i === st.sel ? "selected" : ""} ${l.status}`, role: "option", "aria-selected": String(i === st.sel),
      onclick: () => { st.sel = i; if (l.status === "waiting") renderLearn(); else open(l); }, title: [l.summary || l.prompt, l.path].filter(Boolean).join("\n"),
      style: l._depth ? `--depth:${l._depth}` : null,
    }, h("span", { class: "t" }, l._depth ? h("span", { class: "branch-mark", "aria-hidden": "true" }, "\u21B3 ") : null, l.title, l.kind === "history" ? h("span", { class: "exp-tag" }, "experimental") : null, l.children?.length ? h("span", { class: "muted small" }, ` \u00B7 ${l.children.length} prereq${l.children.length > 1 ? "s" : ""}`) : null), topic, h("span", { class: "muted small date" }, shortDate(l.created)), right));
  });
  ui.list.children[st.sel]?.scrollIntoView?.({ block: "nearest" });
}

// Breadcrumb for the selected explainer's branch (or the open question):
// original > prereq > prereq-of-prereq, plus "back up to <parent>".
function renderTrail() {
  ui.trail.replaceChildren();
  const cur = explainers()[st.sel];
  let crumbs = [], up = null;
  if (st.branch) crumbs = [...(st.branch.trail ?? []).map((x) => byId(x.id) ?? x), { title: st.branch.topic }];
  else if (cur && (cur.parentId || cur.children?.length)) {
    crumbs = (cur.trail ?? []).map((x) => byId(x.id) ?? x);
    if (cur.parentId) up = cur;
  }
  if (crumbs.length < 2 && !up) return;
  const parts = [];
  crumbs.forEach((c, i) => {
    if (i) parts.push(h("span", { class: "sep", "aria-hidden": "true" }, " \u203A "));
    const last = i === crumbs.length - 1;
    parts.push(c.id && !last
      ? h("button", { type: "button", class: "linkish", onclick: () => { st.sel = Math.max(0, explainers().findIndex((l) => l.id === c.id)); renderLearn(); } }, c.title)
      : h("span", { class: last ? "here" : "" }, c.title));
    if (c.status === "waiting") parts.push(h("span", { class: "muted small" }, " (waiting)"));
  });
  const parent = up ? byId(up.parentId) : null;
  ui.trail.append(h("div", { class: "crumbs" }, parts),
    parent ? btn("b", `back up to ${parent.title}`, () => backUp(up), "up") : null);
}

function renderBranch() {
  ui.branch.replaceChildren();
  const b = st.branch;
  if (!b) return;
  const [first, ...rest] = b.prereqs;
  ui.branch.append(h("div", { class: "box" },
    h("p", {}, "This builds on ", h("b", {}, first.name), first.why ? h("span", { class: "muted" }, ` (${first.why})`) : null, ". Branch off to it first?"),
    h("div", { class: "row" },
      btn("y", "yes, branch", () => answer(0), "primary"),
      btn("s", "skip, explain anyway", () => answer("skip")),
      rest.length ? h("span", { class: "muted small" }, "or branch to") : null,
      ...rest.map((p, i) => btn(String(i + 2), p.name, () => answer(i + 1)))),
    b.trail?.length >= 2 ? h("p", { class: "muted small" }, "this is the last level of branching; after this it explains directly") : null));
}

function renderLearn() {
  if (!st.on || st.view !== "learn" || !st.authed) return;
  if (ui.send) ui.send.disabled = st.submitting || !!generating();
  renderTrail();
  renderBranch();
  renderProgress();
  renderList();
}

// ----------------------------------------------------------------- time ---

const weekStart = (day) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function loadTime() {
  window.learnTimeFlush?.();
  try { st.time = await api("GET", "/api/time"); } catch (e) { st.msg = e.message; }
  if (st.view === "time") renderTime();
}

function chartByTopic(rows, today) {
  const from = st.range === "7d" ? addDays(today, -6) : st.range === "30d" ? addDays(today, -29) : "";
  const by = {};
  for (const r of rows) if (r.day >= from) by[r.topic] = (by[r.topic] ?? 0) + r.secs;
  const data = Object.entries(by).sort((a, b) => b[1] - a[1]);
  if (!data.length) return null;
  const W = 640, LBL = 170, VAL = 70, ROW = 28, max = data[0][1];
  const svg = s("svg", { viewBox: `0 0 ${W} ${data.length * ROW + 6}`, class: "chart-svg", role: "img", "aria-label": "time by topic" });
  data.forEach(([topic, secs], i) => {
    const y = i * ROW + 4, bw = Math.max(2, ((W - LBL - VAL) * secs) / max);
    const g = s("g", {});
    g.append(s("title", {}, `${topic}: ${dur(secs)}`));
    g.append(s("text", { x: LBL - 10, y: y + 15, "text-anchor": "end", class: "lbl" }, topic.length > 22 ? `${topic.slice(0, 21)}…` : topic));
    g.append(s("rect", { x: LBL, y, width: bw, height: ROW - 10, rx: 2, class: `bar s${(i % 7) + 1}` }));
    g.append(s("text", { x: LBL + bw + 8, y: y + 15, class: "val" }, dur(secs)));
    svg.append(g);
  });
  return svg;
}

function chartByWeek(rows, today) {
  const weeks = [];
  for (let w = weekStart(today), i = 0; i < 8; i++, w = addDays(w, -7)) weeks.unshift(w);
  const totals = {};
  for (const r of rows) totals[r.topic] = (totals[r.topic] ?? 0) + r.secs;
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
  const cls = (t) => { const i = top.indexOf(t); return i < 0 ? "s7" : `s${i + 1}`; };
  const per = Object.fromEntries(weeks.map((w) => [w, {}]));
  for (const r of rows) { const w = weekStart(r.day); if (per[w]) { const k = top.includes(r.topic) ? r.topic : "other"; per[w][k] = (per[w][k] ?? 0) + r.secs; } }
  const sums = weeks.map((w) => Object.values(per[w]).reduce((a, b) => a + b, 0));
  const max = Math.max(...sums);
  if (!max) return null;
  const W = 640, H = 230, B = 26, T = 18, colW = W / weeks.length, bw = colW * 0.56;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img", "aria-label": "time by week" });
  svg.append(s("line", { x1: 0, x2: W, y1: H - B, y2: H - B, class: "axis" }));
  weeks.forEach((w, i) => {
    const x = i * colW + (colW - bw) / 2;
    let y = H - B;
    for (const t of [...top, "other"]) {
      const secs = per[w][t]; if (!secs) continue;
      const bh = ((H - B - T) * secs) / max;
      y -= bh;
      const r = s("rect", { x, y, width: bw, height: Math.max(1, bh), class: `bar ${t === "other" ? "s7" : cls(t)}` });
      r.append(s("title", {}, `${t}: ${dur(secs)}`));
      svg.append(r);
    }
    if (sums[i]) svg.append(s("text", { x: x + bw / 2, y: y - 5, "text-anchor": "middle", class: "val" }, dur(sums[i])));
    svg.append(s("text", { x: x + bw / 2, y: H - 8, "text-anchor": "middle", class: "lbl small" }, shortDate(`${w}T12:00:00Z`)));
  });
  const legend = h("div", { class: "legend" }, [...top, ...(Object.keys(totals).length > top.length ? ["other"] : [])]
    .map((t) => h("span", {}, h("i", { class: `sw ${t === "other" ? "s7" : cls(t)}` }), t)));
  return h("div", {}, svg, legend);
}

function renderTime() {
  if (!st.on || st.view !== "time") return;
  const t = st.time;
  const seg = (key, label, on, fn) => h("button", { type: "button", class: "act seg", "aria-pressed": String(on), onclick: fn, "data-key": key || null }, key ? h("b", {}, key) : null, key ? " " : "", label);
  const root = h("div", { class: "learn-wrap time-wrap" });
  if (!t) { root.append(h("p", { class: "muted" }, st.msg ?? "loading…")); els.view.replaceChildren(root); return; }
  const total = t.rows.reduce((a, r) => a + r.secs, 0);
  const todaySecs = t.rows.filter((r) => r.day === t.today).reduce((a, r) => a + r.secs, 0);
  const wk = weekStart(t.today);
  const weekSecs = t.rows.filter((r) => r.day >= wk).reduce((a, r) => a + r.secs, 0);
  root.append(
    h("div", { class: "row controls" },
      seg("w", "by topic", st.chart === "topic", () => { st.chart = "topic"; renderTime(); }),
      seg("", "by week", st.chart === "week", () => { st.chart = "week"; renderTime(); }),
      st.chart === "topic" ? h("span", { class: "row gap" },
        ...[["7d", "7 days"], ["30d", "30 days"], ["all", "all time"]].map(([k, label]) => seg("", label, st.range === k, () => { st.range = k; renderTime(); }))) : null),
    h("p", { class: "muted small" }, `today ${dur(todaySecs)} · this week ${dur(weekSecs)} · all time ${dur(total)}`));
  const chart = st.chart === "week" ? chartByWeek(t.rows, t.today) : chartByTopic(t.rows, t.today);
  root.append(h("div", { class: "chart" }, chart ?? h("p", { class: "muted" }, "Nothing here yet. Time counts while a PDF or a chat is open in front of you (it pauses when the tab is hidden or you've been idle for a few minutes).")));
  root.append(h("p", { class: "muted small" }, "Topics come from each explainer's tag (edit it in the learn list); other PDFs count by tab/folder; chats count toward the file they're about."));
  els.view.replaceChildren(root);
}

// ---------------------------------------------------------------- render ---

function loginView() {
  const input = h("input", { id: "passcode", type: "password", autocomplete: "current-password", placeholder: "passcode" });
  const msg = h("p", { class: "error" }, st.msg ?? "");
  const form = h("form", { class: "ask stack", onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api("POST", "/api/login", { passcode: input.value });
      st.authed = true; st.msg = null;
      window.learnTimeEnable?.();
      await refresh();
      render();
    } catch (err) { st.msg = err.message; msg.textContent = err.message; }
  } }, h("p", { class: "muted" }, "Writing explainers uses real API credits, so it's behind a passcode. Everything stays public to read."),
  h("label", { class: "field" }, h("span", {}, "passcode"), input), h("div", { class: "row" }, h("button", { type: "submit", class: "act primary" }, "unlock")), msg);
  setTimeout(() => input.focus(), 0);
  return h("div", { class: "learn-wrap" }, form);
}

function renderTitle() {
  const tab = (name, key) => h("button", { type: "button", class: `title-tab ${st.view === name ? "on" : ""}`, onclick: () => setView(name) }, h("span", { class: "num" }, `${key}:`), name);
  els.title.replaceChildren(tab("learn", "a"), " ", tab("time", "t"));
}

function render() {
  if (!st.on) return;
  renderTitle();
  if (!st.authed) { els.view.replaceChildren(loginView()); renderChrome(); return; }
  if (st.view === "learn") {
    if (!ui.root) buildLearn();
    if (els.view.firstChild !== ui.root) els.view.replaceChildren(ui.root);
    renderLearn();
  } else renderTime();
  renderChrome();
}

function renderChrome() {
  els.mode.textContent = st.view === "time" ? "TIME" : "LEARN";
  els.mode.classList.remove("view");
  els.mode.classList.add("study");
  els.status.textContent = "";
  const hint = (k, label) => `<b>${k}</b> ${label}`;
  const hs = !st.authed ? [hint("enter", "unlock"), hint("esc", "files")]
    : st.view === "time" ? [hint("w", "topic/week"), hint("t", "learn"), hint("a/esc", "files"), hint("?", "help")]
    : st.branch ? [hint("y", "branch"), hint("s", "skip"), hint("2-3", "other prereq"), hint("a/esc", "files")]
    : [hint("enter", "explain"), hint("j/k", "move"), hint("o", "open"), hint("b", "back up"), hint("c", "chat"), hint("h", "history"), hint(":", "command"), hint("t", "time"), hint("a/esc", "files")];
  els.hints.innerHTML = hs.join("  ");
}

function setView(v) {
  st.view = v;
  st.msg = null;
  if (location.hash !== `#/${v}`) history.replaceState(null, "", `#/${v}`);
  if (v === "time") { st.time = null; loadTime(); }
  render();
  if (v === "learn" && st.authed) setTimeout(() => ui.input?.focus(), 0);
}

// ----------------------------------------------------------- enter/leave ---

async function enter({ push = true, view = "learn" } = {}) {
  st.on = true;
  document.body.classList.add("studying");
  els.btn.setAttribute("aria-selected", "true");
  if (push && location.hash !== `#/${view}`) history.pushState(null, "", `#/${view}`);
  st.view = view;
  if (view === "time") loadTime();
  render();
  if (st.authed) {
    try { await refresh(); } catch (e) { st.msg = e.message; }
    if (generating() && !st.poll) startPoll();
    render();
    if (st.view === "learn") ui.input?.focus();
  }
}

function leave({ keepHash = false } = {}) {
  st.on = false;
  st.editing = null;
  document.body.classList.remove("studying");
  els.btn.setAttribute("aria-selected", "false");
  els.mode.classList.remove("study");
  if (!keepHash && /^#\/(learn|time|study)/.test(location.hash)) history.pushState(null, "", location.pathname);
  window.learnApp?.renderChrome();
}

window.learnStudy = {
  leave: () => { if (st.on) leave(); },
  track, ask,
  refresh: async () => { if (!st.authed) return; try { await refresh(); } catch {} renderLearn(); window.learnApp?.renderChrome(); },
  // For the file viewer: the explainer at "tab/path" and its branch links.
  lessonAt: (rel) => {
    const l = (st.data?.explainers ?? []).find((x) => x.path === rel);
    if (!l) return null;
    return { lesson: l, parent: l.parentId ? byId(l.parentId) : null, children: (l.children ?? []).map(byId).filter(Boolean), histories: (l.histories ?? []).map(byId).filter(Boolean) };
  },
  history: (rel, stuck) => historyLesson(rel, stuck),
  backUp: (l) => backUp(l),
};

// ------------------------------------------------------------------ keys ---

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const typing = document.activeElement?.closest?.("input, textarea, select");
  if (!st.on) {
    if (e.key === "a" && !typing && !els.btn.hidden && $("help").hidden) { e.preventDefault(); enter(); }
    return;
  }
  if (typing) {
    if (e.key === "Escape") { document.activeElement.blur(); e.preventDefault(); }
    return;
  }
  if (!$("help").hidden) return; // app.js closes help
  const list = explainers();
  const cur = list[st.sel];
  const learn = st.authed && st.view === "learn";
  let handled = true;
  if (learn && st.branch && /^[ys1-3]$/.test(e.key)) {
    e.preventDefault();
    if (e.key === "y") answer(0); else if (e.key === "s") answer("skip"); else if (st.branch.prereqs[Number(e.key) - 1]) answer(Number(e.key) - 1);
    return;
  }
  switch (e.key) {
    case "b": if (learn && cur?.parentId) backUp(cur); else handled = false; break;
    case "a": case "Escape": if (st.branch && e.key === "Escape") { st.branch = null; renderLearn(); renderChrome(); } else leave(); break;
    case "?": $("help").hidden = false; break;
    case "t": if (st.authed) setView(st.view === "time" ? "learn" : "time"); break;
    case "w": if (st.view === "time") { st.chart = st.chart === "topic" ? "week" : "topic"; renderTime(); } else handled = false; break;
    case "/": case "i": if (learn) ui.input.focus(); else handled = false; break;
    case "j": case "ArrowDown": if (learn) { st.sel = Math.min(list.length - 1, st.sel + 1); renderList(); renderTrail(); } else els.view.scrollBy({ top: 80 }); break;
    case "k": case "ArrowUp": if (learn) { st.sel = Math.max(0, st.sel - 1); renderList(); renderTrail(); } else els.view.scrollBy({ top: -80 }); break;
    case "Enter": case "o": case "l": if (learn && cur) { if (cur.status === "waiting") writeWaiting(cur); else open(cur); } else handled = false; break;
    case "e": if (learn && cur) { st.editing = cur.id; renderList(); } else handled = false; break;
    case "c": if (learn && cur) chatAbout(cur); else handled = false; break;
    case "h": if (learn && cur?.status === "ready" && cur.path) historyLesson(cur.path); else handled = false; break;
    case "x": location.href = "/explore/"; break;
    default:
      if (/^[1-9]$/.test(e.key)) { leave(); window.learnApp?.setTab(Number(e.key) - 1); } else handled = false;
  }
  if (handled) e.preventDefault();
});

els.btn.addEventListener("click", () => (st.on ? leave() : enter()));
const hashView = () => (location.hash.startsWith("#/time") ? "time" : /^#\/(learn|study)/.test(location.hash) ? "learn" : null);
window.addEventListener("popstate", () => {
  const v = hashView();
  if (v) { if (!st.on) enter({ push: false, view: v }); else setView(v); } else if (st.on) leave({ keepHash: true });
});

// ------------------------------------------------------------------ boot ---

(async function boot() {
  try {
    const res = await fetch("/api/status", { credentials: "same-origin" });
    if (!res.ok) return; // no backend behind this origin: learn mode stays hidden
    const s = await res.json();
    if (!s.ok) return;
    st.authed = s.authed;
  } catch { return; }
  els.btn.hidden = false;
  document.body.classList.add("has-study");
  window.learnApp?.renderChrome();
  const v = hashView();
  if (v) enter({ push: false, view: v });
  else if (st.authed) { try { await refresh(); window.learnApp?.renderChrome(); } catch {} }
})();
