// Learning buckets: map of topics Ryan has to learn (Ishaan-style), with
 // subtopic status, unknowns, tasks, and links to leetcode tags / folders.
 // Stored under LEARN_DATA (mode 600); API is passcode-gated like leetcode.
import { readFile, writeFile, rename, chmod, access } from "node:fs/promises";
import path from "node:path";

const STATUSES = new Set(["not_started", "unverified", "learning", "shaky", "solid"]);
const CATEGORIES = new Set(["dsa", "course", "systems", "other"]);
const STATUS_LABEL = {
  not_started: "not started",
  unverified: "unverified",
  learning: "learning",
  shaky: "shaky",
  solid: "solid",
};

function emptyState() {
  return { version: 1, focusId: null, buckets: [], checks: {}, seededAt: null };
}

export async function createBucketsLibrary({
  dataDir, contentRoot, readManifest, leetcodeSnapshot, lessonsOf, locked, id, HttpError, now,
}) {
  const store = path.join(dataDir, "buckets.json");
  const seedPaths = [
    path.join(dataDir, "buckets-seed.json"),
    path.join(path.dirname(new URL(import.meta.url).pathname), "buckets-seed.json"),
  ];
  const fail = (message) => { throw new HttpError(400, message); };

  function text(value, field, max, required = false) {
    if (typeof value !== "string" || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
      fail(`${field} must be text, at most ${max} characters`);
    }
    const out = value.trim();
    if (required && !out) fail(`${field} is required`);
    return out;
  }

  function statusOf(value, field = "status") {
    const s = String(value ?? "not_started").trim().toLowerCase().replace(/\s+/g, "_");
    const aliases = { "not-started": "not_started", todo: "not_started", assumed: "unverified", known: "unverified", "assumed_known": "unverified", weak: "shaky", in_progress: "learning", "in-progress": "learning" };
    // Seed/past material uses unverified — never map "done" to solid automatically.
    const mapped = aliases[s] ?? s;
    if (!STATUSES.has(mapped)) fail(`${field} must be one of: not started, unverified, learning, shaky, solid`);
    return mapped;
  }

  function categoryOf(value) {
    const c = String(value ?? "other").trim().toLowerCase();
    if (!CATEGORIES.has(c)) fail("category must be dsa, course, systems, or other");
    return c;
  }

  function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "bucket";
  }

  function makeSubtopic(name, status = "not_started") {
    return {
      id: id(6),
      name: text(name, "subtopic", 200, true),
      status: statusOf(status, "subtopic status"),
      notes: "",
    };
  }

  function makeUnknown(textIn) {
    return { id: id(6), text: text(textIn, "unknown", 2000, true), created: now() };
  }

  function makeTask(textIn, done = false) {
    return {
      id: id(6),
      text: text(textIn, "task", 500, true),
      done: !!done,
      kind: "task",
      created: now(),
    };
  }

  function makeBucket(input, { seeded = false } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("bucket must be an object");
    const name = text(input.name, "name", 120, true);
    const subs = Array.isArray(input.subtopics) ? input.subtopics : [];
    const subtopics = subs.map((s) => {
      if (typeof s === "string") {
        const st = seeded ? statusOf(input.defaultStatus ?? "not_started") : "not_started";
        return makeSubtopic(s, st === "solid" && seeded ? "unverified" : st);
      }
      let st = statusOf(s.status ?? input.defaultStatus ?? "not_started");
      // Seed never proves mastery — solid from a seed file becomes unverified.
      if (seeded && st === "solid") st = "unverified";
      return makeSubtopic(s.name ?? s.title, st);
    });
    const tags = Array.isArray(input.tags) ? input.tags.map((t) => text(String(t), "tag", 80, true)).filter(Boolean) : [];
    const linkTags = Array.isArray(input.linkTags) ? input.linkTags.map((t) => text(String(t), "linkTag", 80, true)) : [...tags];
    const linkFolders = Array.isArray(input.linkFolders) ? input.linkFolders.map((t) => text(String(t), "folder", 120, true)) : [];
    const problems = normalizeProblems(input.problems);
    return {
      id: id(8),
      name,
      slug: slugify(name),
      category: categoryOf(input.category ?? "other"),
      description: text(String(input.description ?? ""), "description", 2000),
      tags,
      linkTags,
      linkFolders,
      problems,
      status: "not_started", // aggregate derived on read; never guess mastery at seed
      focus: false,
      subtopics,
      unknowns: [],
      tasks: [],
      seeded: !!seeded,
      created: now(),
      updated: now(),
    };
  }

  function normalizeProblems(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const p of list) {
      if (!p || typeof p !== "object") continue;
      const slug = text(String(p.slug ?? p.id ?? ""), "problem slug", 120).replace(/^\d+-/, "") || slugify(String(p.name ?? p.title ?? ""));
      const name = text(String(p.name ?? p.title ?? slug), "problem name", 160, true);
      if (!name) continue;
      const url = text(String(p.url ?? (slug ? `https://leetcode.com/problems/${slug}/` : "")), "problem url", 300);
      const key = (slug || name).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        slug: slug || slugify(name),
        url: url || `https://leetcode.com/problems/${slugify(name)}/`,
        subtopics: Array.isArray(p.subtopics) ? p.subtopics.map((s) => text(String(s), "problem subtopic", 120, true)).filter(Boolean) : [],
      });
    }
    return out;
  }

  let state = emptyState();
  try {
    const raw = JSON.parse(await readFile(store, "utf8"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.buckets)) throw new Error("bad shape");
    state = { ...emptyState(), ...raw, buckets: raw.buckets, checks: raw.checks && typeof raw.checks === "object" ? raw.checks : {} };
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`Invalid ${store}; repair or restore it before restarting: ${e.message}`);
  }

  const planPath = path.join(dataDir, "buckets-plan.json");

  function planPayload() {
    return {
      updated: now(),
      focusId: state.focusId,
      privacy: "Topic names and statuses only. No grades, scores, or GPA.",
      buckets: state.buckets.map((b) => ({
        id: b.id,
        name: b.name,
        slug: b.slug,
        category: b.category,
        status: aggregateStatus(b),
        focus: state.focusId === b.id,
        tags: b.tags,
        subtopics: b.subtopics.map((s) => ({ id: s.id, name: s.name, status: s.status })),
        unknowns: b.unknowns.map((u) => ({ id: u.id, text: u.text, created: u.created })),
        tasks: b.tasks.map((t) => ({ id: t.id, text: t.text, done: !!t.done })),
        progress: progressOf(b),
        solvedCount: Array.isArray(b.problems) ? b.problems.length : 0,
        problems: Array.isArray(b.problems) ? b.problems.map((p) => ({ name: p.name, slug: p.slug, url: p.url, subtopics: p.subtopics || [] })) : [],
      })),
    };
  }

  async function writePlan() {
    const payload = planPayload();
    const tmp = `${planPath}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, planPath);
    return payload;
  }

  async function commit(next) {
    const tmp = `${store}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, store);
    state = next;
    await writePlan().catch((e) => console.error("buckets-plan write failed:", e.message));
  }

  function findBucket(ref) {
    const q = String(ref ?? "").trim().toLowerCase();
    if (!q) return null;
    return state.buckets.find((b) => b.id === ref)
      || state.buckets.find((b) => b.slug === q)
      || state.buckets.find((b) => b.name.toLowerCase() === q)
      || state.buckets.find((b) => b.name.toLowerCase().includes(q) || b.tags.some((t) => t.toLowerCase() === q));
  }

  function findSubtopic(bucket, ref) {
    const q = String(ref ?? "").trim().toLowerCase();
    if (!q) return null;
    return bucket.subtopics.find((s) => s.id === ref)
      || bucket.subtopics.find((s) => s.name.toLowerCase() === q)
      || bucket.subtopics.find((s) => s.name.toLowerCase().includes(q));
  }

  function aggregateStatus(bucket) {
    const ss = bucket.subtopics.map((s) => s.status);
    if (!ss.length) return bucket.status || "not_started";
    if (ss.every((s) => s === "solid")) return "solid";
    if (ss.every((s) => s === "unverified")) return "unverified";
    if (ss.every((s) => s === "not_started" || s === "unverified")) {
      // Any touched (unverified) subtopic means the bucket is unverified overall.
      return ss.some((s) => s === "unverified") ? "unverified" : "not_started";
    }
    if (ss.some((s) => s === "shaky")) return "shaky";
    if (ss.some((s) => s === "learning" || s === "solid")) return "learning";
    return "learning";
  }

  function progressOf(bucket) {
    const total = bucket.subtopics.length || 1;
    const weight = { not_started: 0, unverified: 0, learning: 0.35, shaky: 0.5, solid: 1 };
    const sum = bucket.subtopics.reduce((a, s) => a + (weight[s.status] ?? 0), 0);
    const tasksDone = bucket.tasks.filter((t) => t.done).length;
    const tasksTotal = bucket.tasks.length;
    return {
      subtopicsSolid: bucket.subtopics.filter((s) => s.status === "solid").length,
      subtopicsTotal: bucket.subtopics.length,
      percent: Math.round((sum / total) * 100),
      tasksDone,
      tasksTotal,
      unknowns: bucket.unknowns.length,
    };
  }

  async function countsFor(bucket) {
    let problems = Array.isArray(bucket.problems) ? bucket.problems.length : 0;
    let explainers = 0;
    let folders = 0;
    let materials = 0;
    try {
      if (!problems) {
        const lc = await leetcodeSnapshot();
        const tagSet = new Set((bucket.linkTags || []).map((t) => t.toLowerCase()));
        if (tagSet.size) {
          problems = (lc.problems || []).filter((p) => (p.tags || []).some((t) => tagSet.has(String(t).toLowerCase()))).length;
        }
      }
    } catch {}
    try {
      const lessons = lessonsOf?.() ?? [];
      const topics = new Set([bucket.name, ...(bucket.tags || []), ...(bucket.linkTags || [])].map((t) => String(t).toLowerCase()));
      explainers = lessons.filter((l) => {
        const topic = String(l.topic ?? "").toLowerCase();
        const title = String(l.title ?? "").toLowerCase();
        const folder = String(l.folder ?? "").toLowerCase();
        return [...topics].some((t) => t && (topic.includes(t) || title.includes(t) || folder.includes(t.replace(/\s+/g, "-"))));
      }).length;
    } catch {}
    try {
      const man = await readManifest();
      const folderHints = new Set((bucket.linkFolders || []).map((f) => f.toLowerCase()));
      for (const tab of man.tabs || []) {
        const tname = String(tab.name || "").toLowerCase();
        if (folderHints.has(tname) || [...folderHints].some((f) => tname.includes(f))) {
          folders += 1;
          materials += (tab.items || []).length;
        }
        for (const it of tab.items || []) {
          const p = `${tab.name}/${it.path}`.toLowerCase();
          if ([...(bucket.linkFolders || []), ...(bucket.tags || [])].some((f) => p.includes(String(f).toLowerCase().replace(/\s+/g, "-")))) {
            materials += 1;
          }
        }
      }
    } catch {}
    return { problems, explainers, folders, materials };
  }

  async function publicBucket(b) {
    const progress = progressOf(b);
    const links = await countsFor(b);
    return {
      ...b,
      status: aggregateStatus(b),
      focus: state.focusId === b.id,
      progress,
      links,
      statusLabel: STATUS_LABEL[aggregateStatus(b)],
    };
  }

  async function snapshot() {
    const buckets = [];
    for (const b of state.buckets) buckets.push(await publicBucket(b));
    return {
      focusId: state.focusId,
      seededAt: state.seededAt,
      statuses: [...STATUSES],
      categories: [...CATEGORIES],
      buckets,
    };
  }

  async function ensureSeeded() {
    if (state.buckets.length) return snapshot();
    let seed = null;
    for (const p of seedPaths) {
      try {
        seed = JSON.parse(await readFile(p, "utf8"));
        break;
      } catch {}
    }
    if (!seed?.buckets?.length) {
      // Minimal DSA-only fallback (no course personal data).
      seed = {
        buckets: [
          { name: "Dynamic Programming", category: "dsa", tags: ["DP"], description: "Ishaan-style DP bucket.", subtopics: ["State", "Recurrence", "1-D DP", "Multi-dimensional DP"], linkTags: ["DP"] },
          { name: "Stack and queue", category: "dsa", tags: ["Stack"], subtopics: ["Stack basics", "Queue"], linkTags: ["Stack"] },
          { name: "Graphs", category: "dsa", tags: ["BFS", "DFS", "Graph"], subtopics: ["BFS", "DFS", "Visited state"], linkTags: ["BFS", "DFS", "Graph"] },
        ],
      };
    }
    const buckets = seed.buckets.map((b) => makeBucket(b, { seeded: true }));
    await commit({ version: 1, focusId: null, buckets, seededAt: now() });
    return snapshot();
  }

  async function create(input) {
    return locked(async () => {
      await ensureSeeded();
      const b = makeBucket(input, { seeded: false });
      if (state.buckets.some((x) => x.slug === b.slug)) fail(`a bucket named "${b.name}" already exists`);
      await commit({ ...state, buckets: [...state.buckets, b] });
      return snapshot();
    });
  }

  async function update(bid, input) {
    return locked(async () => {
      const i = state.buckets.findIndex((b) => b.id === bid);
      if (i < 0) fail("bucket not found");
      const prev = state.buckets[i];
      const next = { ...prev };
      if (input.name != null) { next.name = text(input.name, "name", 120, true); next.slug = slugify(next.name); }
      if (input.description != null) next.description = text(String(input.description), "description", 2000);
      if (input.category != null) next.category = categoryOf(input.category);
      if (Array.isArray(input.tags)) next.tags = input.tags.map((t) => text(String(t), "tag", 80, true));
      if (Array.isArray(input.linkTags)) next.linkTags = input.linkTags.map((t) => text(String(t), "linkTag", 80, true));
      if (Array.isArray(input.linkFolders)) next.linkFolders = input.linkFolders.map((t) => text(String(t), "folder", 120, true));
      if (input.status != null) {
        // Setting bucket status applies to all not_started subtopics only when marking learning; otherwise leave subtopics.
        // Prefer explicit subtopic updates. If they set bucket-level, apply to every subtopic.
        const st = statusOf(input.status);
        next.subtopics = next.subtopics.map((s) => ({ ...s, status: st }));
      }
      next.updated = now();
      const buckets = [...state.buckets];
      buckets[i] = next;
      await commit({ ...state, buckets });
      return snapshot();
    });
  }

  async function remove(bid) {
    return locked(async () => {
      const buckets = state.buckets.filter((b) => b.id !== bid);
      if (buckets.length === state.buckets.length) fail("bucket not found");
      const focusId = state.focusId === bid ? null : state.focusId;
      await commit({ ...state, buckets, focusId });
      return snapshot();
    });
  }

  async function setFocus(ref) {
    return locked(async () => {
      await ensureSeeded();
      if (ref == null || ref === "" || ref === false) {
        await commit({ ...state, focusId: null });
        return snapshot();
      }
      const b = findBucket(ref);
      if (!b) fail(`no bucket matching "${ref}"`);
      await commit({ ...state, focusId: b.id });
      return snapshot();
    });
  }

  async function addSubtopic(ref, name, status = "not_started") {
    return locked(async () => {
      await ensureSeeded();
      const b = findBucket(ref);
      if (!b) fail(`no bucket matching "${ref}"`);
      if (b.subtopics.some((s) => s.name.toLowerCase() === String(name).trim().toLowerCase())) {
        fail(`subtopic "${name}" already in ${b.name}`);
      }
      const sub = makeSubtopic(name, status);
      const buckets = state.buckets.map((x) => x.id === b.id
        ? { ...x, subtopics: [...x.subtopics, sub], updated: now() }
        : x);
      await commit({ ...state, buckets });
      return snapshot();
    });
  }

  async function setSubtopicStatus(bucketRef, subRef, status) {
    return locked(async () => {
      await ensureSeeded();
      const b = findBucket(bucketRef);
      if (!b) fail(`no bucket matching "${bucketRef}"`);
      const st = statusOf(status);
      let sub = findSubtopic(b, subRef);
      if (!sub && subRef && String(subRef).toLowerCase() === String(b.name).toLowerCase()) {
        // Mark all subtopics / bucket-level shorthand
        const buckets = state.buckets.map((x) => x.id === b.id
          ? { ...x, subtopics: x.subtopics.map((s) => ({ ...s, status: st })), updated: now() }
          : x);
        await commit({ ...state, buckets });
        return snapshot();
      }
      if (!sub) {
        // Allow "mark sliding window solid" where sliding window is a bucket name
        const asBucket = findBucket(subRef);
        if (asBucket && !bucketRef) {
          const buckets = state.buckets.map((x) => x.id === asBucket.id
            ? { ...x, subtopics: x.subtopics.map((s) => ({ ...s, status: st })), updated: now() }
            : x);
          await commit({ ...state, buckets });
          return snapshot();
        }
        fail(`no subtopic matching "${subRef}" in ${b.name}`);
      }
      const buckets = state.buckets.map((x) => {
        if (x.id !== b.id) return x;
        return {
          ...x,
          updated: now(),
          subtopics: x.subtopics.map((s) => s.id === sub.id ? { ...s, status: st } : s),
        };
      });
      await commit({ ...state, buckets });
      return snapshot();
    });
  }

  async function addUnknown(ref, textIn) {
    return locked(async () => {
      await ensureSeeded();
      const b = findBucket(ref);
      if (!b) fail(`no bucket matching "${ref}"`);
      const u = makeUnknown(textIn);
      const buckets = state.buckets.map((x) => x.id === b.id
        ? { ...x, unknowns: [...x.unknowns, u], updated: now() }
        : x);
      await commit({ ...state, buckets });
      return snapshot();
    });
  }

  async function removeUnknown(bid, uid) {
    return locked(async () => {
      const buckets = state.buckets.map((x) => x.id === bid
        ? { ...x, unknowns: x.unknowns.filter((u) => u.id !== uid), updated: now() }
        : x);
      await commit({ ...state, buckets });
      return snapshot();
    });
  }

  async function addTask(ref, textIn, done = false) {
    return locked(async () => {
      await ensureSeeded();
      const b = findBucket(ref);
      if (!b) fail(`no bucket matching "${ref}"`);
      const t = makeTask(textIn, done);
      const buckets = state.buckets.map((x) => x.id === b.id
        ? { ...x, tasks: [...x.tasks, t], updated: now() }
        : x);
      await commit({ ...state, buckets });
      return snapshot();
    });
  }

  async function setTaskDone(bid, tid, done) {
    return locked(async () => {
      const buckets = state.buckets.map((x) => {
        if (x.id !== bid) return x;
        return {
          ...x,
          updated: now(),
          tasks: x.tasks.map((t) => t.id === tid ? { ...t, done: !!done } : t),
        };
      });
      await commit({ ...state, buckets });
      return snapshot();
    });
  }

  /** Suggest a bucket for a free-text prompt (ask box / chat). */
  function suggest(prompt) {
    const q = String(prompt ?? "").toLowerCase();
    if (!q || !state.buckets.length) return null;
    let best = null;
    let bestScore = 0;
    for (const b of state.buckets) {
      let score = 0;
      const names = [b.name, b.slug, ...(b.tags || []), ...(b.linkTags || []), ...b.subtopics.map((s) => s.name)];
      for (const n of names) {
        const t = String(n).toLowerCase();
        if (!t) continue;
        if (q.includes(t)) score += t.length > 3 ? 3 : 1;
        for (const word of t.split(/[^a-z0-9]+/).filter((w) => w.length > 3)) {
          if (q.includes(word)) score += 1;
        }
      }
      if (score > bestScore) { bestScore = score; best = b; }
    }
    if (!best || bestScore < 1) return null;
    return { id: best.id, name: best.name, score: bestScore };
  }


  function pickUnverified(bucket, limit = 4) {
    const pool = bucket.subtopics.filter((s) => s.status === "unverified" || s.status === "not_started" || s.status === "shaky");
    // Prefer unverified for cross-check
    const unver = pool.filter((s) => s.status === "unverified");
    const rest = pool.filter((s) => s.status !== "unverified");
    const ordered = [...unver, ...rest];
    return ordered.slice(0, Math.max(1, Math.min(limit, ordered.length)));
  }

  async function startCheck({ bucketRef, subtopicRef = null, mode = "check", questions = [], subtopicIds = null }) {
    const b = findBucket(bucketRef);
    if (!b) fail(`no bucket matching "${bucketRef}"`);
    let targets;
    if (Array.isArray(subtopicIds) && subtopicIds.length) {
      targets = b.subtopics.filter((s) => subtopicIds.includes(s.id));
    } else if (subtopicRef) {
      const s = findSubtopic(b, subtopicRef);
      if (!s) fail(`no subtopic matching "${subtopicRef}" in ${b.name}`);
      targets = [s];
    } else if (mode === "crosscheck") {
      targets = pickUnverified(b, 4);
      if (!targets.length) fail(`${b.name} has no unverified/not-started/shaky subtopics to cross-check`);
    } else {
      targets = pickUnverified(b, 1);
      if (!targets.length) fail(`${b.name} has nothing to check`);
    }
    if (!Array.isArray(questions) || questions.length < 2) fail("check needs at least 2 diagnostic questions");
    const checkId = id(8);
    const check = {
      id: checkId,
      mode: mode === "crosscheck" ? "crosscheck" : "check",
      bucketId: b.id,
      bucketName: b.name,
      subtopicIds: targets.map((s) => s.id),
      subtopicNames: targets.map((s) => s.name),
      questions: questions.map((q, i) => ({
        id: q.id || id(4),
        n: i + 1,
        text: text(String(q.text ?? q), "question", 2000, true),
        subtopicId: q.subtopicId || targets[i % targets.length].id,
      })),
      status: "open",
      created: now(),
      gradedAt: null,
      result: null,
    };
    const checks = { ...(state.checks || {}), [checkId]: check };
    await commit({ ...state, checks });
    return { check, bucket: await publicBucket(findBucket(b.id)) };
  }

  function getCheck(checkId) {
    const c = state.checks?.[checkId];
    if (!c) fail("check not found");
    return c;
  }

  /** Apply graded outcomes: per-subtopic status + unknowns. Never invent solid without an explicit grade. */
  async function applyCheckGrade(checkId, grade) {
    const c = getCheck(checkId);
    if (c.status === "graded") fail("check already graded");
    const b = state.buckets.find((x) => x.id === c.bucketId);
    if (!b) fail("bucket for this check is gone");
    const bySub = grade?.subtopics;
    if (!bySub || typeof bySub !== "object") fail("grade.subtopics map required");
    const newUnknowns = Array.isArray(grade.unknowns) ? grade.unknowns.map((u) => makeUnknown(typeof u === "string" ? u : u.text)) : [];
    const buckets = state.buckets.map((x) => {
      if (x.id !== b.id) return x;
      const subtopics = x.subtopics.map((s) => {
        if (!c.subtopicIds.includes(s.id)) return s;
        const g = bySub[s.id] || bySub[s.name];
        if (!g) return s;
        let st = statusOf(g.status ?? g, "grade status");
        // Grading may set solid/shaky/not_started/learning — not unverified (that means untested).
        if (st === "unverified") st = "not_started";
        return { ...s, status: st };
      });
      return {
        ...x,
        updated: now(),
        subtopics,
        unknowns: [...x.unknowns, ...newUnknowns],
      };
    });
    const checks = {
      ...(state.checks || {}),
      [checkId]: {
        ...c,
        status: "graded",
        gradedAt: now(),
        result: {
          summary: text(String(grade.summary ?? ""), "summary", 4000),
          subtopics: bySub,
          unknownCount: newUnknowns.length,
        },
      },
    };
    await commit({ ...state, buckets, checks });
    return { check: state.checks[checkId], snapshot: await snapshot() };
  }

  async function plan() {
    await ensureSeeded();
    return writePlan();
  }

    /** Deterministic NL command helpers used by /api/command before/alongside the LLM. */
  async function applyCommand(op, args = {}) {
    switch (op) {
      case "bucket_create":
        return create({ name: args.name, category: args.category || "dsa", description: args.description || "", tags: args.tags || [], subtopics: args.subtopics || [], linkTags: args.linkTags || args.tags || [] });
      case "bucket_add_subtopic":
        return addSubtopic(args.bucket, args.name, args.status || "not_started");
      case "bucket_status":
        return setSubtopicStatus(args.bucket || args.name, args.subtopic || args.name, args.status);
      case "bucket_focus":
        return setFocus(args.bucket ?? args.name ?? null);
      case "bucket_unknown":
        return addUnknown(args.bucket, args.text);
      case "bucket_task":
        return addTask(args.bucket, args.text, !!args.done);
      case "bucket_delete":
        {
          const b = findBucket(args.bucket || args.name);
          if (!b) fail(`no bucket matching "${args.bucket || args.name}"`);
          return remove(b.id);
        }
      case "bucket_check":
      case "bucket_crosscheck":
        // Server fills questions via LLM, then calls startCheck. Here we only resolve the target.
        {
          const b = findBucket(args.bucket || args.name);
          if (!b) fail(`no bucket matching "${args.bucket || args.name}"`);
          return {
            pendingCheck: {
              mode: op === "bucket_crosscheck" ? "crosscheck" : "check",
              bucketId: b.id,
              bucketName: b.name,
              subtopic: args.subtopic || args.topic || null,
            },
          };
        }
      default:
        fail(`unknown bucket op ${op}`);
    }
  }

  // Seed on first use
  await ensureSeeded();

  return {
    snapshot, create, update, remove, setFocus, addSubtopic, setSubtopicStatus,
    addUnknown, removeUnknown, addTask, setTaskDone, suggest, applyCommand, findBucket, ensureSeeded,
    startCheck, getCheck, applyCheckGrade, plan, planPath, writePlan, pickUnverified,
  };
}

