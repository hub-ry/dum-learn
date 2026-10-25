// Safe file operations on the learn content root (~/learn), used by the
// command box. Everything here treats paths as untrusted (they come from the
// AI): every path is "tab/..." with plain-name segments, must stay inside an
// existing tab folder, can't pass through a symlink, and files must have a
// whitelisted extension. Nothing is ever overwritten and nothing is deleted:
// "delete" moves into a trash folder outside the content root so it can be
// undone. Root-level files (learn.sty) and the tabs themselves can't be
// touched.
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, rmdir } from "node:fs/promises";
import path from "node:path";

export class FsError extends Error {}
const bad = (msg) => { throw new FsError(msg); };

export const FILE_EXT = new Set([".tex", ".pdf", ".py", ".md", ".txt", ".c", ".h", ".cpp", ".hpp", ".cc", ".sh", ".js", ".ts", ".json", ".csv", ".java", ".go", ".rs", ".sql"]);
const SEG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
const MAX_DEPTH = 8;

export function createFiles({ root, trash }) {
  let rootReal = null;
  const base = async () => (rootReal ??= await realpath(root));

  // "ai//OS/" -> "ai/OS"; throws on anything that isn't a plain relative path.
  function norm(p, { tabOk = false } = {}) {
    if (typeof p !== "string") bad("path must be text");
    const s = p.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
    if (!s) bad("empty path");
    const segs = s.split("/");
    if (segs.length > MAX_DEPTH) bad(`too deep: ${s}`);
    for (const seg of segs) {
      if (seg === "." || seg === ".." || !SEG.test(seg) || seg.endsWith(".")) bad(`not an allowed path: ${s}`);
    }
    if (segs.length < 2 && !tabOk) bad(`${s} is a tab; tabs can't be changed`);
    return segs.join("/");
  }

  async function tabs() {
    const r = await base();
    return (await readdir(r, { withFileTypes: true })).filter((e) => e.isDirectory() && !/^[._]/.test(e.name)).map((e) => e.name).sort();
  }

  // Walks the path one component at a time from the real root, refusing
  // symlinks, so nothing can escape ~/learn. Returns what's there.
  async function inspect(rel) {
    const r = await base();
    const segs = rel.split("/");
    if (!(await tabs()).includes(segs[0])) bad(`no tab called ${segs[0]}`);
    let cur = r, missingFrom = -1;
    for (let i = 0; i < segs.length; i++) {
      cur = path.join(cur, segs[i]);
      let st;
      try { st = await lstat(cur); } catch { missingFrom = i; break; }
      if (st.isSymbolicLink()) bad(`${segs.slice(0, i + 1).join("/")} is a link; links aren't allowed`);
      if (i < segs.length - 1 && !st.isDirectory()) bad(`${segs.slice(0, i + 1).join("/")} is a file, not a folder`);
    }
    const full = path.join(r, ...segs);
    if (!full.startsWith(r + path.sep)) bad("outside the learn folder");
    if (missingFrom >= 0) return { rel, full, exists: false, missingFrom };
    const st = await lstat(full);
    return { rel, full, exists: true, dir: st.isDirectory(), file: st.isFile() };
  }

  const checkExt = (rel) => {
    const ext = path.extname(rel).toLowerCase();
    if (!FILE_EXT.has(ext)) bad(`${path.basename(rel)}: only ${[...FILE_EXT].join(" ")} files can be changed`);
    return ext;
  };

  // mkdir -p, returning the folders it created (top-most first) for undo.
  async function ensureDir(rel) {
    const info = await inspect(rel);
    if (info.exists) { if (!info.dir) bad(`${rel} is a file`); return []; }
    const segs = rel.split("/");
    const created = [];
    for (let i = info.missingFrom; i < segs.length; i++) created.push(segs.slice(0, i + 1).join("/"));
    await mkdir(info.full, { recursive: true });
    return created;
  }
  async function removeEmptyDirs(created) {
    for (const rel of [...created].reverse()) {
      const info = await inspect(rel).catch(() => null);
      if (info?.exists && info.dir && !(await readdir(info.full)).length) await rmdir(info.full);
    }
  }

  async function makeDir(p) {
    const rel = norm(p);
    const info = await inspect(rel);
    if (info.exists) bad(`${rel} already exists`);
    const created = await ensureDir(rel);
    return { text: `made folder ${rel}/`, undo: { op: "rmdirs", created }, changed: true };
  }

  // Move or rename a file or folder. "to" may be an existing folder (move
  // into it). Files keep their extension; a .tex takes its stale .pdf along.
  async function move(fromP, toP) {
    const from = norm(fromP), info = await inspect(from);
    if (!info.exists) bad(`${from} doesn't exist`);
    if (!info.dir && !info.file) bad(`${from} isn't a file or folder`);
    let to = norm(toP);
    const dest0 = await inspect(to);
    if (dest0.exists && dest0.dir) to = `${to}/${path.basename(from)}`;
    if (info.file) {
      const ext = checkExt(from);
      if (!path.extname(to)) to += ext;
      if (path.extname(to).toLowerCase() !== ext) bad(`keep the ${ext} extension (${path.basename(to)})`);
    } else if (to === from || to.startsWith(`${from}/`)) bad("can't move a folder into itself");
    if (to === from) bad("that's where it already is");
    const dest = await inspect(to);
    if (dest.exists) bad(`${to} already exists; nothing was overwritten`);
    const created = await ensureDir(path.posix.dirname(to));
    await rename(info.full, dest.full);
    const extra = [];
    if (info.file && from.endsWith(".tex")) {
      const pdfFrom = info.full.replace(/\.tex$/, ".pdf"), pdfTo = dest.full.replace(/\.tex$/, ".pdf");
      if (existsSync(pdfFrom) && !existsSync(pdfTo) && !(await lstat(pdfFrom)).isSymbolicLink()) { await rename(pdfFrom, pdfTo); extra.push([pdfFrom, pdfTo]); }
    }
    return { text: `moved ${from} \u2192 ${to}`, from, to, dir: !!info.dir, undo: { op: "move", from, to, extra, created }, changed: true };
  }

  async function trashItem(p) {
    const rel = norm(p), info = await inspect(rel);
    if (!info.exists) bad(`${rel} doesn't exist`);
    if (info.file) checkExt(rel);
    const slot = path.join(trash, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(slot, { recursive: true, mode: 0o700 });
    const dest = path.join(slot, path.basename(rel));
    await rename(info.full, dest);
    return { text: `deleted ${rel}${info.dir ? "/" : ""} (kept in trash; undo brings it back)`, undo: { op: "restore", rel, trashed: dest }, changed: true };
  }

  async function undoStep(u) {
    if (u.op === "rmdirs") {
      for (const rel of [...u.created].reverse()) {
        const info = await inspect(rel).catch(() => null);
        if (info?.exists && info.dir) {
          if ((await readdir(info.full)).length) bad(`${rel}/ isn't empty any more, so it was left in place`);
          await rmdir(info.full);
        }
      }
      return `removed folder ${u.created[0] ?? ""}/`;
    }
    if (u.op === "move") {
      const back = await inspect(u.from), cur = await inspect(u.to);
      if (!cur.exists) bad(`${u.to} isn't there any more`);
      if (back.exists) bad(`${u.from} exists again; not overwriting it`);
      await ensureDir(path.posix.dirname(u.from));
      await rename(cur.full, back.full);
      for (const [a, b] of u.extra ?? []) if (existsSync(b) && !existsSync(a)) await rename(b, a);
      await removeEmptyDirs(u.created ?? []);
      return `moved ${u.to} back to ${u.from}`;
    }
    if (u.op === "restore") {
      const info = await inspect(u.rel);
      if (info.exists) bad(`${u.rel} exists again; not overwriting it`);
      if (!existsSync(u.trashed)) bad("it's no longer in the trash");
      await ensureDir(path.posix.dirname(u.rel));
      await rename(u.trashed, info.full);
      return `restored ${u.rel}`;
    }
    bad(`can't undo ${u.op}`);
  }

  // Every folder (relative to its tab) and file, for the AI's listing.
  async function tree() {
    const r = await base();
    const out = [];
    async function walk(dir, rel) {
      for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (/^[._]/.test(e.name) || e.name === "__pycache__" || e.isSymbolicLink()) continue;
        const p = `${rel}/${e.name}`;
        if (e.isDirectory()) { out.push({ path: p, dir: true }); if (out.length < 600) await walk(path.join(dir, e.name), p); }
        else if (e.isFile() && FILE_EXT.has(path.extname(e.name).toLowerCase())) out.push({ path: p });
      }
    }
    for (const t of await tabs()) await walk(path.join(r, t), t);
    return out;
  }

  return { norm, inspect, tabs, ensureDir, makeDir, move, trashItem, undoStep, tree, checkExt };
}
