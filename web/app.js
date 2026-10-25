import * as pdfjs from "/vendor/pdf.min.mjs";
import hljs from "/vendor/hljs/core.min.js";

pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const els = {
  tabs: $("tabs"), list: $("list"), listPane: $("list-pane"), listTitle: $("list-title"),
  viewPane: $("view-pane"), viewTitle: $("view-title"), viewer: $("viewer"),
  mode: $("mode"), status: $("status"), hints: $("hints"), help: $("help"),
};

const MAX_FIT_WIDTH = 920; // CSS px: "fit width" stops growing past this on wide screens
const ZOOM_STEP = 1.15;
const SCROLL_STEP = 80;

const state = {
  tabs: [],
  tab: 0,
  sel: 0,
  focus: "list",
  open: null, // the item shown in the viewer
  showSource: false,
  zoom: 1, // multiplier on fit-width
  invert: localStorage.getItem("learn.invert") !== "0",
  collapsed: new Set((() => { try { return JSON.parse(localStorage.getItem("learn.collapsed") ?? "[]"); } catch { return []; } })()),
  doc: null,
  pages: [], // { proxy, el, canvas, links, rendered, task, doc?, sec?, secTitle?, appx? }
  page: 1,
  loadToken: 0,
  basePages: 0, // pages of the open PDF itself; the rest are infinite-learn pages
  pendingPage: null, // from a "#/tab/path?page=N" link
};
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
state.ready = deferred();
// Infinite learn (web/infinite.js): section PDFs appended below the open PDF.
const appx = { keys: [], docs: [], tail: null, queue: Promise.resolve() };

const items = () => state.tabs[state.tab]?.items ?? [];

// ---------------------------------------------------------------- render ---

function renderTabs() {
  els.tabs.replaceChildren(...state.tabs.map((tab, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(i === state.tab));
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = i < 9 ? `${i + 1}:` : "";
    b.append(num, tab.name);
    b.addEventListener("click", () => setTab(i));
    return b;
  }));
}

const ICON = { pdf: "\u25A4", code: "\u276F", file: "\u2193" };

// The file list is a folder tree: files of a folder first, then its
// subfolders (collapsible, remembered in localStorage). state.sel indexes the
// visible rows.
function rows() {
  const tab = state.tabs[state.tab];
  if (!tab) return [];
  const folders = new Set(tab.folders ?? []);
  for (const it of tab.items) for (let g = it.group; g; g = g.includes("/") ? g.slice(0, g.lastIndexOf("/")) : "") folders.add(g);
  const kids = new Map(), filesIn = new Map();
  const push = (m, k, v) => (m.get(k) ?? m.set(k, []).get(k)).push(v);
  for (const f of folders) push(kids, f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "", f);
  for (const it of tab.items) push(filesIn, it.group, it);
  const count = (f) => (filesIn.get(f)?.length ?? 0) + (kids.get(f) ?? []).reduce((n, k) => n + count(k), 0);
  const out = [];
  const walk = (dir, depth) => {
    for (const item of filesIn.get(dir) ?? []) out.push({ type: "file", item, depth });
    for (const f of (kids.get(dir) ?? []).sort((a, b) => a.localeCompare(b))) {
      const open = !state.collapsed.has(`${tab.name}/${f}`);
      out.push({ type: "dir", path: f, name: f.split("/").pop(), depth, open, count: count(f) });
      if (open) walk(f, depth + 1);
    }
  };
  walk("", 0);
  return out;
}
function saveCollapsed() { try { localStorage.setItem("learn.collapsed", JSON.stringify([...state.collapsed])); } catch {} }
function setDirOpen(dirPath, open) {
  const key = `${state.tabs[state.tab]?.name}/${dirPath}`;
  if (open) state.collapsed.delete(key); else state.collapsed.add(key);
  saveCollapsed();
  const idx = rows().findIndex((r) => r.type === "dir" && r.path === dirPath);
  if (idx >= 0) state.sel = idx;
  renderList();
}
// Select a file's row, opening the folders above it.
function selectItem(item) {
  const tab = state.tabs[state.tab]?.name;
  for (let g = item.group; g; g = g.includes("/") ? g.slice(0, g.lastIndexOf("/")) : "") state.collapsed.delete(`${tab}/${g}`);
  saveCollapsed();
  state.sel = Math.max(0, rows().findIndex((r) => r.item === item));
}