/** Try to parse a plain-English bucket command without the LLM. */
export function parseBucketCommand(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  let m;
  if ((m = t.match(/^make (?:a |an )?(.+?) bucket$/i))) {
    return { op: "bucket_create", name: m[1].trim(), category: /ma\s*265|stat|cs\s*\d|course/i.test(m[1]) ? "course" : "dsa" };
  }
  if ((m = t.match(/^create (?:a |an )?(.+?) bucket$/i))) {
    return { op: "bucket_create", name: m[1].trim(), category: "dsa" };
  }
  if ((m = t.match(/^add (.+?) to (?:the )?(.+?)(?: bucket)?$/i))) {
    return { op: "bucket_add_subtopic", name: m[1].trim(), bucket: m[2].trim() };
  }
  if ((m = t.match(/^mark (.+?) (not started|unverified|learning|shaky|solid)$/i))) {
    return { op: "bucket_status", name: m[1].trim(), subtopic: m[1].trim(), status: m[2].toLowerCase().replace(/\s+/g, "_") };
  }
  if ((m = t.match(/^focus on (.+)$/i))) {
    return { op: "bucket_focus", bucket: m[1].replace(/\s*bucket$/i, "").trim() };
  }
  if ((m = t.match(/^(?:clear|stop) focus$/i))) {
    return { op: "bucket_focus", bucket: null };
  }
  if ((m = t.match(/^unknown(?: for)? (.+?):\s*(.+)$/i))) {
    return { op: "bucket_unknown", bucket: m[1].trim(), text: m[2].trim() };
  }
  if ((m = t.match(/^add unknown to (.+?):\s*(.+)$/i))) {
    return { op: "bucket_unknown", bucket: m[1].trim(), text: m[2].trim() };
  }
  if ((m = t.match(/^task(?: for)? (.+?):\s*(.+)$/i))) {
    return { op: "bucket_task", bucket: m[1].trim(), text: m[2].trim() };
  }
  if ((m = t.match(/^open (?:the )?(.+?) bucket$/i))) {
    return { op: "bucket_open", bucket: m[1].trim() };
  }
  if (/^(show |list |open )?buckets$/i.test(t)) {
    return { op: "bucket_open", bucket: null };
  }
  if ((m = t.match(/^(?:cross\s*-?\s*check|crosscheck)\s+(.+)$/i))) {
    return { op: "bucket_crosscheck", bucket: m[1].replace(/\s*bucket$/i, "").trim() };
  }
  if ((m = t.match(/^check me on (.+)$/i))) {
    return { op: "bucket_check", bucket: m[1].trim(), subtopic: m[1].trim() };
  }
  if ((m = t.match(/^check (?:me )?(?:on )?(.+)$/i))) {
    return { op: "bucket_check", bucket: m[1].replace(/\s*bucket$/i, "").trim(), subtopic: m[1].trim() };
  }
  return null;
}
