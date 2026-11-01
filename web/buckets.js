import { h } from "/explore/render.js";

const root = document.getElementById("bk-library");
const app = () => window.learnApp;
const state = {
  buckets: [], focusId: null, statuses: [], categories: [],
  authed: false, loaded: false, loading: null,
  query: "", category: "", status: "", focusOnly: false,
  selected: null, check: null, answers: {},
};

const STATUSES = ["not_started", "unverified", "learning", "shaky", "solid"];
const STATUS_LABEL = {
  not_started: "not started",
  unverified: "unverified",
  learning: "learning",
  shaky: "shaky",
  solid: "solid",
};
const CATEGORIES = ["dsa", "course", "systems", "other"];

const button = (text, action, primary = false) =>
  h("button", { type: "button", class: `lc-button${primary ? " primary" : ""}`, onclick: action }, text);
const field = (label, control) => h("label", { class: "lc-field" }, h("span", {}, label), control);
const input = (attrs = {}) => h("input", attrs);
function select(label, values, change) {
  const el = h("select", { "aria-label": label, onchange: change },
    h("option", { value: "" }, label),
    ...values.map((v) => h("option", { value: v }, STATUS_LABEL[v] || v)));
  return el;
}

async function api(method, url, body) {
  const response = await fetch(url, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (response.status === 401) {
    const error = new Error("unlock first");
    error.status = 401;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function receive(data) {
  state.buckets = data.buckets ?? [];
  state.focusId = data.focusId ?? null;
  state.statuses = data.statuses ?? STATUSES;
  state.categories = data.categories ?? CATEGORIES;
  if (state.selected) {
    state.selected = state.buckets.find((b) => b.id === state.selected.id) || null;
  }
  render();
}

const notice = h("p", { class: "lc-notice", role: "status" });
const search = input({ type: "search", placeholder: "Search buckets, subtopics, unknowns…", "aria-label": "Search buckets" });
search.addEventListener("input", () => { state.query = search.value.trim().toLocaleLowerCase(); renderResults(); });
const categoryFilter = select("All categories", CATEGORIES, (e) => { state.category = e.target.value; renderResults(); });
const statusFilter = select("All statuses", STATUSES, (e) => { state.status = e.target.value; renderResults(); });

const rows = h("tbody");
const resultsLabel = h("h2", { id: "bk-results-label" }, "Buckets");
const table = h("table", { class: "lc-table bk-table", "aria-labelledby": "bk-results-label" },
  h("thead", {}, h("tr", {},
    h("th", {}, "Bucket"), h("th", {}, "Category"), h("th", {}, "Status"),
    h("th", {}, "Progress"), h("th", {}, "Links"), h("th", {}, "Focus"), h("th", {}, "Actions"))),
  rows);

const detail = h("div", { class: "bk-detail", hidden: true });
const checkPane = h("div", { class: "bk-check", hidden: true });

root.append(
  h("header", { class: "lc-header" },
    h("h1", {}, "Buckets"),
    h("div", { class: "lc-actions" },
      button("Add bucket", () => authorized(() => editBucket())),
      button("Focus only", () => { state.focusOnly = !state.focusOnly; renderResults(); }),
      button("Close", () => hide()))),
  h("p", { class: "lc-muted" },
    "Ishaan-style map of what you have to learn. Statuses: not started · unverified (assumed known, not proven) · learning · shaky · solid. Seed never marks solid — use Check / Cross-check."),
  notice,
  h("nav", { class: "lc-database-nav", "aria-label": "Bucket views" },
    button("All buckets", () => { state.focusOnly = false; state.selected = null; state.check = null; render(); }, true),
    button("Current focus", () => { state.focusOnly = true; state.selected = null; renderResults(); })),
  h("div", { class: "lc-filters" },
    field("Search", search),
    field("Category", categoryFilter),
    field("Status", statusFilter),
    button("Clear filters", () => {
      state.query = ""; state.category = ""; state.status = ""; state.focusOnly = false;
      search.value = ""; categoryFilter.value = ""; statusFilter.value = "";
      renderResults();
    })),
  resultsLabel,
  h("div", { class: "lc-table-wrap", role: "region", "aria-label": "Buckets table", tabindex: 0 }, table),
  detail,
  checkPane,
);

function progressBar(pct) {
  return h("div", { class: "bk-progress", title: `${pct}%` },
    h("div", { class: "bk-progress-bar", style: `width:${Math.max(0, Math.min(100, pct))}%` }),
    h("span", { class: "bk-progress-label" }, `${pct}%`));
}

function statusChip(status) {
  return h("span", { class: `bk-status bk-status-${status}` }, STATUS_LABEL[status] || status);
}

function renderResults() {
  const focusBtn = root.querySelector(".lc-database-nav .lc-button");
  // update nav current
  const navButtons = root.querySelectorAll(".lc-database-nav .lc-button");
  navButtons.forEach((btn, i) => {
    if (i === 0) btn.setAttribute("aria-current", !state.focusOnly && !state.selected ? "page" : null);
    if (i === 1) btn.setAttribute("aria-current", state.focusOnly ? "page" : null);
  });

  let list = state.buckets;
  if (state.focusOnly) list = list.filter((b) => b.focus || b.id === state.focusId);
  if (state.category) list = list.filter((b) => b.category === state.category);
  if (state.status) list = list.filter((b) => b.status === state.status);
  if (state.query) {
    list = list.filter((b) => {
      const blob = [b.name, b.description, b.category, b.status, ...(b.tags || []),
        ...b.subtopics.map((s) => s.name), ...b.unknowns.map((u) => u.text)].join(" ").toLocaleLowerCase();
      return blob.includes(state.query);
    });
  }
  resultsLabel.textContent = state.focusOnly ? `Focus (${list.length})` : `Buckets (${list.length})`;
  rows.replaceChildren();
  if (!list.length) {
    rows.append(h("tr", {}, h("td", { colspan: 7, class: "lc-empty" },
      state.buckets.length ? "No matching buckets. Clear filters or search." : "No buckets yet. Use Add bucket or : make a dp bucket")));
    return;
  }
  for (const b of list) {
    const open = button(b.name + (b.focus ? " ★" : ""), () => { state.selected = b; state.check = null; render(); });
    open.classList.add("lc-text-button");
    const links = b.links || {};
    const solved = Array.isArray(b.problems) ? b.problems.length : 0;
    const linkText = [
      solved ? `${solved} solved` : (links.problems ? `${links.problems} LC` : null),
      links.explainers ? `${links.explainers} AI` : null,
      links.materials ? `${links.materials} files` : null,
    ].filter(Boolean).join(" · ") || "—";
    const actions = h("div", { class: "lc-row-actions" },
      button("Open", () => { state.selected = b; render(); }),
      button(b.focus ? "Unfocus" : "Focus", () => authorized(() => setFocus(b.focus ? null : b.id))),
      button("Check", () => authorized(() => startCheck(b))),
      button("Cross-check", () => authorized(() => startCheck(b, "crosscheck"))),
    );
    rows.append(h("tr", {},
      h("th", { class: "lc-table-title", scope: "row" }, open,
        b.tags?.length ? h("div", { class: "lc-muted" }, b.tags.join(", ")) : null),
      h("td", {}, b.category),
      h("td", {}, statusChip(b.status)),
      h("td", {}, progressBar(b.progress?.percent ?? 0),
        h("div", { class: "lc-muted" }, `${b.progress?.subtopicsSolid ?? 0}/${b.progress?.subtopicsTotal ?? 0} solid`)),
      h("td", {}, linkText),
      h("td", {}, b.focus ? "★ focus" : "—"),
      h("td", {}, actions),
    ));
  }
}

function renderDetail() {
  const b = state.selected;
  detail.hidden = !b || !!state.check;
  if (!b) { detail.replaceChildren(); return; }
  const subRows = h("tbody");
  for (const s of b.subtopics) {
    const statusSel = h("select", {
      "aria-label": `Status for ${s.name}`,
      onchange: (e) => authorized(() => setStatus(b.id, s.id, e.target.value)),
    }, ...STATUSES.map((st) => h("option", { value: st }, STATUS_LABEL[st])));
    statusSel.value = s.status;
    subRows.append(h("tr", {},
      h("th", { scope: "row" }, s.name),
      h("td", {}, statusChip(s.status)),
      h("td", {}, statusSel),
      h("td", {}, button("Check", () => authorized(() => startCheck(b, "check", s.name)))),
    ));
  }
  const unknownList = b.unknowns?.length
    ? h("ul", { class: "bk-unknowns" }, b.unknowns.map((u) => h("li", {},
      u.text, " ", button("Dismiss", () => authorized(() => api("POST", `/api/buckets/${b.id}/unknowns/${u.id}/delete`).then(receive))))))
    : h("p", { class: "lc-muted" }, "No unknowns yet. Checks and the ask box can add them.");
  const taskList = h("ul", { class: "bk-tasks" },
    ...(b.tasks || []).map((t) => h("li", {},
      h("label", {},
        h("input", { type: "checkbox", checked: t.done, onchange: (e) => authorized(() => api("POST", `/api/buckets/${b.id}/tasks/${t.id}`, { done: e.target.checked }).then(receive)) }),
        " ", t.text))),
    h("li", {}, button("Add task", () => authorized(() => addTask(b)))));

  detail.replaceChildren(
    h("header", { class: "lc-header" },
      h("h2", {}, b.name, b.focus ? " ★ focus" : ""),
      h("div", { class: "lc-actions" },
        button("Back", () => { state.selected = null; render(); }),
        button(b.focus ? "Clear focus" : "Set focus", () => authorized(() => setFocus(b.focus ? null : b.id))),
        button("Add subtopic", () => authorized(() => addSubtopic(b))),
        button("Add unknown", () => authorized(() => addUnknown(b))),
        button("Check", () => authorized(() => startCheck(b))),
        button("Cross-check", () => authorized(() => startCheck(b, "crosscheck")), true))),
    h("p", { class: "lc-muted" }, b.description || ""),
    progressBar(b.progress?.percent ?? 0),
    b.problems?.length
      ? h("section", { class: "bk-solved" },
          h("h3", {}, `Solved (${b.problems.length}) — cold re-solve candidates`),
          h("ul", { class: "bk-solved-list" },
            ...b.problems.map((p) => h("li", {},
              h("a", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, p.name),
              p.subtopics?.length ? h("span", { class: "lc-muted" }, ` · ${p.subtopics.join(", ")}`) : null,
            ))))
      : h("p", { class: "lc-muted" }, "No solved problems linked yet."),
    h("h3", {}, "Subtopics"),
    h("div", { class: "lc-table-wrap" },
      h("table", { class: "lc-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Subtopic"), h("th", {}, "Status"), h("th", {}, "Set"), h("th", {}, ""))),
        subRows)),
    h("h3", {}, "Unknowns"),
    unknownList,
    h("h3", {}, "Tasks"),
    taskList,
  );
  detail.scrollIntoView({ block: "start", behavior: "smooth" });
}

function renderCheck() {
  const c = state.check;
  checkPane.hidden = !c;
  if (!c) { checkPane.replaceChildren(); return; }
  const questions = Array.isArray(c.questions) ? c.questions : [];
  if (!questions.length) {
    checkPane.replaceChildren(
      h("header", { class: "lc-header" },
        h("h2", {}, "Check"),
        h("div", { class: "lc-actions" }, button("Cancel", () => { state.check = null; render(); }))),
      h("p", { class: "lc-muted" }, "No questions on this check yet. Try Check again."),
    );
    return;
  }
  const fields = questions.map((q) => {
    const ta = h("textarea", {
      rows: 3,
      placeholder: "Your answer…",
      "aria-label": `Answer ${q.n}`,
      oninput: (e) => { state.answers[q.id] = e.target.value; },
    }, state.answers[q.id] || "");
    return h("div", { class: "bk-q" },
      h("p", {}, h("b", {}, `Q${q.n}. `), q.text),
      field("Answer", ta));
  });
  checkPane.replaceChildren(
    h("header", { class: "lc-header" },
      h("h2", {}, c.mode === "crosscheck" ? "Cross-check" : "Check", ` — ${c.bucketName}`),
      h("div", { class: "lc-actions" },
        button("Cancel", () => { state.check = null; state.answers = {}; render(); }),
        button("Submit answers", () => authorized(() => gradeCheck()), true))),
    h("p", { class: "lc-muted" },
      "Quick recall. Answer in your own words. Grading sets solid / shaky / not started and can add unknowns — never invents mastery."),
    h("p", { class: "lc-muted" }, `Subtopics: ${(c.subtopicNames || []).join(", ")}`),
    ...fields,
    notice.cloneNode(true),
  );
  checkPane.scrollIntoView({ block: "start", behavior: "smooth" });
}

function render() {
  detail.hidden = true;
  checkPane.hidden = true;
  if (state.check) renderCheck();
  else if (state.selected) renderDetail();
  renderResults();
}

async function load() {
  if (state.loading) return state.loading;
  state.loading = (async () => {
    try {
      const data = await api("GET", "/api/buckets");
      state.authed = true;
      receive(data);
      notice.textContent = "";
      notice.classList.remove("error");
    } catch (e) {
      if (e.status === 401) {
        notice.textContent = "Unlock to load buckets (passcode).";
        await unlock();
      } else {
        notice.textContent = e.message;
        notice.classList.add("error");
      }
    } finally {
      state.loading = null;
    }
  })();
  return state.loading;
}

function dialog(title) {
  const dlg = h("dialog", { class: "lc-dialog" });
  const form = h("form", { class: "lc-editor", method: "dialog" });
  const err = h("p", { class: "lc-form-error error" });
  form.append(h("h2", {}, title), err);
  dlg.append(form);
  document.body.append(dlg);
  return {
    dlg, form, err,
    close() { dlg.close(); dlg.remove(); },
    async open() { dlg.showModal(); },
  };
}

async function unlock() {
  const ui = dialog("Unlock buckets");
  const pass = input({ type: "password", name: "passcode", required: true, autocomplete: "current-password" });
  ui.form.append(field("Passcode", pass),
    h("div", { class: "lc-editor-actions" },
      button("Cancel", () => ui.close()),
      h("button", { type: "submit", class: "lc-button primary" }, "Unlock")));
  ui.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("POST", "/api/login", { passcode: pass.value });
      state.authed = true;
      window.learnTimeEnable?.();
      document.dispatchEvent(new CustomEvent("learn:auth"));
      ui.close();
      await load();
    } catch (err) {
      ui.err.textContent = err.message;
    }
  });
  await ui.open();
}