function renderList() {
  const list = items();
  const visible = rows();
  els.listTitle.textContent = `${state.tabs[state.tab]?.name ?? "files"} (${list.length})`;
  state.sel = Math.min(state.sel, Math.max(0, visible.length - 1));
  const out = visible.map((r, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.index = String(i);
    li.style.setProperty("--depth", String(r.depth));
    if (i === state.sel) li.classList.add("selected");
    const icon = document.createElement("span");
    icon.className = "icon";
    const name = document.createElement("span");
    name.className = "name";
    if (r.type === "dir") {
      li.className = "item dir";
      li.setAttribute("aria-expanded", String(r.open));
      icon.textContent = r.open ? "\u25BE" : "\u25B8";
      name.textContent = `${r.name}/`;
      const n = document.createElement("span");
      n.className = "count";
      n.textContent = String(r.count);
      li.title = r.path;
      li.append(icon, name, n);
      li.addEventListener("click", () => { state.sel = i; setDirOpen(r.path, !r.open); });
    } else {
      const item = r.item;
      li.className = "item";
      if (state.open === item) li.classList.add("open");
      icon.textContent = ICON[item.kind] ?? "\u00B7";
      name.textContent = item.title;
      li.title = item.path;
      li.append(icon, name);
      li.addEventListener("click", () => {
        state.sel = i;
        openItem(item);
        setFocus("view");
      });
    }
    if (i === state.sel) li.classList.add("selected");
    return li;
  });
  if (!visible.length) {
    const li = document.createElement("li");
    li.className = "group";
    li.textContent = "nothing here yet";
    out.push(li);
  }
  els.list.replaceChildren(...out);
  els.list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function renderChrome() {
  els.listPane.classList.toggle("focused", state.focus === "list");
  els.viewPane.classList.toggle("focused", state.focus === "view");
  els.mode.textContent = state.focus === "list" ? "LIST" : "VIEW";
  els.mode.classList.toggle("view", state.focus === "view");

  const parts = [];
  const item = state.open;
  if (item) {
    parts.push(`${state.tabs[state.tab]?.name}/${state.showSource ? item.path : item.path.replace(/\.tex$/, ".pdf")}`);
    if (item.kind === "pdf" && !state.showSource && state.pages.length) {
      const cur = state.pages[state.page - 1];
      parts.push(cur?.appx !== undefined ? `page ${state.page}/${state.pages.length} \u00B7 written this session` : `page ${state.page}/${state.pages.length}`, `${Math.round(state.zoom * 100)}%`);
      if (state.invert && document.documentElement.dataset.theme !== "light") parts.push("inv");
    }
  }
  els.status.textContent = parts.join("  \u2502  ");

  const hint = (k, label) => `<b>${k}</b> ${label}`;
  const hints = state.focus === "list"
    ? [hint("j/k", "move"), hint("enter", "open"), hint("1-9", "tab"), hint("?", "help")]
    : [hint("j/k", "scroll"), hint("n/p", "page"), hint("+/-", "zoom"), ...(document.documentElement.dataset.theme === "light" ? [] : [hint("i", "invert")]), ...(document.body.classList.contains("has-study") ? [hint("c", window.learnSide?.isOpen() ? "hide chat" : "chat"), hint("h", "history"), hint("tab", "list")] : [hint("h", "list")]), hint("?", "help")];
  els.hints.innerHTML = hints.join("  ");
  // The side chat (web/sidechat.js) follows the page you're on.
  document.dispatchEvent(new CustomEvent("learn:page"));
  const histBtn = $("hist-btn");
  if (histBtn) histBtn.hidden = !(document.body.classList.contains("has-study") && openKey());
  renderBranchBar();
}

// On an explainer that's part of a prerequisite branch: its trail, its
// prerequisites, and "back up to <parent>" (b).
function renderBranchBar() {
  const bar = $("branch-bar");
  if (!bar) return;
  const info = openKey() ? window.learnStudy?.lessonAt?.(openKey()) : null;
  if (!info || (!info.parent && !info.children.length && !info.histories.length)) { bar.hidden = true; bar.replaceChildren(); return; }
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const parts = [];
  const trail = info.lesson.trail ?? [];
  if (trail.length > 1) {
    const crumbs = mk("span", "crumbs");
    trail.forEach((t, i) => {
      if (i) crumbs.append(mk("span", "sep", " \u203A "));
      crumbs.append(mk("span", i === trail.length - 1 ? "here" : "", t.title));
    });
    parts.push(crumbs);
  }
  if (info.children.length) {
    const kids = mk("span", "muted small", "builds on: ");
    info.children.forEach((c, i) => {
      if (i) kids.append(", ");
      const b = mk("button", "linkish", c.title);
      b.type = "button";
      b.addEventListener("click", () => c.status === "ready" && c.file && window.learnApp.openPath(c.tab, c.file));
      kids.append(b);
    });
    parts.push(kids);
  }
  if (info.histories.length) {
    const hs = mk("span", "muted small", "history: ");
    info.histories.forEach((c, i) => {
      if (i) hs.append(", ");
      const b = mk("button", "linkish", c.title);
      b.type = "button";
      b.addEventListener("click", () => c.status === "ready" && c.file && window.learnApp.openPath(c.tab, c.file));
      hs.append(b);
    });
    parts.push(hs);
  }
  if (info.lesson.kind === "history") parts.push(mk("span", "exp-tag", "experimental history lesson"));
  if (info.parent) {
    const up = mk("button", "act up");
    up.type = "button";
    up.append(mk("b", null, "b"), ` back up to ${info.parent.title}`);
    up.addEventListener("click", () => window.learnStudy.backUp(info.lesson));
    parts.push(up);
  }
  bar.replaceChildren(...parts);
  bar.hidden = false;
}

// ----------------------------------------------------------------- state ---

function setTab(i) {
  if (i < 0 || i >= state.tabs.length) return;
  if (i !== state.tab) {
    state.tab = i;
    state.sel = 0;
  }
  renderTabs();
  renderList();
  renderChrome();
}

function setFocus(focus) {
  state.focus = focus;
  if (focus === "view") els.viewer.focus({ preventScroll: true });
  renderChrome();
}

function moveSel(delta) {
  const n = rows().length;
  if (!n) return;
  state.sel = Math.max(0, Math.min(n - 1, state.sel + delta));
  renderList();
}

function itemHash(item) {
  return `#/${encodeURIComponent(state.tabs[state.tab].name)}/${item.path.split("/").map(encodeURIComponent).join("/")}`;
}

function openItem(item, { fromHash = false } = {}) {
  if (!fromHash && location.hash !== itemHash(item)) {
    history.pushState(null, "", itemHash(item));
  }
  if (state.open === item) return;
  state.open = item;
  state.openTab = state.tabs[state.tab]?.name;
  state.showSource = false;
  if (matchMedia("(max-width: 760px)").matches) document.body.classList.add("list-collapsed");
  renderList();
  showItem();
  document.dispatchEvent(new CustomEvent("learn:open"));
}

function applyHash() {
  const pm = location.hash.match(/[?&]page=(\d{1,4})$/);
  const m = location.hash.replace(/[?&]page=\d{1,4}$/, "").match(/^#\/([^/]+)(?:\/(.+))?$/);
  if (!m) return false;
  const tabName = decodeURIComponent(m[1]);
  const tabIdx = state.tabs.findIndex((t) => t.name === tabName);
  if (tabIdx < 0) return false;
  setTab(tabIdx);
  if (!m[2]) return true;
  const p = m[2].split("/").map(decodeURIComponent).join("/");
  const item = items().find((it) => it.path === p);
  if (!item) return true;
  selectItem(item);
  if (pm) {
    if (state.open === item && state.pages.length) goToPage(Number(pm[1]));
    else state.pendingPage = Number(pm[1]);
  }
  openItem(item, { fromHash: true });
  setFocus("view");
  return true;
}

// ---------------------------------------------------------------- viewer ---

function closeDoc() {
  state.loadToken++;
  for (const p of state.pages) p.task?.cancel();
  observer.disconnect();
  state.pages = [];
  state.doc?.loadingTask.destroy();
  state.doc = null;
  state.page = 1;
  state.basePages = 0;
  for (const d of appx.docs) d?.loadingTask.destroy();
  appx.keys = []; appx.docs = []; appx.tail = null;
  state.ready.resolve(null); // wake anything waiting on the old document
  state.ready = deferred();
}

function notice(text, cls = "notice") {
  const p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  els.viewer.replaceChildren(p);
}

async function showItem() {
  const item = state.open;
  closeDoc();
  els.viewer.scrollTop = 0;
  els.viewTitle.textContent = item.title;
  renderChrome();
  if (item.kind === "pdf" && !state.showSource) return showPdf(item);
  if (item.kind === "code" || (item.kind === "pdf" && state.showSource)) {
    return showCode(state.showSource ? item.source : item.src, item);
  }
  showFile(item);
}

async function showCode(src, item) {
  const token = state.loadToken;
  notice("loading\u2026");
  try {
    const res = await fetch(`/${src}`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (token !== state.loadToken) return;
    const pre = document.createElement("pre");
    pre.className = "code hljs";
    const lang = state.showSource ? "latex" : item.lang;
    const html = await highlight(text.replace(/\n$/, ""), lang);
    if (token !== state.loadToken) return;
    if (html) {
      pre.innerHTML = html;
    } else {
      pre.append(...text.replace(/\n$/, "").split("\n").map((line) => {
        const s = document.createElement("span");
        s.className = "ln";
        s.textContent = line || " ";
        return s;
      }));
    }
    els.viewer.replaceChildren(pre);
    els.viewTitle.textContent = `${item.title}${state.showSource ? " (source)" : ""}`;
  } catch (err) {
    if (token === state.loadToken) notice(`could not load ${src}: ${err.message}`, "notice error");
  }
}

// ------------------------------------------------------------ highlight ---

// Site language names (from build.mjs) -> highlight.js grammar files in /vendor/hljs.
const HLJS_GRAMMAR = {
  python: "python", c: "c", cpp: "cpp", rust: "rust", typescript: "typescript", sql: "sql",
  shell: "bash", java: "java", go: "go", latex: "latex",
};
const grammarLoads = new Map();

function loadGrammar(name) {
  if (!grammarLoads.has(name)) {
    grammarLoads.set(name, import(`/vendor/hljs/languages/${name}.min.js`)
      .then((m) => { hljs.registerLanguage(name, m.default); return true; })
      .catch((err) => { console.error(`hljs ${name}:`, err); return false; }));
  }
  return grammarLoads.get(name);
}

// Highlight `text` and return HTML with one <span class="ln"> per line, or null
// for plain text / unknown languages (the caller then renders plain lines).
// Tokens that span lines (block comments, multi-line strings) are closed at
// each line break and reopened on the next line, so line numbers stay correct.
async function highlight(text, lang) {
  const name = HLJS_GRAMMAR[lang];
  if (!name || !(await loadGrammar(name))) return null;
  let out;
  try {
    out = hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
  } catch (err) {
    console.error("highlight:", err);
    return null;
  }
  const open = []; // opening tags of spans still open at this point
  let line = "";
  const lines = [];
  for (const [, tag, close, chunk] of out.matchAll(/(<span[^>]*>)|(<\/span>)|([^<]+)/g)) {
    if (tag) { open.push(tag); line += tag; continue; }
    if (close) { open.pop(); line += close; continue; }
    const parts = chunk.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) {
        lines.push(line + "</span>".repeat(open.length));
        line = open.join("");
      }
      line += part;
    });
  }
  lines.push(line + "</span>".repeat(open.length));
  return lines.map((l) => `<span class="ln">${l}</span>`).join("");
}

