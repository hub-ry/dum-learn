// Builds the site into ./dist from the content root (default ~/learn).
//
// Content layout: every visible subfolder of the content root is a tab.
// Inside a tab, .tex files are compiled to PDF with tectonic, PDFs are shown
// as-is, source/text files are shown as code, and anything else is offered as
// a download. Root-level files (like learn.sty) are shared inputs, not pages.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { stampAssets } from "./deploy/stamp.mjs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CONTENT = path.resolve(process.env.LEARN_CONTENT ?? path.join(os.homedir(), "learn"));
const OUT = path.resolve(process.env.LEARN_OUT ?? path.join(HERE, "dist"));
const CACHE = path.join(os.homedir(), ".cache", "learn", "tex");

const TEXT_EXT = new Map([
  [".py", "python"], [".c", "c"], [".h", "c"], [".cpp", "cpp"], [".hpp", "cpp"], [".cc", "cpp"],
  [".rs", "rust"], [".ts", "typescript"], [".sql", "sql"], [".sh", "shell"], [".java", "java"],
  [".go", "go"], [".txt", "text"], [".csv", "text"], [".tex", "latex"], [".sty", "latex"],
]);
// Grammars copied into dist/vendor/hljs; web/app.js loads them on demand.
const HLJS_LANGS = ["python", "c", "cpp", "rust", "typescript", "sql", "bash", "java", "go", "latex", "plaintext"];
const IGNORE_EXT = new Set([".aux", ".log", ".out", ".toc", ".pyc", ".fls", ".fdb_latexmk", ".xdv"]);
const IGNORE_DIR = new Set(["__pycache__", "node_modules"]);

const hidden = (name) => name.startsWith(".") || name.startsWith("_");

async function walk(dir, rel = "", folders = []) {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => !hidden(e.name));
  const files = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!IGNORE_DIR.has(e.name)) { folders.push(relPath); files.push(...(await walk(path.join(dir, e.name), relPath, folders))); }
    } else if (e.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

const TEX_SYMBOLS = {
  alpha: "\u03b1", beta: "\u03b2", gamma: "\u03b3", delta: "\u03b4", epsilon: "\u03b5", theta: "\u03b8", lambda: "\u03bb",
  mu: "\u03bc", pi: "\u03c0", sigma: "\u03c3", tau: "\u03c4", phi: "\u03c6", omega: "\u03c9", Theta: "\u0398", Omega: "\u03a9",
  log: "log", ln: "ln", cdot: "\u00b7", times: "\u00d7", le: "\u2264", leq: "\u2264", ge: "\u2265", geq: "\u2265",
  ne: "\u2260", neq: "\u2260", to: "\u2192", rightarrow: "\u2192", infty: "\u221e", approx: "\u2248", sum: "\u2211",
};
function texTitle(source, fallback) {
  const m = source.match(/\\title\{([^{}]*)\}/);
  if (!m) return fallback;
  // Inline math in titles ($O(1)$, \\(n\\)) is shown as plain text, not raw "$".
  return m[1].replace(/\$([^$]*)\$/g, "$1").replace(/\\([a-zA-Z]+)(?![a-zA-Z])\s*/g, (s, name) => TEX_SYMBOLS[name] ?? s).replace(/\\\(|\\\)/g, "").replace(/\\&/g, "&").replace(/---/g, "\u2014").replace(/--/g, "\u2013")
    .replace(/\\[a-zA-Z]+\s*/g, "").replace(/[{}~]/g, " ").replace(/\s+/g, " ").trim() || fallback;
}

// Compile one .tex file, reusing a cached PDF when nothing it can see changed:
// the file itself, its sibling files, and the shared root-level style files.
async function compileTex(texPath, sharedInputs) {
  const dir = path.dirname(texPath);
  const hash = createHash("sha256");
  hash.update(texPath);
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name);
    if (name.endsWith(".pdf") || !(await stat(full)).isFile()) continue;
    hash.update(name).update(await readFile(full));
  }
  for (const input of sharedInputs) hash.update(input).update(await readFile(input));
  const key = hash.digest("hex").slice(0, 32);
  const cached = path.join(CACHE, `${key}.pdf`);
  if (existsSync(cached)) return cached;

  const tmp = await mkdtemp(path.join(os.tmpdir(), "learn-tex-"));
  try {
    execFileSync("tectonic", ["-Z", `search-path=${CONTENT}`, "--outdir", tmp, path.basename(texPath)], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    process.stderr.write(err.stdout?.toString() ?? "");
    process.stderr.write(err.stderr?.toString() ?? "");
    throw new Error(`LaTeX failed: ${path.relative(CONTENT, texPath)}`);
  }
  await mkdir(CACHE, { recursive: true });
  await copyFile(path.join(tmp, path.basename(texPath, ".tex") + ".pdf"), cached);
  await rm(tmp, { recursive: true, force: true });
  return cached;
}