async function authorized(fn) {
  try {
    if (!state.authed) await unlock();
    if (!state.authed) return;
    await fn();
  } catch (e) {
    if (e.status === 401) { state.authed = false; await unlock(); if (state.authed) await fn(); }
    else { notice.textContent = e.message; notice.classList.add("error"); }
  }
}

async function setFocus(id) {
  await api("POST", "/api/buckets/focus", { bucket: id });
  await load();
}
async function setStatus(bid, sid, status) {
  const data = await api("POST", `/api/buckets/${bid}/status`, { subtopic: sid, status });
  receive(data);
}
async function addSubtopic(b) {
  const name = prompt("Subtopic name?");
  if (!name?.trim()) return;
  receive(await api("POST", `/api/buckets/${b.id}/subtopics`, { name: name.trim() }));
}
async function addUnknown(b) {
  const text = prompt("What don't you know yet?");
  if (!text?.trim()) return;
  receive(await api("POST", `/api/buckets/${b.id}/unknowns`, { text: text.trim() }));
}
async function addTask(b) {
  const text = prompt("Task?");
  if (!text?.trim()) return;
  receive(await api("POST", `/api/buckets/${b.id}/tasks`, { text: text.trim() }));
}
async function editBucket() {
  const name = prompt("Bucket name? (e.g. Dynamic Programming)");
  if (!name?.trim()) return;
  const category = prompt("Category? dsa / course / systems / other", "dsa") || "dsa";
  receive(await api("POST", "/api/buckets", { name: name.trim(), category, subtopics: [] }));
}
async function startCheck(b, mode = "check", subtopic = null) {
  notice.textContent = "Writing diagnostic questions…";
  notice.classList.remove("error");
  try {
    const url = mode === "crosscheck" ? `/api/buckets/${b.id}/crosscheck` : `/api/buckets/${b.id}/check`;
    const data = await api("POST", url, subtopic ? { subtopic, mode } : { mode });
    state.check = data.check;
    state.answers = {};
    state.selected = b;
    notice.textContent = "";
    render();
  } catch (e) {
    notice.textContent = e.message;
    notice.classList.add("error");
  }
}
async function gradeCheck() {
  const c = state.check;
  if (!c) return;
  notice.textContent = "Grading…";
  const answers = (c.questions || []).map((q) => state.answers[q.id] || "");
  try {
    const data = await api("POST", `/api/buckets/checks/${c.id}/grade`, { answers });
    state.check = null;
    state.answers = {};
    if (data.snapshot) receive(data.snapshot);
    else await load();
    notice.textContent = data.reply || "Graded.";
    notice.classList.remove("error");
    render();
  } catch (e) {
    notice.textContent = e.message;
    notice.classList.add("error");
  }
}

