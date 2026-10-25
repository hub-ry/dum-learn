// The command box: one line, opened with ":" or "/",
// where plain English organizes files ("make a folder concurrency", "move
// the mutex explainer into it", "open my mutex notes", "what have I got on
// hashing") or asks for an explainer. Talks to /api/command; the server
// validates every action. AI text is only ever inserted with textContent.

const cmd = { busy: false, last: null, pending: null, results: [], open: false, hist: [], histAt: -1 };
const $c = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}

const ui = {};
function build() {
  ui.out = el("div", { class: "cmd-out", "aria-live": "polite" });
  ui.input = el("input", { id: "cmd-input", type: "text", autocomplete: "off", spellcheck: "false", maxlength: "1000",
    placeholder: "open, find, move, rename, make or delete folders, or ask anything", "aria-label": "command" });
  ui.state = el("span", { class: "cmd-state muted small" });
  ui.form = el("form", { class: "cmd-line", onsubmit: (e) => { e.preventDefault(); submit(); } },
    el("span", { class: "cmd-prompt", "aria-hidden": "true" }, ":"), ui.input, ui.state);
  ui.hint = el("div", { class: "cmd-hint muted small" }, "enter run · esc close · \u2191 history · try \u201cmake a folder concurrency\u201d, \u201cwhat have I got on hashing\u201d");
  ui.root = el("div", { id: "cmd", class: "cmd", hidden: true, role: "dialog", "aria-label": "command" }, el("div", { class: "cmd-card" }, ui.out, ui.form, ui.hint));
  document.body.append(ui.root);
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowUp" && cmd.hist.length) { e.preventDefault(); cmd.histAt = Math.min(cmd.hist.length - 1, cmd.histAt + 1); ui.input.value = cmd.hist[cmd.histAt]; }
    else if (e.key === "ArrowDown" && cmd.histAt >= 0) { e.preventDefault(); cmd.histAt--; ui.input.value = cmd.histAt >= 0 ? cmd.hist[cmd.histAt] : ""; }
    e.stopPropagation();
  });
}

function show(focus = true) {
  if (!ui.root) build();
  ui.root.hidden = false;
  cmd.open = true;
  document.body.classList.add("cmd-open");
  if (focus) setTimeout(() => ui.input.focus(), 0);
}
function close() {
  if (!ui.root) return;
  ui.root.hidden = true;
  cmd.open = false;
  document.body.classList.remove("cmd-open");
  ui.input.blur();
}

async function post(url, body) {
  const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401) throw new Error("unlock first: press a and enter the passcode");
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function busy(on, text = "thinking\u2026") {
  cmd.busy = on;
  if (!ui.root) build();
  ui.state.textContent = on ? text : "";
  ui.input.disabled = on;
  ui.root.classList.toggle("busy", on);
}

const button = (key, label, fn, cls = "") => el("button", { type: "button", class: `act ${cls}`, onclick: fn }, key ? el("b", {}, key) : null, key ? " " : "", label);

function render(r, text) {
  const out = [];
  if (text) out.push(el("div", { class: "cmd-echo muted small" }, `: ${text}`));
  if (r.reply) out.push(el("p", { class: "cmd-reply" }, r.reply));
  for (const l of r.lines ?? []) out.push(el("div", { class: "cmd-ok" }, "\u2713 ", l));
  for (const l of r.errors ?? []) out.push(el("div", { class: "cmd-err" }, "\u2717 ", l));
  if (r.results?.length) {
    out.push(el("ol", { class: "cmd-results" }, r.results.map((x, i) => el("li", {},
      el("button", { type: "button", class: "linkish", onclick: () => openResult(i) }, el("b", {}, String(i + 1)), " ", x.title, " ", el("span", { class: "muted small" }, x.rel))))));
  }
  if (r.open) out.push(el("div", { class: "cmd-ok" }, "\u2192 opened ", r.open.title));
  if (r.lesson) out.push(el("div", { class: "cmd-ok" }, "\u2192 writing \u201c", r.lesson.title, "\u201d", r.lesson.folder ? ` into ${r.lesson.folder}/` : ""));
  if (r.branch) out.push(el("div", { class: "cmd-ok" }, "\u2192 a question about prerequisites is waiting in the learn view"));
  const acts = [];
  if (r.pending) {
    out.push(el("p", { class: "cmd-confirm" }, r.pending.text));
    acts.push(button("y", "yes, do it", confirm, "danger"), button("n", "cancel", cancel));
  }
  if (r.undo) acts.push(button("u", "undo", undo));
  if (acts.length) out.push(el("div", { class: "row" }, acts));
  ui.out.replaceChildren(...out);
}

