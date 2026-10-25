// DeepSeek client (OpenAI-compatible chat API), server-side only.
// The key comes from the environment (systemd EnvironmentFile) and is never
// logged or sent to the browser. Every call is checked against a daily token
// budget and a per-day call cap before it goes out.
import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";

const API = process.env.LEARN_AI_API ?? "https://api.deepseek.com/chat/completions";
const MODEL = process.env.LEARN_AI_MODEL ?? "deepseek-chat";
const DAILY_TOKENS = Number(process.env.LEARN_AI_DAILY_TOKENS ?? 800_000);
const DAILY_CALLS = Number(process.env.LEARN_AI_DAILY_CALLS ?? 200);
const MAX_INFLIGHT = 3;

export class BudgetError extends Error {}

export function createLLM({ dataDir, today }) {
  const usageFile = path.join(dataDir, "usage.json");
  let usage = {};
  try { usage = JSON.parse(readFileSync(usageFile, "utf8")); } catch {}
  let inflight = 0;

  const day = () => (usage[today()] ??= { calls: 0, prompt: 0, completion: 0 });
  const save = async () => {
    const tmp = `${usageFile}.tmp`;
    await writeFile(tmp, JSON.stringify(usage, null, 1), { mode: 0o600 });
    await rename(tmp, usageFile);
  };

  function status() {
    const d = day();
    return { model: MODEL, today: { calls: d.calls, tokens: d.prompt + d.completion }, limits: { tokens: DAILY_TOKENS, calls: DAILY_CALLS } };
  }

  // messages: [{role, content}]; json: ask for a JSON object back.
  async function chat(messages, { json = false, maxTokens = 2000, temperature = 0.4 } = {}) {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error("AI is not configured (no API key in the environment)");
    const d = day();
    if (d.calls >= DAILY_CALLS) throw new BudgetError(`daily AI call cap reached (${DAILY_CALLS}); resets at midnight`);
    if (d.prompt + d.completion >= DAILY_TOKENS) throw new BudgetError(`daily AI token budget reached (${DAILY_TOKENS}); resets at midnight`);
    if (inflight >= MAX_INFLIGHT) throw new BudgetError("too many AI requests at once; try again in a moment");
    inflight++;
    d.calls++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 240_000);
    try {
      const body = { model: MODEL, messages, max_tokens: maxTokens, temperature, stream: false };
      if (json) body.response_format = { type: "json_object" };
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`AI request failed: HTTP ${res.status} ${text.slice(0, 200).replace(/sk-[A-Za-z0-9]+/g, "sk-…")}`);
      const data = JSON.parse(text);
      d.prompt += data.usage?.prompt_tokens ?? 0;
      d.completion += data.usage?.completion_tokens ?? 0;
      const content = data.choices?.[0]?.message?.content ?? "";
      if (!json) return content;
      return parseJSON(content);
    } finally {
      clearTimeout(timer);
      inflight--;
      save().catch(() => {});
    }
  }

  // Streaming chat: calls onDelta(text) for each chunk and resolves with the
  // full reply. Same budget checks as chat(). Pass an AbortSignal to stop early
  // (the partial text is returned, and usage is estimated if the API did not
  // report it).
  async function stream(messages, { maxTokens = 1500, temperature = 0.6, onDelta = () => {}, signal } = {}) {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error("AI is not configured (no API key in the environment)");
    const d = day();
    if (d.calls >= DAILY_CALLS) throw new BudgetError(`daily AI call cap reached (${DAILY_CALLS}); resets at midnight`);
    if (d.prompt + d.completion >= DAILY_TOKENS) throw new BudgetError(`daily AI token budget reached (${DAILY_TOKENS}); resets at midnight`);
    if (inflight >= MAX_INFLIGHT) throw new BudgetError("too many AI requests at once; try again in a moment");
    inflight++;
    d.calls++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 240_000);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    let full = "", usageSeen = false, stopped = false;
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature, stream: true, stream_options: { include_usage: true } }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`AI request failed: HTTP ${res.status} ${text.slice(0, 200).replace(/sk-[A-Za-z0-9]+/g, "sk-…")}`);
      }
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }
          if (ev.usage) {
            usageSeen = true;
            d.prompt += ev.usage.prompt_tokens ?? 0;
            d.completion += ev.usage.completion_tokens ?? 0;
          }
          const t = ev.choices?.[0]?.delta?.content;
          if (t) { full += t; onDelta(t); }
        }
      }
    } catch (e) {
      if (!(signal?.aborted && e.name === "AbortError")) throw e;
      stopped = true;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      inflight--;
      if (!usageSeen) {
        // Rough estimate (about 3.5 chars per token) so stops still count.
        d.prompt += Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3.5);
        d.completion += Math.ceil(full.length / 3.5);
      }
      save().catch(() => {});
    }
    return { text: full, stopped };
  }

  return { chat, stream, status };
}

export function parseJSON(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("AI returned malformed JSON");
}
