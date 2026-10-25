// Side chat: a collapsible panel next to the PDF/file viewer. The open file is
// pinned as context automatically (its last chat resumes), and each question
// carries the page you're on and any text you selected in the PDF.
// c toggles it, the divider resizes it (both remembered), esc in the box
// returns focus to the document without closing. Narrow screens: bottom sheet.
import { h, markdown, copyText } from "/explore/render.js";

const $ = (id) => document.getElementById(id);
const K_OPEN = "learn.sidechat.open", K_W = "learn.sidechat.w";
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const ui = {
  split: $("view-split"), panel: $("sidechat"), divider: $("sc-divider"), handle: $("sc-handle"),
  title: $("sc-title"), msgs: $("sc-msgs"), scroll: $("sc-scroll"), form: $("sc-form"), input: $("sc-input"),
  send: $("sc-send"), stop: $("sc-stop"), where: $("sc-where"), status: $("sc-status"), gate: $("sc-login"), gateMsg: $("sc-gate-msg"),
  pass: $("sc-pass"), close: $("sc-close"), fresh: $("sc-new"), btn: $("chat-btn"),
};
const st = {
  open: store.get(K_OPEN) === "1", authed: false, ai: false, checked: false,
  file: null, chat: null, loading: null, stream: null, sel: null, drafts: new Map(), err: "",
  scope: null, // { n, title, file }: c on a page written this session (infinite learn)
  note: "", // a calm note from the server (e.g. the session page cap)
};
const narrow = matchMedia("(max-width: 760px)");

// ---------------------------------------------------------------- layout ---
function clampWidth(w) {
  const max = Math.max(280, Math.min(900, (ui.split.clientWidth || innerWidth) * 0.7));
  return Math.round(Math.max(260, Math.min(max, w)));
}
function applyWidth() {
  const w = Number(store.get(K_W)) || 420;
  ui.split.style.setProperty("--sc-w", `${clampWidth(w)}px`);
}
function render() {
  const can = document.body.classList.contains("has-study");
  const on = can && st.open;
  document.body.classList.toggle("sc-open", on);
  ui.panel.hidden = !on;
  ui.divider.hidden = !on;
  ui.handle.hidden = !can || on;
  if (ui.btn) {
    ui.btn.hidden = !can;
    ui.btn.setAttribute("aria-expanded", String(on));
    ui.btn.querySelector(".lbl").textContent = on ? "hide chat" : "chat";
  }
  if (on) applyWidth();
}
function setOpen(open, { focus = true } = {}) {
  st.open = open;
  store.set(K_OPEN, open ? "1" : "0");
  render();
  window.learnApp?.renderChrome?.();
  if (open) { sync().then(() => { if (focus && !ui.input.disabled) ui.input.focus(); }); }
  else if (document.activeElement && ui.panel.contains(document.activeElement)) backToDoc();
}
function backToDoc() {
  document.activeElement?.blur?.();
  window.learnApp?.focusView?.();
}

ui.divider.addEventListener("pointerdown", (e) => {
  if (narrow.matches) return;
  e.preventDefault();
  ui.divider.setPointerCapture(e.pointerId);
  document.body.classList.add("sc-dragging");
  const right = ui.split.getBoundingClientRect().right;
  const move = (ev) => ui.split.style.setProperty("--sc-w", `${clampWidth(right - ev.clientX)}px`);
  const up = () => {
    ui.divider.removeEventListener("pointermove", move);
    document.body.classList.remove("sc-dragging");
    store.set(K_W, String(parseInt(getComputedStyle(ui.split).getPropertyValue("--sc-w"), 10) || 420));
  };
  ui.divider.addEventListener("pointermove", move);
  ui.divider.addEventListener("pointerup", up, { once: true });
  ui.divider.addEventListener("pointercancel", up, { once: true });
});
ui.divider.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault(); e.stopPropagation();
  const cur = parseInt(getComputedStyle(ui.split).getPropertyValue("--sc-w"), 10) || 420;
  const w = clampWidth(cur + (e.key === "ArrowLeft" ? 40 : -40));
  ui.split.style.setProperty("--sc-w", `${w}px`);
  store.set(K_W, String(w));
});
addEventListener("resize", () => st.open && applyWidth());