function showFile(item) {
  const card = document.createElement("div");
  card.className = "file-card";
  const a = document.createElement("a");
  a.href = `/${item.src}`;
  a.download = item.path.split("/").pop();
  a.textContent = `download ${a.download}`;
  const meta = document.createElement("p");
  meta.className = "empty";
  meta.textContent = `${formatSize(item.size)} \u00B7 updated ${item.updated.slice(0, 10)}`;
  card.append(a, meta);
  els.viewer.replaceChildren(card);
}

function formatSize(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function showPdf(item) {
  const token = state.loadToken;
  notice("loading\u2026");
  let doc;
  try {
    doc = await pdfjs.getDocument({ url: `/${item.src}`, isEvalSupported: false }).promise;
  } catch (err) {
    if (token === state.loadToken) notice(`could not open PDF: ${err.message}`, "notice error");
    return;
  }
  if (token !== state.loadToken) {
    doc.loadingTask.destroy();
    return;
  }
  state.doc = doc;
  const proxies = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
  if (token !== state.loadToken) return;

  const wrap = document.createElement("div");
  wrap.className = "pages";
  els.viewer.classList.toggle("invert", state.invert);
  state.pages = proxies.map((proxy, i) => {
    const p = makePage(proxy, i + 1);
    wrap.append(p.el);
    return p;
  });
  state.basePages = state.pages.length;
  els.viewer.replaceChildren(wrap);
  layoutPages();
  for (const p of state.pages) observer.observe(p.el);
  if (state.pendingPage) { goToPage(state.pendingPage); state.pendingPage = null; }
  renderChrome();
  state.ready.resolve(state.basePages);
}

function makePage(proxy, n) {
  const el = document.createElement("div");
  el.className = "page";
  el.dataset.n = String(n);
  const canvas = document.createElement("canvas");
  const links = document.createElement("div");
  links.className = "links";
  const pnum = document.createElement("span");
  pnum.className = "pnum";
  pnum.textContent = `${n}`;
  el.append(canvas, links, pnum);
  return { proxy, el, canvas, links, rendered: false, task: null };
}

function sizePage(p) {
  const vp = p.proxy.getViewport({ scale: cssScale(p.proxy) });
  p.el.style.width = `${Math.floor(vp.width)}px`;
  p.el.style.height = `${Math.floor(vp.height)}px`;
  p.task?.cancel();
  p.rendered = false;
}

// Infinite learn: show the session's pages after the open PDF's own pages.
// spec: { sections: [{ key, url, n, title }], tags: [{ from, to, n, title }]
// (pages of the open PDF that already are session pages), tail: { text, kind } | null }.
// Only ever appends (or drops a changed suffix), so reading position is kept.
function setAppendix(spec) {
  const token = state.loadToken;
  const run = appx.queue.then(() => applyAppendix(spec, token));
  appx.queue = run.catch((err) => console.error("appendix:", err));
  return run;
}
async function applyAppendix(spec, token) {
  await state.ready.promise;
  if (token !== state.loadToken || !state.pages.length) return;
  const wrap = els.viewer.querySelector(".pages");
  if (!wrap) return;
  for (let i = 0; i < state.basePages; i++) {
    const p = state.pages[i];
    delete p.sec; delete p.secTitle; delete p.el.dataset.sec;
  }
  for (const t of spec.tags ?? []) {
    for (let i = Math.max(1, t.from); i <= Math.min(t.to, state.basePages); i++) {
      const p = state.pages[i - 1];
      p.sec = t.n; p.secTitle = t.title; p.el.dataset.sec = String(t.n);
    }
  }
  const want = spec.sections ?? [];
  let keep = 0;
  while (keep < appx.keys.length && keep < want.length && appx.keys[keep] === want[keep].key) keep++;
  if (keep < appx.keys.length) {
    for (const p of state.pages.filter((q) => q.appx >= keep)) { p.task?.cancel(); observer.unobserve(p.el); p.el.remove(); }
    state.pages = state.pages.filter((q) => !(q.appx >= keep));
    for (const d of appx.docs.slice(keep)) d?.loadingTask.destroy();
    appx.keys.length = keep; appx.docs.length = keep;
    if (state.page > state.pages.length) state.page = state.pages.length;
  }
  for (const sec of want.slice(keep)) {
    let doc = null, proxies = [];
    try {
      doc = await pdfjs.getDocument({ url: sec.url, isEvalSupported: false }).promise;
      proxies = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
    } catch (err) {
      console.error(`session page ${sec.n}:`, err);
    }
    if (token !== state.loadToken) { doc?.loadingTask.destroy(); return; }
    const idx = appx.keys.length;
    appx.keys.push(sec.key); appx.docs.push(doc);
    for (const proxy of proxies) {
      const p = makePage(proxy, state.pages.length + 1);
      Object.assign(p, { doc, sec: sec.n, secTitle: sec.title, appx: idx });
      p.el.dataset.sec = String(sec.n);
      p.el.classList.add("appended");
      state.pages.push(p);
      wrap.insertBefore(p.el, appx.tail);
      sizePage(p);
      observer.observe(p.el);
      if (isNearView(p.el)) renderPage(p);
    }
  }
  if (spec.tail) {
    if (!appx.tail) { appx.tail = document.createElement("div"); wrap.append(appx.tail); }
    appx.tail.className = `appx-tail ${spec.tail.kind ?? ""}`;
    appx.tail.textContent = spec.tail.text;
  } else if (appx.tail) { appx.tail.remove(); appx.tail = null; }
  renderChrome();
}
function scrollToSection(n) {
  const p = state.pages.find((q) => q.sec === n);
  if (!p) return false;
  els.viewer.scrollTop = pageTop(p.el) - 8;
  updateCurrentPage();
  return true;
}

function cssScale(proxy) {
  const style = getComputedStyle(els.viewer);
  const avail = els.viewer.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const base = proxy.getViewport({ scale: 1 }).width;
  return (Math.min(avail, MAX_FIT_WIDTH) / base) * state.zoom;
}

// Size every page box for the current width and zoom, keeping the reader's place.
function layoutPages() {
  if (!state.pages.length) return;
  const anchor = currentPosition();
  for (const p of state.pages) sizePage(p);
  restorePosition(anchor);
  for (const p of state.pages) if (isNearView(p.el)) renderPage(p);
}

function isNearView(el) {
  const v = els.viewer.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.bottom > v.top - v.height && r.top < v.bottom + v.height;
}

async function renderPage(p) {
  if (p.rendered) return;
  p.rendered = true;
  const scale = cssScale(p.proxy);
  const dpr = window.devicePixelRatio || 1;
  const viewport = p.proxy.getViewport({ scale: scale * dpr });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  p.task?.cancel();
  p.task = p.proxy.render({ canvas, viewport });
  try {
    await p.task.promise;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") console.error(err);
    return;
  }
  p.canvas.replaceWith(canvas);
  p.canvas = canvas;
  renderText(p, p.proxy.getViewport({ scale })).catch((err) => console.error("text:", err));
  renderLinks(p, p.proxy.getViewport({ scale })).catch((err) => console.error("links:", err));
}

// Transparent pdf.js text layer over the canvas, so text can be selected
// (and sent to the side chat as "I selected this").
async function renderText(p, viewport) {
  const div = document.createElement("div");
  div.className = "textLayer";
  p.el.style.setProperty("--total-scale-factor", String(viewport.scale));
  p.el.style.setProperty("--scale-round-x", "1px");
  p.el.style.setProperty("--scale-round-y", "1px");
  const layer = new pdfjs.TextLayer({ textContentSource: p.proxy.streamTextContent(), container: div, viewport });
  await layer.render();
  p.el.querySelector(".textLayer")?.remove();
  p.links.before(div);
}

async function renderLinks(p, viewport) {
  const annots = await p.proxy.getAnnotations({ intent: "display" });
  const anchors = [];
  for (const a of annots) {
    if (a.subtype !== "Link" || (!a.url && !a.dest)) continue;
    // PDF space -> CSS pixels through the viewport's affine transform.
    const [ta, tb, tc, td, te, tf] = viewport.transform;
    const toView = (x, y) => [ta * x + tc * y + te, tb * x + td * y + tf];
    const [x1, y1] = toView(a.rect[0], a.rect[1]);
    const [x2, y2] = toView(a.rect[2], a.rect[3]);
    const link = document.createElement("a");
    link.style.left = `${Math.min(x1, x2)}px`;
    link.style.top = `${Math.min(y1, y2)}px`;
    link.style.width = `${Math.abs(x2 - x1)}px`;
    link.style.height = `${Math.abs(y2 - y1)}px`;
    if (a.url && a.url.startsWith(`${location.origin}/#/`)) {
      link.href = a.url.slice(location.origin.length + 1);
      link.title = "back to where you asked";
    } else if (a.url) {
      link.href = a.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = a.url;
    } else {
      link.href = "#";
      link.addEventListener("click", async (e) => {
        e.preventDefault();
        // Session pages are separate PDFs: resolve in the page's own document.
        const doc = p.doc ?? state.doc;
        const dest = typeof a.dest === "string" ? await doc.getDestination(a.dest) : a.dest;
        const first = state.pages.findIndex((q) => (q.doc ?? state.doc) === doc);
        if (dest) goToPage(first + (await doc.getPageIndex(dest[0])) + 1);
      });
    }
    anchors.push(link);
  }
  p.links.replaceChildren(...anchors);
}

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const p = state.pages[Number(e.target.dataset.n) - 1];
    if (p) renderPage(p);
  }
}, { root: els.viewer, rootMargin: "100% 0px" });