function show(opts = {}) {
  window.learnLeetcode?.hide?.();
  document.body.classList.add("bk-active", "bk-library");
  document.body.classList.remove("lc-library", "lc-active");
  const lc = document.getElementById("lc-library");
  if (lc) lc.hidden = true;
  root.hidden = false;
  const btn = document.getElementById("buckets-btn");
  if (btn) btn.setAttribute("aria-selected", "true");
  document.querySelectorAll("#tabs .tab").forEach((el) => el.setAttribute("aria-selected", "false"));
  if (opts.focusName) {
    state.query = "";
    // select after load
  }
  if (location.hash !== "#/buckets") history.pushState(null, "", "#/buckets");
  app()?.renderChrome?.();
  load().then(() => {
    if (opts.focusName) {
      const b = state.buckets.find((x) => x.name.toLowerCase().includes(String(opts.focusName).toLowerCase()) || x.slug === opts.focusName);
      if (b) { state.selected = b; render(); }
    }
  });
  search.focus({ preventScroll: true });
}
function hide() {
  document.body.classList.remove("bk-active", "bk-library");
  root.hidden = true;
  const btn = document.getElementById("buckets-btn");
  if (btn) btn.setAttribute("aria-selected", "false");
  if (location.hash === "#/buckets") history.pushState(null, "", location.pathname);
  app()?.renderChrome?.(); // restores content-tab aria-selected
}
function showCheck(check) {
  show();
  const c = check?.check && !check.questions ? check.check : check;
  state.check = c && (c.questions || c.id) ? c : null;
  state.answers = {};
  render();
}

document.addEventListener("learn:auth", () => { state.authed = true; if (!root.hidden) load(); });
document.addEventListener("learn:tab", () => { if (!root.hidden) hide(); });
document.addEventListener("keydown", (event) => {
  if (root.hidden || document.body.classList.contains("studying") || !document.getElementById("help").hidden) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "Escape" && state.check) { state.check = null; render(); }
  if (event.key === "Escape" && state.selected && !state.check) { state.selected = null; render(); }
});

window.learnBuckets = { show, hide, refresh: load, showCheck, isOpen: () => !root.hidden };

// Hash route
if (location.hash === "#/buckets") show({ focus: false });