// ------------------------------------------------------------------- api ---
async function api(method, url, body) {
  const r = await fetch(url, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (r.status === 401 && url !== "/api/login") { st.authed = false; }
  if (!r.ok) { const e = new Error(data.error || `request failed (${r.status})`); e.status = r.status; throw e; }
  return data;
}

// Load (or resume) the chat pinned to the open file.
async function sync() {
  if (!st.open) return;
  if (!st.checked) {
    try { const s = await api("GET", "/api/status"); st.authed = s.authed; st.ai = s.ai; st.checked = true; }
    catch (e) { st.err = e.message; paint(); return; }
  }
  const file = window.learnApp?.openKey?.() ?? null;
  if (!st.authed) { st.file = file; st.chat = null; paint(); return; }
  if (file === st.file && (st.chat || st.loading)) { paint(); return st.loading ?? undefined; }
  if (st.stream) return; // never switch away mid-reply
  if (st.file) st.drafts.set(st.file, ui.input.value);
  st.file = file; st.chat = null; st.err = ""; st.sel = null; st.scope = null; st.note = "";
  ui.input.value = st.drafts.get(file) ?? "";
  if (!file) { paint(); return; }
  const token = (st.token = (st.token ?? 0) + 1);
  paint();
  st.loading = (async () => {
    try {
      const { chat } = await api("POST", "/api/chats", { file });
      if (token === st.token) st.chat = chat;
    } catch (e) {
      if (token === st.token) st.err = e.status === 400 ? "chat isn't available for this kind of file" : e.message;
    } finally { if (token === st.token) st.loading = null; paint(); }
  })();
  return st.loading;
}
async function fresh() {
  if (!st.file || st.stream || !st.authed) return;
  try { st.chat = (await api("POST", "/api/chats", { file: st.file, fresh: true })).chat; st.err = ""; st.scope = null; st.note = ""; window.learnInfinite?.reload?.(); }
  catch (e) { st.err = e.message; }
  paint(); ui.input.focus();
}

// ---------------------------------------------------------------- render ---
function messageNode(m) {
  const assistant = m.role === "assistant";
  const body = h("div", { class: "message-body" });
  if (assistant) body.append(...markdown(m.content || ""));
  else body.append(h("p", { class: "plain-message" }, m.content || ""));
  const where = !assistant && m.where ? h("div", { class: "sc-msg-where" },
    [m.where.scope ? `follow-up on \u201C${m.where.sectionTitle ?? "that page"}\u201D` : m.where.section ? `\u00A7 ${m.where.sectionTitle ?? m.where.section}` : m.where.page ? `p.${m.where.page}` : null, m.where.selection ? `“${m.where.selection.slice(0, 90)}${m.where.selection.length > 90 ? "…" : ""}”` : null].filter(Boolean).join(" · ")) : null;
  const node = h("article", { class: `message ${assistant ? "assistant" : "user"}${m.page ? " page-msg" : ""}` }, where, body);
  if (m.page) {
    const go = h("button", { type: "button", class: "quiet sc-page-link", title: "Scroll to this page below the PDF" }, "show page \u2193");
    go.addEventListener("click", () => { if (!window.learnInfinite?.goto(m.page.n)) { st.note = "that page isn't shown here (it lives in its session document)"; paint(); } else backToDoc(); });
    node.append(h("div", { class: "message-actions" }, go));
  }
  if (m.stopped) node.append(h("p", { class: "message-stopped" }, "reply stopped"));
  if (assistant && m.content) {
    const copy = h("button", { type: "button", class: "quiet" }, "copy");
    copy.addEventListener("click", () => copyText(m.content, copy));
    node.append(h("div", { class: "message-actions" }, copy));
  }
  return node;
}
function paint() {
  const authed = st.authed;
  ui.gate.hidden = authed || !st.checked;
  ui.form.hidden = !authed;
  ui.fresh.hidden = !authed || !st.chat;
  const label = st.file ? st.file.split("/").pop().replace(/\.tex$/, "") : null;
  ui.title.textContent = st.chat ? st.chat.title.replace(/^About: /, "") : label ?? "chat";
  ui.title.title = st.file ?? "";
  const msgs = st.chat?.messages ?? [];
  if (!st.stream) {
    ui.msgs.replaceChildren(...msgs.map(messageNode));
    if (!msgs.length) ui.msgs.append(h("p", { class: "sc-empty" },
      !authed ? "" : !st.file ? "Open a file and ask about it here." : st.loading ? "loading…"
        : st.chat ? "Ask anything about this file while you read. It's pinned as context; the page you're on and any text you select go with each question." : ""));
    ui.scroll.scrollTop = ui.scroll.scrollHeight;
  }
  const busy = Boolean(st.stream);
  ui.input.disabled = !authed || !st.chat || (busy && !st.stream?.accepted);
  ui.send.hidden = busy; ui.stop.hidden = !busy;
  ui.send.disabled = !st.ai || !st.chat || !ui.input.value.trim();
  paintWhere();
  ui.status.textContent = st.err || (busy ? "replying…" : authed && !st.ai ? "AI isn't configured on the server" : st.note);
  ui.status.classList.toggle("error", Boolean(st.err));
  ui.gateMsg.textContent = authed ? "" : st.err;
}
function where() {
  const info = window.learnApp?.pageInfo?.();
  const w = {};
  // Pages written this session (appended, or inside the saved session doc)
  // are named by section; the PDF's own pages by number.
  if (info?.sec) { w.section = info.sec; if (info.secTitle) w.sectionTitle = info.secTitle; }
  else if (info?.pages && info.page <= info.pages) { w.page = info.page; w.pages = info.pages; }
  if (st.scope && st.scope.file === st.file) { w.section = st.scope.n; w.sectionTitle = st.scope.title; w.scope = true; delete w.page; delete w.pages; }
  if (st.sel?.text && st.sel.file === st.file) {
    w.selection = st.sel.text;
    if (st.sel.page && !w.section && (!info?.pages || st.sel.page <= info.pages)) w.page = st.sel.page;
  }
  if (window.learnInfinite?.view?.() === "doc") w.view = "doc";
  return Object.keys(w).filter((k) => k !== "view").length ? w : null;
}
function paintWhere() {
  const w = where();
  ui.where.replaceChildren();
  if (!w || !st.chat) { ui.where.hidden = true; return; }
  ui.where.hidden = false;
  if (w.scope) ui.where.append(h("span", { class: "sc-scope" }, `follow-up on \u201C${w.sectionTitle ?? "this page"}\u201D`,
    h("button", { type: "button", class: "quiet", title: "ask without scoping to that page", onclick: () => { st.scope = null; paintWhere(); } }, "\u00D7")));
  else if (w.section) ui.where.append(h("span", {}, `\u00A7 ${w.sectionTitle ?? w.section}`));
  else if (w.page) ui.where.append(h("span", {}, `page ${w.page}${w.pages ? `/${w.pages}` : ""}`));
  if (w.selection) ui.where.append(h("span", { class: "sc-sel" }, `“${w.selection.slice(0, 80)}${w.selection.length > 80 ? "…" : ""}”`,
    h("button", { type: "button", class: "quiet", title: "don't send the selection", onclick: () => { st.sel = null; paintWhere(); } }, "×")));
}

// Remember the last text selected inside the viewer (focusing the chat box
// would otherwise lose it).
document.addEventListener("selectionchange", () => {
  const s = getSelection();
  if (!s || !s.rangeCount) return;
  const node = s.anchorNode?.nodeType === 1 ? s.anchorNode : s.anchorNode?.parentElement;
  const viewer = $("viewer");
  if (!node || !viewer.contains(node)) return;
  const text = s.toString().replace(/\s+/g, " ").trim();
  if (text) st.sel = { text: text.slice(0, 1500), page: Number(node.closest?.(".page")?.dataset.n) || null, file: window.learnApp?.openKey?.() };
  else st.sel = null;
  if (st.open) paintWhere();
});
document.addEventListener("learn:page", () => st.open && paintWhere());

// ------------------------------------------------------------------ send ---
async function sendMessage(text) {
  const content = (text ?? ui.input.value).trim();
  if (!content || st.stream || !st.chat || !st.ai) return;
  const chat = st.chat, original = ui.input.value;
  const stream = { controller: new AbortController(), accepted: false, done: false, stopping: false };
  st.stream = stream; st.err = ""; st.note = "";
  paint();
  let reply = "", body = null, frame = null;
  const draw = () => {
    if (!body) return;
    const stick = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 120;
    body.replaceChildren(...markdown(reply));
    if (stick) ui.scroll.scrollTop = ui.scroll.scrollHeight;
  };
  try {
    const r = await fetch(`/api/chats/${encodeURIComponent(chat.id)}/messages`, {
      method: "POST", credentials: "same-origin", signal: stream.controller.signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ content, where: where(), infinite: Boolean(window.learnInfinite?.active?.()) }),
    });
    if (!r.ok) {
      let d = {}; try { d = await r.json(); } catch {}
      if (r.status === 401) { st.authed = false; }
      throw new Error(d.error || `couldn't send (${r.status})`);
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    const dispatch = (block) => {
      const lines = block.split(/\r?\n/);
      const ev = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() || "message";
      const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) return;
      const d = JSON.parse(data);
      if (ev === "start") {
        stream.accepted = true;
        chat.messages.push(d.userMessage);
        ui.input.value = ""; st.drafts.set(st.file, ""); st.sel = null; st.scope = null; grow();
        ui.msgs.replaceChildren(...chat.messages.map(messageNode));
        body = h("div", { class: "message-body streaming" });
        ui.msgs.append(h("article", { class: "message assistant" }, body));
        ui.scroll.scrollTop = ui.scroll.scrollHeight;
        paint();
      } else if (ev === "delta") {
        reply += d.t || "";
        if (frame === null) frame = requestAnimationFrame(() => { frame = null; draw(); });
      } else if (ev === "page") {
        window.learnInfinite?.onPage?.(d.session, d.n);
      } else if (ev === "done") {
        stream.done = true;
        if (d.chat && st.chat?.id === d.chat.id) st.chat = d.chat;
        if (d.note) st.note = d.note;
      } else if (ev === "error") throw new Error(d.error || "the reply couldn't finish");
    };
    for (;;) {
      const { value, done } = await reader.read();
      buf += dec.decode(value, { stream: !done });
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) { dispatch(buf.slice(0, m.index)); buf = buf.slice(m.index + m[0].length); }
      if (done) break;
    }
    if (buf.trim()) dispatch(buf);
    if (!stream.done) throw new Error("the connection closed before the reply finished");
  } catch (e) {
    stream.controller.abort();
    if (!stream.stopping) {
      st.err = e.message || "couldn't connect";
      if (!stream.accepted) ui.input.value = original;
    }
  } finally {
    if (frame !== null) cancelAnimationFrame(frame);
    if (!stream.done && st.authed) {
      // The server keeps partial replies; reload instead of resending.
      try { const { chat: c } = await api("GET", `/api/chats/${encodeURIComponent(chat.id)}`); if (st.chat?.id === c.id) st.chat = c; } catch {}
    }
    st.stream = null;
    paint();
    if (st.open && !narrow.matches) ui.input.focus();
  }
}
function grow() {
  ui.input.style.height = "auto";
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, 180)}px`;
}

ui.form.addEventListener("submit", (e) => { e.preventDefault(); sendMessage(); });
ui.input.addEventListener("input", () => { if (st.file) st.drafts.set(st.file, ui.input.value); grow(); ui.send.disabled = !st.ai || !st.chat || !ui.input.value.trim(); });
ui.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); backToDoc(); }
});
ui.panel.addEventListener("keydown", (e) => {
  // Keys typed anywhere in the panel never reach the viewer shortcuts.
  if (e.key === "Escape" && e.target !== ui.input) { e.preventDefault(); backToDoc(); }
  e.stopPropagation();
});
ui.stop.addEventListener("click", () => { if (st.stream) { st.stream.stopping = true; st.stream.controller.abort(); } });
ui.close.addEventListener("click", () => setOpen(false));
ui.handle.addEventListener("click", () => setOpen(true));
ui.btn?.addEventListener("click", () => setOpen(!st.open));
ui.fresh.addEventListener("click", fresh);
$("sc-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("POST", "/api/login", { passcode: ui.pass.value });
    ui.pass.value = ""; st.authed = true; st.file = null; st.err = "";
    window.learnStudy?.refresh?.();
    await sync(); ui.input.focus();
  } catch (err) { st.err = err.message; paint(); }
});
document.addEventListener("learn:open", () => sync());
narrow.addEventListener?.("change", render);

window.learnSide = {
  isOpen: () => st.open && document.body.classList.contains("has-study"),
  toggle: () => setOpen(!st.open),
  // c: on a page written this session, open the chat scoped to it (the
  // answer becomes another page); otherwise toggle the chat.
  async cKey() {
    const info = window.learnApp?.pageInfo?.();
    if (!info?.sec || !window.learnInfinite?.on?.()) return setOpen(!st.open);
    if (st.open && st.scope?.n === info.sec) { st.scope = null; return setOpen(false); }
    setOpen(true, { focus: false });
    await sync();
    if (st.loading) await st.loading;
    st.scope = { n: info.sec, title: info.secTitle, file: window.learnApp.openKey() };
    paintWhere();
    if (!ui.input.disabled) ui.input.focus();
  },
  // A chat changed elsewhere (a "continue" page added a message).
  refresh(chat) { if (chat && st.chat?.id === chat.id && !st.stream) { st.chat = chat; paint(); } },
  open: (opts) => setOpen(true, opts),
  close: () => setOpen(false),
  // From the command box ("ask the mutex notes why ...") or the learn list.
  async ask(question) {
    setOpen(true, { focus: false });
    await sync();
    if (st.loading) await st.loading;
    if (question && st.chat && st.ai) sendMessage(question);
    else ui.input.focus();
  },
  render,
};
// Learn mode boot (study.js) adds has-study once the backend answers.
let hadStudy = document.body.classList.contains("has-study");
new MutationObserver(() => {
  const has = document.body.classList.contains("has-study");
  if (has === hadStudy) return;
  hadStudy = has; render(); if (st.open) sync();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });
render();
