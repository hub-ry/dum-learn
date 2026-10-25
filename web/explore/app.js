import { h, markdown, copyText } from "./render.js";

const $ = (id) => document.getElementById(id);
const CONTEXT_LIMIT = 14000;
const state = {
  authed: false, ai: false, chats: [], chat: null, busy: false, stream: null,
  drafts: new Map(), contexts: new Map(), dialogAction: null,
};
const key = () => state.chat?.id ?? "new";
const savedContext = () => state.chat?.context ?? "";
const locked = () => state.busy || Boolean(state.stream) || Boolean(state.chat?.streaming);
const contextDirty = () => $("context-input").value !== savedContext();
const chatURL = (id = state.chat.id) => `/api/chats/${encodeURIComponent(id)}`;
function hasDrafts() {
  return [...state.drafts.values()].some((draft) => draft.trim())
    || [...state.contexts].some(([id, context]) => context !== (id === key() ? savedContext() : state.chats.find((chat) => chat.id === id)?.context ?? ""));
}

function showError(message) {
  $("error-text").textContent = message;
  $("error-banner").hidden = !message;
}
function showGate(message = "Enter your passcode to continue.") {
  $("workspace").hidden = true;
  $("gate").hidden = false;
  $("login-form").hidden = false;
  $("gate-status").textContent = message;
}
async function api(method, url, body) {
  const response = await fetch(url, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error("The server returned an unreadable response. Try again."); }
  if (response.status === 401 && url !== "/api/login") {
    state.authed = false;
    showGate("Your session ended. Log in to continue. Your drafts are still here.");
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
async function action(callback) {
  if (state.busy || state.stream) return;
  state.busy = true;
  showError("");
  controls();
  try { await callback(); }
  catch (error) { showError(error.message || "Couldn't connect. Try again."); }
  finally { state.busy = false; controls(); }
}
function rememberInputs() {
  state.drafts.set(key(), $("message-input").value);
  state.contexts.set(key(), $("context-input").value);
}
function growInput() {
  const input = $("message-input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}
function setChat(chat) {
  state.chat = chat;
  $("chat-title").textContent = chat?.title || "New exploration";
  document.title = `${chat?.title || "Explore"} · Learn`;
  $("message-input").value = state.drafts.get(key()) ?? "";
  $("context-input").value = state.contexts.get(key()) ?? savedContext();
  renderMessages();
  renderHistory();
  controls();
  growInput();
  $("conversation-scroll").scrollTop = $("conversation-scroll").scrollHeight;
}
function updateChat(chat) {
  state.chat = chat;
  const index = state.chats.findIndex((item) => item.id === chat.id);
  if (index < 0) state.chats.unshift(chat);
  else state.chats[index] = chat;
  state.chats.sort((a, b) => new Date(b.updated) - new Date(a.updated));
  $("chat-title").textContent = chat.title || "New exploration";
  document.title = `${chat.title || "Explore"} · Learn`;
  renderHistory();
}
function renderHistory() {
  $("history").replaceChildren();
  if (!state.chats.length) {
    $("history").append(h("p", { class: "history-empty" }, "Your conversations will appear here."));
    return;
  }
  for (const chat of state.chats) {
    const date = new Date(chat.updated);
    const button = h("button", {
      type: "button", class: `history-item${state.chat?.id === chat.id ? " selected" : ""}`,
      "aria-current": state.chat?.id === chat.id ? "page" : null,
      title: chat.title || "Untitled conversation", disabled: locked(),
      onclick: () => openChat(chat.id),
    }, h("span", { class: "history-title" }, chat.title || "Untitled conversation"),
    h("span", { class: "history-meta" }, Number.isNaN(date.getTime()) ? "Saved conversation" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" })));
    $("history").append(button);
  }
}
function controls() {
  const lock = locked();
  const input = $("message-input");
  input.disabled = state.busy || Boolean(state.stream && !state.stream.accepted);
  $("context-input").readOnly = lock;
  $("send").hidden = Boolean(state.stream);
  $("send").disabled = lock || !state.ai || !input.value.trim() || contextDirty();
  $("stop").hidden = !state.stream;
  $("stop").disabled = Boolean(state.stream?.stopping);
  for (const id of ["new-chat", "rename", "delete", "logout", "context-save", "context-clear"]) $(id).disabled = lock;
  $("rename").disabled ||= !state.chat;
  $("delete").disabled ||= !state.chat;
  $("refresh").disabled = state.busy || Boolean(state.stream);
  const context = $("context-input").value;
  $("context-count").textContent = `${context.length.toLocaleString()} / 14,000`;
  $("context-count").classList.toggle("over-limit", context.length > CONTEXT_LIMIT);
  $("context-save").disabled ||= !contextDirty() || context.length > CONTEXT_LIMIT;
  $("context-clear").disabled ||= !context && !savedContext();
  $("context-state").textContent = context.length > CONTEXT_LIMIT ? "Too long. Nothing has been trimmed." : contextDirty() ? "Unsaved changes. Save or clear before sending." : context ? "Saved for this conversation" : "No pinned context";
  $("context-dot").hidden = !savedContext() && !contextDirty();
  for (const button of document.querySelectorAll(".history-item, .pin-answer")) button.disabled = lock;
  $("messages").setAttribute("aria-busy", String(Boolean(state.stream)));
  const trimmed = state.chat?.historyTrimmed;
  $("trimmed-note").textContent = Number.isFinite(trimmed) && trimmed > 0 ? ` ${trimmed} older ${trimmed === 1 ? "message is" : "messages are"} left out of the current request.` : "";
  $("model-status").textContent = state.ai ? "DeepSeek" : "DeepSeek unavailable";
  if (state.stream) $("stream-status").textContent = state.stream.stopping ? "Stopping reply…" : "DeepSeek is replying…";
  else if (state.chat?.streaming) $("stream-status").textContent = "A reply is still running. Refresh to load the saved reply.";
  else if (!state.ai) $("stream-status").textContent = "DeepSeek isn't configured on the server. Saved conversations are still readable.";
  else if (contextDirty()) $("stream-status").textContent = "Save or clear your context changes before sending.";
  else $("stream-status").textContent = "";
}
function renderMessages() {
  const messages = state.chat?.messages ?? [];
  $("welcome").hidden = messages.length > 0;
  $("messages").replaceChildren(...messages.map((message) => messageNode(message)));
}
function messageNode(message) {
  const assistant = message.role === "assistant";
  const body = h("div", { class: "message-body" });
  if (assistant) body.append(...markdown(message.content || ""));
  else body.append(h("p", { class: "plain-message" }, message.content || ""));
  const article = h("article", { class: `message ${assistant ? "assistant" : "user"}` },
    h("div", { class: "message-byline" }, assistant ? "DeepSeek" : message.role === "user" ? "You" : "Saved note"), body);
  if (message.stopped) article.append(h("p", { class: "message-stopped" }, "Reply stopped"));
  if (assistant && message.content) {
    const copy = h("button", { type: "button", class: "quiet" }, "Copy");
    copy.addEventListener("click", () => copyText(message.content, copy));
    article.append(h("div", { class: "message-actions" }, copy,
      h("button", { type: "button", class: "quiet pin-answer", disabled: locked(), onclick: () => pinAnswer(message.content) }, "Pin to context")));
  }
  return article;
}
function sidebar(open) {
  $("sidebar").classList.toggle("open", open);
  $("sidebar-shade").hidden = !open;
  $("open-history").setAttribute("aria-expanded", String(open));
  if (open) $("close-history").focus();
}
function contextPanel(open) {
  $("context-panel").hidden = !open;
  $("context-toggle").setAttribute("aria-expanded", String(open));
}
function pinAnswer(text) {
  if (locked()) return;
  const current = $("context-input").value;
  const next = current ? `${current}\n\n${text}` : text;
  if (next.length > CONTEXT_LIMIT) {
    showError("That answer won't fit in the 14,000-character context. Copy the part you want to keep instead.");
    contextPanel(true);
    return;
  }
  $("context-input").value = next;
  state.contexts.set(key(), next);
  contextPanel(true);
  controls();
  $("context-input").focus();
  $("context-input").setSelectionRange(next.length, next.length);
}
async function openChat(id) {
  if (locked()) return;
  await action(async () => {
    rememberInputs();
    const { chat } = await api("GET", chatURL(id));
    setChat(chat);
    sidebar(false);
  });
}
async function loadHistory() {
  const { chats } = await api("GET", "/api/chats");
  state.chats = chats;
  renderHistory();
}
async function saveContext(clear = false) {
  if (locked()) return;
  if (clear && !window.confirm("Clear the pinned context for this conversation?")) return;
  const context = clear ? "" : $("context-input").value;
  if (context.length > CONTEXT_LIMIT) { showError("Context can be at most 14,000 characters. Nothing has been trimmed."); return; }
  await action(async () => {
    if (state.chat) {
      const { chat } = await api("POST", `${chatURL()}/context`, { context });
      updateChat(chat);
    } else if (context) {
      const { chat } = await api("POST", "/api/chats", { context });
      state.drafts.delete("new"); state.contexts.delete("new");
      updateChat(chat);
      state.drafts.set(key(), $("message-input").value);
    }
    state.contexts.set(key(), context);
    $("context-input").value = context;
  });
}
async function connect() {
  $("connection-retry").hidden = true;
  $("gate-status").textContent = "Connecting…";
  try {
    const status = await api("GET", "/api/status");
    state.authed = status.authed;
    state.ai = status.ai;
    if (!status.authed) { showGate(); $("passcode").focus(); return; }
    await loadHistory();
    const params = new URLSearchParams(location.search);
    const pin = params.get("file") ? { file: params.get("file") } : params.get("lesson") ? { lessonId: params.get("lesson") } : null;
    // ?q= comes from the command box ("ask the mutex notes why ..."): sent once.
    const firstQ = pin ? (params.get("q") ?? "").slice(0, 1000).trim() : "";
    if (pin) {
      // "chat about this file": resumes that file's last chat, or starts one
      // with the document pinned as context.
      history.replaceState(null, "", location.pathname);
      const { chat, resumed } = await api("POST", "/api/chats", pin);
      if (!state.chats.some((c) => c.id === chat.id)) state.chats.unshift(chat);
      setChat(chat);
      renderHistory();
      if (!resumed) contextPanel(true);
    } else if (state.chat) {
      const { chat } = await api("GET", chatURL());
      setChat(chat);
    } else setChat(null);
    $("gate").hidden = true;
    $("workspace").hidden = false;
    growInput();
    $("message-input").focus();
    if (firstQ && state.ai) { $("message-input").value = firstQ; growInput(); $("composer").requestSubmit(); }
  } catch (error) {
    $("gate-status").textContent = error.message || "Couldn't connect. Try again.";
    $("connection-retry").hidden = false;
  }
}

async function sendMessage(event) {
  event.preventDefault();
  if (locked() || !state.ai) return;
  if (contextDirty()) { contextPanel(true); showError("Save or clear your context changes before sending."); return; }
  const content = $("message-input").value.trim();
  if (!content) return;
  rememberInputs();
  const originalDraft = $("message-input").value;
  const stream = { controller: new AbortController(), stopping: false, accepted: false, done: false };
  state.stream = stream;
  showError("");
  controls();
  let pending, pendingBody, text = "", frame = null;
  const paint = (final = false) => {
    if (!pendingBody) return;
    const scroller = $("conversation-scroll");
    const stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 130;
    pendingBody.replaceChildren(...markdown(text, final));
    if (stick) scroller.scrollTop = scroller.scrollHeight;
  };
  try {
    if (!state.chat) {
      const { chat } = await api("POST", "/api/chats", {});
      state.drafts.delete("new"); state.contexts.delete("new");
      updateChat(chat);
      state.drafts.set(key(), originalDraft);
      state.contexts.set(key(), chat.context || "");
    }
    if (stream.stopping) return;
    const response = await fetch(`${chatURL()}/messages`, {
      method: "POST", credentials: "same-origin", signal: stream.controller.signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      let data = {};
      try { data = await response.json(); } catch {}
      if (response.status === 401) { state.authed = false; showGate("Your session ended. Log in to continue. Your draft is still here."); }
      throw new Error(data.error || `Couldn't send (${response.status}).`);
    }
    if (!response.body) throw new Error("This browser couldn't open the reply stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const dispatch = (block) => {
      const lines = block.split(/\r?\n/);
      const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
      const dataText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!dataText) return;
      const data = JSON.parse(dataText);
      if (eventName === "start") {
        stream.accepted = true;
        state.chat.messages ??= [];
        if (data.userMessage && !state.chat.messages.some((message) => message.id === data.userMessage.id)) state.chat.messages.push(data.userMessage);
        if (Number.isFinite(data.historyTrimmed)) state.chat.historyTrimmed = data.historyTrimmed;
        $("message-input").value = "";
        state.drafts.set(key(), ""); growInput();
        renderMessages();
        pendingBody = h("div", { class: "message-body streaming" });
        pending = h("article", { class: "message assistant" }, h("div", { class: "message-byline" }, "DeepSeek"), pendingBody);
        $("messages").append(pending);
        $("welcome").hidden = true;
        $("conversation-scroll").scrollTop = $("conversation-scroll").scrollHeight;
        controls();
      } else if (eventName === "delta") {
        text += data.t || "";
        if (frame === null) frame = requestAnimationFrame(() => { frame = null; paint(); });
      } else if (eventName === "done") {
        stream.done = true;
        if (data.chat) updateChat(data.chat);
        else if (data.message) state.chat.messages.push(data.message);
      } else if (eventName === "error") throw new Error(data.error || "The reply couldn't finish.");
    };
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        dispatch(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (chunk.done) break;
    }
    if (buffer.trim()) dispatch(buffer);
    if (!stream.done) throw new Error("The connection closed before the reply finished.");
  } catch (error) {
    stream.controller.abort();
    if (!stream.stopping) {
      const currentDraft = $("message-input").value;
      const recovered = stream.accepted && currentDraft ? `${originalDraft}\n\n${currentDraft}` : originalDraft;
      $("message-input").value = recovered;
      state.drafts.set(key(), recovered);
      showError(`${error.message || "Couldn't connect."} ${stream.accepted ? "Your message was saved. The original draft is kept below; check the conversation before sending again." : "Your draft is still here. Refresh before retrying if you're unsure whether it was saved."}`);
      growInput();
    }
  } finally {
    if (frame !== null) cancelAnimationFrame(frame);
    if (state.chat && !stream.done && state.authed) {
      // The server persists partial replies on disconnect. Never resend automatically.
      try {
        const { chat } = await api("GET", chatURL());
        if (chat.streaming && text) {
          chat.messages.push({ role: "assistant", content: text, stopped: true });
        }
        updateChat(chat);
      } catch {
        if (text) state.chat.messages.push({ role: "assistant", content: text, stopped: true });
        showError("Couldn't reload the saved conversation. Your draft is kept. Refresh before sending another message.");
        state.chat.streaming = true;
      }
    }
    state.stream = null;
    renderMessages();
    controls();
    renderHistory();
    $("message-input").focus();
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-button").disabled = true;
  $("gate-status").textContent = "Opening workspace…";
  try {
    await api("POST", "/api/login", { passcode: $("passcode").value });
    $("passcode").value = "";
    await connect();
  } catch (error) { $("gate-status").textContent = error.message; }
  finally { $("login-button").disabled = false; }
});
$("connection-retry").addEventListener("click", connect);
$("dismiss-error").addEventListener("click", () => showError(""));
$("open-history").addEventListener("click", () => sidebar(true));
$("close-history").addEventListener("click", () => { sidebar(false); $("open-history").focus(); });
$("sidebar-shade").addEventListener("click", () => sidebar(false));
$("context-toggle").addEventListener("click", () => contextPanel($("context-panel").hidden));
$("context-input").addEventListener("input", () => { state.contexts.set(key(), $("context-input").value); controls(); });
$("context-save").addEventListener("click", () => saveContext());
$("context-clear").addEventListener("click", () => saveContext(true));
$("message-input").addEventListener("input", () => { state.drafts.set(key(), $("message-input").value); growInput(); controls(); });
$("message-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
$("composer").addEventListener("submit", sendMessage);
$("stop").addEventListener("click", () => {
  if (!state.stream) return;
  state.stream.stopping = true;
  state.stream.controller.abort();
  controls();
});
$("refresh").addEventListener("click", () => action(async () => {
  rememberInputs();
  await loadHistory();
  if (state.chat) {
    const { chat } = await api("GET", chatURL());
    setChat(chat);
  }
}));
$("new-chat").addEventListener("click", () => {
  if (locked()) return;
  action(async () => {
    rememberInputs();
    setChat(null); // the chat is created when you send the first message
    sidebar(false);
  }).then(() => $("message-input").focus());
});
$("logout").addEventListener("click", () => {
  if (locked()) return;
  if (hasDrafts()) {
    if (!window.confirm("Log out and discard your unsent drafts and unsaved context changes? Saved conversations will stay.")) return;
  }
  action(async () => {
    await api("POST", "/api/logout");
    state.authed = false; state.chat = null; state.chats = [];
    state.drafts.clear(); state.contexts.clear();
    setChat(null); sidebar(false); contextPanel(false);
    showGate(); $("passcode").focus();
  });
});
function openDialog(kind) {
  if (locked() || !state.chat) return;
  state.dialogAction = kind;
  const rename = kind === "rename";
  $("dialog-title").textContent = rename ? "Rename conversation" : "Delete conversation?";
  $("dialog-description").textContent = rename ? "Give this exploration a name you can find later." : `“${state.chat.title || "Untitled conversation"}” and its messages will be deleted. This can't be undone.`;
  $("rename-label").hidden = !rename;
  $("rename-input").hidden = !rename;
  $("rename-input").required = rename;
  $("rename-input").value = state.chat.title || "";
  $("dialog-confirm").textContent = rename ? "Save name" : "Delete conversation";
  $("dialog-confirm").classList.toggle("destructive", !rename);
  $("action-dialog").showModal();
  if (rename) $("rename-input").select();
  else $("dialog-cancel").focus();
}
$("rename").addEventListener("click", () => openDialog("rename"));
$("delete").addEventListener("click", () => openDialog("delete"));
$("dialog-cancel").addEventListener("click", () => $("action-dialog").close());
$("action-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (locked() || !state.chat) return;
  const kind = state.dialogAction;
  const title = $("rename-input").value.trim();
  if (kind === "rename" && !title) { $("rename-input").focus(); return; }
  $("action-dialog").close();
  action(async () => {
    if (kind === "rename") {
      const { chat } = await api("POST", `${chatURL()}/title`, { title });
      updateChat(chat);
    } else {
      const id = state.chat.id;
      await api("POST", `${chatURL()}/delete`);
      state.drafts.delete(id); state.contexts.delete(id);
      state.chats = state.chats.filter((chat) => chat.id !== id);
      setChat(null);
    }
  });
});
$("help-btn").addEventListener("click", () => { $("help").hidden = !$("help").hidden; });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!$("help").hidden) { $("help").hidden = true; return; }
    if ($("sidebar").classList.contains("open")) { sidebar(false); return; }
    if (!$("context-panel").hidden) contextPanel(false);
    return;
  }
  const typing = /^(INPUT|TEXTAREA)$/.test(event.target.tagName) || event.target.isContentEditable;
  if (typing || $("action-dialog").open) return;
  if (event.key === "?") $("help").hidden = !$("help").hidden;
  else if (event.key === "c") contextPanel($("context-panel").hidden);
  else if (event.key === "n") $("new-chat").click();
});
window.addEventListener("beforeunload", (event) => {
  if (state.stream || hasDrafts()) {
    event.preventDefault(); event.returnValue = "";
  }
});
connect();

// Time tracking (web/time.js): an open chat counts toward the file it's about.
window.learnTimeKey = () => (state.chat?.id ? `chat:${state.chat.id}` : null);