function pageTop(el) {
  return el.getBoundingClientRect().top - els.viewer.getBoundingClientRect().top + els.viewer.scrollTop;
}

function currentPosition() {
  if (!state.pages.length) return null;
  const p = state.pages[state.page - 1];
  const h = p.el.getBoundingClientRect().height || 1;
  return { page: state.page, frac: (els.viewer.scrollTop - pageTop(p.el)) / h };
}

function restorePosition(pos) {
  if (!pos) return;
  const p = state.pages[pos.page - 1];
  els.viewer.scrollTop = pageTop(p.el) + pos.frac * p.el.getBoundingClientRect().height;
}

function goToPage(n) {
  if (!state.pages.length) return;
  n = Math.max(1, Math.min(state.pages.length, n));
  els.viewer.scrollTop = pageTop(state.pages[n - 1].el) - 8;
  state.page = n;
  renderChrome();
}

function updateCurrentPage() {
  if (!state.pages.length) return;
  const line = els.viewer.scrollTop + els.viewer.clientHeight * 0.3;
  let n = 1;
  for (const p of state.pages) {
    if (pageTop(p.el) <= line) n = Number(p.el.dataset.n);
    else break;
  }
  if (n !== state.page) {
    state.page = n;
    renderChrome();
  }
}

function setZoom(z) {
  state.zoom = Math.max(0.4, Math.min(4, z));
  layoutPages();
  renderChrome();
}