// Apply what came back: refresh the tree, open things, hand explainers and
// prereq questions to the learn view.
async function apply(r) {
  cmd.last = r;
  cmd.pending = r.pending ?? null;
  cmd.results = r.results ?? [];
  if (r.changed) {
    await window.learnApp?.reload({ moves: r.moves ?? [] });
    window.learnStudy?.refresh?.();
  }
  if (r.open) { close(); window.learnApp?.openPath(r.open.tab, r.open.path); }
  else if (r.chat) { location.href = `/explore/?file=${encodeURIComponent(r.chat.file)}${r.chat.question ? `&q=${encodeURIComponent(r.chat.question)}` : ""}`; }
  else if (r.branch) { window.learnStudy?.ask(r.branch); }
  else if (r.lesson) { window.learnStudy?.track(r.lesson); }
}

async function send(url, body, text, { quiet = false } = {}) {
  busy(true, url === "/api/command" ? "thinking\u2026" : "working\u2026");
  try {
    const r = await post(url, body);
    // From the learn prompt, a plain explainer or prereq question needs no card.
    const onlyLearn = quiet && (r.lesson || r.branch) && !r.lines?.length && !r.errors?.length && !r.results?.length && !r.pending && !r.open;
    if (!onlyLearn) { show(false); render(r, text); }
    await apply(r);
    return r;
  } catch (e) {
    show(false);
    render({ errors: [e.message] }, text);
    throw e;
  } finally {
    busy(false);
    // With something to answer (confirm, undo, results) the keys y/n/u/1-9
    // act on the card; typing anything else goes back into the input.
    if (cmd.open && !ui.root.hidden && !ui.input.disabled) {
      if (cmd.pending || cmd.results.length || cmd.last?.undo) ui.input.blur();
      else ui.input.focus();
    }
  }
}

async function run(text, opts = {}) {
  text = String(text ?? "").trim();
  if (!text || cmd.busy) return null;
  cmd.hist = [text, ...cmd.hist.filter((x) => x !== text)].slice(0, 30);
  cmd.histAt = -1;
  // Short answers to the card on screen.
  if (cmd.pending && /^(y|yes)$/i.test(text)) return confirm();
  if (cmd.pending && /^(n|no|cancel)$/i.test(text)) return cancel();
  if (/^\d$/.test(text) && cmd.results[Number(text) - 1]) return openResult(Number(text) - 1);
  return send("/api/command", { text, open: window.learnApp?.openKey?.() ?? null }, text, opts);
}

function submit() {
  const text = ui.input.value;
  ui.input.value = "";
  run(text).catch(() => {});
}
const confirm = () => { const p = cmd.pending; cmd.pending = null; return p && send("/api/command/confirm", { token: p.token }, "yes").catch(() => {}); };
const cancel = () => { const p = cmd.pending; cmd.pending = null; return p && send("/api/command/cancel", { token: p.token }, "no").catch(() => {}); };
const undo = () => send("/api/command/undo", { id: cmd.last?.undo ?? null }, "undo").catch(() => {});
function openResult(i) {
  const x = cmd.results[i];
  if (!x) return;
  close();
  window.learnApp?.openPath(x.tab, x.path);
}

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!document.body.classList.contains("has-study")) return;
  const typing = document.activeElement?.closest?.("input, textarea, select");
  if (typing || !$c("help")?.hidden) return;
  if (cmd.open && !ui.input.disabled) {
    // Card shortcuts while the box is open but not focused.
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    if (cmd.pending && e.key === "y") { e.preventDefault(); e.stopImmediatePropagation(); confirm(); return; }
    if (cmd.pending && e.key === "n") { e.preventDefault(); e.stopImmediatePropagation(); cancel(); return; }
    if (cmd.last?.undo && e.key === "u") { e.preventDefault(); e.stopImmediatePropagation(); undo(); return; }
    if (/^[1-9]$/.test(e.key) && cmd.results[Number(e.key) - 1]) { e.preventDefault(); e.stopImmediatePropagation(); openResult(Number(e.key) - 1); return; }
    if (e.key.length === 1 && e.key !== ":" && e.key !== " ") { e.stopImmediatePropagation(); ui.input.focus(); return; }
  }
  const studying = document.body.classList.contains("studying");
  if (e.key === ":" || (e.key === "/" && !studying)) { e.preventDefault(); e.stopImmediatePropagation(); show(); }
}, true);

$c("cmd-btn")?.addEventListener("click", () => (cmd.open ? close() : show()));
window.learnCommand = { run, show, close };