async function buildTab(tab, sharedInputs) {
  const root = path.join(CONTENT, tab);
  const folders = [];
  const files = await walk(root, "", folders);
  const texSources = new Set(files.filter((f) => f.endsWith(".tex")).map((f) => f.slice(0, -4)));
  const items = [];

  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (IGNORE_EXT.has(ext) || ext === ".md") continue;
    // A PDF next to its .tex is a stale local compile; the .tex is the source.
    if (ext === ".pdf" && texSources.has(rel.slice(0, -4))) continue;

    const src = path.join(root, rel);
    const info = await stat(src);
    const group = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const item = { path: rel, group, title: path.basename(rel), updated: info.mtime.toISOString() };

    if (ext === ".tex") {
      const pdf = await compileTex(src, sharedInputs);
      const outRel = `files/${tab}/${rel.slice(0, -4)}.pdf`;
      await mkdir(path.dirname(path.join(OUT, outRel)), { recursive: true });
      await copyFile(pdf, path.join(OUT, outRel));
      item.kind = "pdf";
      item.title = texTitle(await readFile(src, "utf8"), path.basename(rel, ".tex"));
      item.src = outRel;
      item.source = `files/${tab}/${rel}`; // the .tex itself, for "view source"
      await copyFile(src, path.join(OUT, item.source));
    } else {
      const outRel = `files/${tab}/${rel}`;
      await mkdir(path.dirname(path.join(OUT, outRel)), { recursive: true });
      await copyFile(src, path.join(OUT, outRel));
      item.src = outRel;
      item.size = info.size;
      if (ext === ".pdf") item.kind = "pdf";
      else if (TEXT_EXT.has(ext)) Object.assign(item, { kind: "code", lang: TEXT_EXT.get(ext) });
      else item.kind = "file";
    }
    items.push(item);
  }

  // Top-level documents first, then each folder in name order.
  items.sort((a, b) => (a.group === b.group ? 0 : a.group === "" ? -1 : b.group === "" ? 1 : a.group.localeCompare(b.group)));
  return { name: tab, folders, items };
}

async function main() {
  if (!existsSync(CONTENT)) throw new Error(`content root not found: ${CONTENT}`);
  await rm(OUT, { recursive: true, force: true });
  await cp(path.join(HERE, "web"), OUT, { recursive: true });
  const vendor = path.join(OUT, "vendor");
  await mkdir(vendor, { recursive: true });
  for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
    await copyFile(path.join(HERE, "node_modules/pdfjs-dist/build", f), path.join(vendor, f));
  }
  // highlight.js (ES module build): the core plus only the grammars the site uses.
  const hljsSrc = path.join(HERE, "node_modules/@highlightjs/cdn-assets/es");
  await mkdir(path.join(vendor, "hljs", "languages"), { recursive: true });
  await copyFile(path.join(hljsSrc, "core.min.js"), path.join(vendor, "hljs", "core.min.js"));
  for (const lang of HLJS_LANGS) {
    await copyFile(path.join(hljsSrc, "languages", `${lang}.min.js`), path.join(vendor, "hljs", "languages", `${lang}.min.js`));
  }

  // KaTeX for math in /explore chat replies.
  const katexSrc = path.join(HERE, "node_modules/katex/dist");
  await mkdir(path.join(vendor, "katex", "fonts"), { recursive: true });
  for (const f of ["katex.mjs", "katex.min.css"]) await copyFile(path.join(katexSrc, f), path.join(vendor, "katex", f));
  for (const f of await readdir(path.join(katexSrc, "fonts"))) {
    if (f.endsWith(".woff2")) await copyFile(path.join(katexSrc, "fonts", f), path.join(vendor, "katex", "fonts", f));
  }
  // Version-stamp the app's own js/css URLs so Cloudflare never serves stale assets.
  await stampAssets(OUT);

  const top = (await readdir(CONTENT, { withFileTypes: true })).filter((e) => !hidden(e.name));
  const sharedInputs = top.filter((e) => e.isFile() && /\.(sty|cls|tex)$/.test(e.name)).map((e) => path.join(CONTENT, e.name)).sort();
  const tabs = [];
  for (const e of top.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    tabs.push(await buildTab(e.name, sharedInputs));
  }

  const manifest = { generated: new Date().toISOString(), tabs };
  await writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const count = tabs.reduce((n, t) => n + t.items.length, 0);
  console.log(`built ${tabs.length} tab(s), ${count} item(s) -> ${path.relative(process.cwd(), OUT) || OUT}`);
}

main().catch((err) => {
  console.error(`build failed: ${err.message}`);
  process.exit(1);
});