function toggleInvert() {
  state.invert = !state.invert;
  localStorage.setItem("learn.invert", state.invert ? "1" : "0");
  els.viewer.classList.toggle("invert", state.invert);
  renderChrome();
}

function download() {
  const item = state.open;
  if (!item) return;
  const src = state.showSource ? item.source : item.src;
  const a = document.createElement("a");
  a.href = `/${src}`;
  a.download = src.split("/").pop();
  a.click();
}

// ------------------------------------------------------------------ keys ---

function toggleHelp(show = els.help.hidden) {
  els.help.hidden = !show;
}

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!els.help.hidden) {
    if (e.key === "Escape" || e.key === "?" || e.key === "q") toggleHelp(false);
    e.preventDefault();
    return;
  }
  // Study mode (web/study.js) owns the keyboard while it is open, and typing
  // in a text field is never a shortcut.
  if (document.body.classList.contains("studying") || e.target.closest?.("input, textarea, select")) return;
  if (e.key === "x") { e.preventDefault(); location.href = "/explore/"; return; }
  // c: chat; on a page written this session, a follow-up scoped to that page.
  if (e.key === "c" && window.learnSide && document.body.classList.contains("has-study")) { e.preventDefault(); (window.learnSide.cKey ?? window.learnSide.toggle)(); return; }
  if (e.key === "b" && openKey()) {
    const info = window.learnStudy?.lessonAt?.(openKey());
    if (info?.parent) { e.preventDefault(); window.learnStudy.backUp(info.lesson); return; }
  }
  const inView = state.focus === "view";
  const isPdf = state.open?.kind === "pdf" && !state.showSource;
  let handled = true;
  switch (e.key) {
    case "?": toggleHelp(true); break;
    case "Tab": setFocus(inView ? "list" : "view"); break;
    case "h": case "ArrowLeft": {
      // In the viewer, h asks for an (experimental) history lesson on the
      // open file when unlocked. In the list: fold the folder, or jump up.
      const r = rows()[state.sel];
      if (inView && e.key === "h" && document.body.classList.contains("has-study") && openKey()) window.learnStudy?.history?.(openKey());
      else if (inView) setFocus("list");
      else if (r?.type === "dir" && r.open) setDirOpen(r.path, false);
      else {
        const parent = r?.type === "dir" ? (r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "") : r?.item.group;
        const idx = parent ? rows().findIndex((x) => x.type === "dir" && x.path === parent) : -1;
        if (idx >= 0) { state.sel = idx; renderList(); }
      }
      break;
    }
    case "j": case "ArrowDown":
      if (inView) els.viewer.scrollBy({ top: SCROLL_STEP });
      else moveSel(1);
      break;
    case "k": case "ArrowUp":
      if (inView) els.viewer.scrollBy({ top: -SCROLL_STEP });
      else moveSel(-1);
      break;
    case "Enter": case "l": case "ArrowRight":
      if (!inView && rows()[state.sel]?.type === "dir") {
        const r = rows()[state.sel];
        if (e.key === "Enter") setDirOpen(r.path, !r.open);
        else if (!r.open) setDirOpen(r.path, true);
        else moveSel(1);
      } else if (!inView && rows()[state.sel]) {
        openItem(rows()[state.sel].item);
        setFocus("view");
      } else if (!inView) handled = false;
      else setFocus("view");
      break;
    case "n": if (isPdf) goToPage(state.page + 1); break;
    case "p": if (isPdf) goToPage(state.page - 1); break;
    case "g": if (isPdf) goToPage(1); else els.viewer.scrollTop = 0; break;
    case "G": if (isPdf) goToPage(state.pages.length); else els.viewer.scrollTop = els.viewer.scrollHeight; break;
    case "+": case "=": if (isPdf) setZoom(state.zoom * ZOOM_STEP); break;
    case "-": case "_": if (isPdf) setZoom(state.zoom / ZOOM_STEP); break;
    case "0": if (isPdf) setZoom(1); break;
    case "i": toggleInvert(); break;
    case "d": download(); break;
    case "s":
      if (state.open?.kind === "pdf" && state.open.source) {
        state.showSource = !state.showSource;
        showItem();
      }
      break;
    default:
      if (/^[1-9]$/.test(e.key)) setTab(Number(e.key) - 1);
      else handled = false;
  }
  if (handled) e.preventDefault();
});

$("help-btn").addEventListener("click", () => toggleHelp(true));
$("hist-btn")?.addEventListener("click", () => openKey() && window.learnStudy?.history?.(openKey()));
document.addEventListener("learn:theme", () => renderChrome());
els.help.addEventListener("click", (e) => { if (e.target === els.help) toggleHelp(false); });
$("toggle-list").addEventListener("click", () => document.body.classList.toggle("list-collapsed"));
els.viewer.addEventListener("pointerdown", () => { if (state.focus !== "view") setFocus("view"); });
els.list.addEventListener("pointerdown", () => { if (state.focus !== "list") setFocus("list"); });
els.viewer.addEventListener("scroll", () => requestAnimationFrame(updateCurrentPage), { passive: true });
// Infinite learn: tell web/infinite.js when the reader reaches the end.
let nearBottomAt = 0;
els.viewer.addEventListener("scroll", () => {
  const v = els.viewer;
  if (!state.pages.length || v.scrollTop + v.clientHeight < v.scrollHeight - v.clientHeight * 0.5) return;
  if (Date.now() - nearBottomAt < 1500) return;
  nearBottomAt = Date.now();
  document.dispatchEvent(new CustomEvent("learn:nearbottom"));
}, { passive: true });
window.addEventListener("popstate", applyHash);

let lastWidth = 0;
let resizeTimer = 0;
new ResizeObserver(([entry]) => {
  const w = Math.round(entry.contentRect.width);
  if (w === lastWidth) return;
  lastWidth = w;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layoutPages, 120);
}).observe(els.viewer);

// Hooks for study mode (web/study.js): switch tabs, open a freshly published
// lesson (reloading the file list first), and repaint the status bar.
async function loadManifest() {
  const res = await fetch("/manifest.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  state.tabs = (await res.json()).tabs;
}
// "<tab>/<path>" of the open file, used for time tracking (web/time.js) and
// for the side chat (web/sidechat.js), which pins the file as context.
const openKey = () => (state.open && state.openTab ? `${state.openTab}/${state.open.path}` : null);
window.learnTimeKey = () => (!document.body.classList.contains("studying") && openKey() ? `file:${openKey()}` : null);

window.learnApp = {
  setTab,
  renderChrome: () => { renderTabs(); renderChrome(); },
  async openPath(tabName, p) {
    window.learnStudy?.leave();
    try { await loadManifest(); } catch (err) { notice(`could not load the file list: ${err.message}`, "notice error"); return; }
    const tabIdx = state.tabs.findIndex((t) => t.name === tabName);
    if (tabIdx < 0) return;
    setTab(tabIdx);
    const item = items().find((it) => it.path === p);
    if (!item) return;
    selectItem(item);
    state.open = null;
    openItem(item);
    setFocus("view");
  },
  // After the command box changed files: reload the tree, follow the open
  // file if it moved, and close it if it's gone.
  async reload({ moves = [] } = {}) {
    const key = openKey();
    const tabName = state.tabs[state.tab]?.name;
    try { await loadManifest(); } catch { return; }
    const ti = state.tabs.findIndex((t) => t.name === tabName);
    state.tab = ti < 0 ? 0 : ti;
    if (key) {
      let next = key;
      for (const [from, to] of moves) if (next === from || next.startsWith(`${from}/`)) next = to + next.slice(from.length);
      const [nt, ...rest] = next.split("/");
      const t = state.tabs.find((x) => x.name === nt);
      const item = t?.items.find((it) => it.path === rest.join("/"));
      if (!item) {
        closeDoc();
        state.open = null; state.openTab = null;
        els.viewTitle.textContent = "no file open";
        notice("that file was moved or deleted");
        if (location.hash.length > 2) history.replaceState(null, "", location.pathname);
      } else if (next === key) {
        state.open = item;
      } else {
        return this.openPath(nt, rest.join("/"));
      }
    }
    renderTabs(); renderList(); renderChrome();
    document.dispatchEvent(new CustomEvent("learn:open"));
  },
  openKey: () => openKey(),
  // page is 1-based over everything shown; pages counts the open PDF's own
  // pages; sec/secTitle are set on pages written this session.
  pageInfo: () => {
    if (state.open?.kind !== "pdf" || state.showSource || !state.pages.length) return null;
    const p = state.pages[state.page - 1];
    return { page: state.page, pages: state.basePages, total: state.pages.length, sec: p?.sec ?? null, secTitle: p?.secTitle ?? null, appended: p?.appx !== undefined };
  },
  isPdf: () => state.open?.kind === "pdf" && !state.showSource,
  whenReady: () => (state.pages.length ? Promise.resolve(state.basePages) : state.ready.promise),
  setAppendix,
  scrollToSection,
  scrollToEnd: () => { els.viewer.scrollTop = els.viewer.scrollHeight; },
  focusView: () => { setFocus("view"); els.viewer.focus({ preventScroll: true }); },
  inStudy: () => document.body.classList.contains("studying"),
};

// ------------------------------------------------------------------ boot ---

async function boot() {
  try {
    await loadManifest();
  } catch (err) {
    notice(`could not load the file list: ${err.message}`, "notice error");
    return;
  }
  if (!applyHash()) setTab(0);
  renderChrome();
}

boot();
