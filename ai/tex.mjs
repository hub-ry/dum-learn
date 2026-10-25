// Lesson documents: LaTeX in the site's style (learn.sty), compiled with
// tectonic exactly like build.mjs does, then published with deploy/publish.sh.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Primitives that could read or write files outside the document (and so leak
// something private into a public PDF) or run commands. Generated LaTeX that
// uses any of them is never compiled.
const FORBIDDEN = [
  /\\(input|include|includeonly|InputIfFileExists|openin|openout|read|readline|write|immediate|newwrite|newread|catcode|directlua|luaexec|pdffiledump|pdfximage|IfFileExists|lstinputlisting|verbatiminput|includegraphics|includepdf|special|pdfobj|usetikzlibrary|ShellEscape|write18|csname|expandafter|scantokens|endlinechar)\b/,
  /\^\^/,
];
const ALLOWED_PKGS = new Set(["learn", "tikz"]);

export function checkTex(tex) {
  const problems = [];
  for (const re of FORBIDDEN) {
    const m = tex.match(re);
    if (m) problems.push(`forbidden command ${m[0]}`);
  }
  for (const m of tex.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]*)\}/g)) {
    for (const p of m[1].split(",").map((s) => s.trim())) if (!ALLOWED_PKGS.has(p)) problems.push(`package ${p} is not allowed`);
  }
  if (!/\\documentclass(\[[^\]]*\])?\{article\}/.test(tex)) problems.push("must start with \\documentclass[11pt]{article}");
  if (!/\\usepackage\{learn\}/.test(tex)) problems.push("must use \\usepackage{learn}");
  if (!/\\begin\{document\}[\s\S]*\\end\{document\}/.test(tex)) problems.push("missing document environment");
  if (tex.length > 60_000) problems.push("document too long");
  return problems;
}

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, { ...opts, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), err });
    });
  });
}

// Compile in a scratch dir. Returns { ok, log } with the useful error lines.
// pdfOut: also keep the built PDF there (infinite-learn section pages).
export async function compileTex(tex, contentRoot, { pdfOut } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "learn-ai-tex-"));
  try {
    await writeFile(path.join(dir, "lesson.tex"), tex);
    const r = await run("tectonic", ["-Z", `search-path=${contentRoot}`, "--outdir", dir, "lesson.tex"], { cwd: dir, timeout: 180_000 });
    const all = `${r.stdout}\n${r.stderr}`;
    const lines = all.split("\n");
    const errs = [];
    lines.forEach((l, i) => {
      if (/^(error|!)|Undefined control sequence|Emergency stop|Missing|Runaway|not found/i.test(l.trim())) {
        errs.push(lines.slice(Math.max(0, i - 1), i + 3).join("\n"));
      }
    });
    let pages = null;
    if (r.ok) {
      const info = await run("pdfinfo", [path.join(dir, "lesson.pdf")], { cwd: dir, timeout: 15_000 }).catch(() => null);
      const m = info?.stdout?.match(/^Pages:\s+(\d+)/m);
      if (m) pages = Number(m[1]);
      if (pdfOut) await copyFile(path.join(dir, "lesson.pdf"), pdfOut);
    }
    return { ok: r.ok, pages, log: (errs.join("\n---\n") || all).slice(0, 3000) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Strip a LaTeX document to readable plain text (fallback when it won't compile).
export function texToText(tex) {
  const body = (tex.match(/\\begin\{document\}([\s\S]*)\\end\{document\}/) ?? [, tex])[1];
  const title = (tex.match(/\\title\{([^}]*)\}/) ?? [, ""])[1];
  let t = body
    .replace(/\\maketitle/g, title ? `${title}\n${"=".repeat(title.length)}\n` : "")
    .replace(/\\(sub)?section\*?\{([^}]*)\}/g, (_, sub, s) => `\n${s}\n${(sub ? "-" : "=").repeat(s.length)}`)
    .replace(/\\begin\{lstlisting\}(\[[^\]]*\])?/g, "\n").replace(/\\end\{lstlisting\}/g, "\n")
    .replace(/\\item\s*/g, "  - ")
    .replace(/\\begin\{why\}(\[[^\]]*\])?/g, "\n[Why? Answer in your own words]\n")
    .replace(/\\underneath\{/g, "Underneath: {")
    .replace(/\\(begin|end)\{[a-z*]+\}(\[[^\]]*\])?/g, "")
    .replace(/\\(code|textbf|emph|textit|texttt)\{([^}]*)\}/g, "$2")
    .replace(/\\[a-zA-Z]+\*?/g, "").replace(/[{}]/g, "").replace(/\n{3,}/g, "\n\n");
  return t.trim() + "\n";
}

// One publish at a time; requests that arrive while one runs share the next run.
export function createPublisher(siteDir) {
  let running = null, again = false;
  async function loop() {
    do {
      again = false;
      const r = await run(path.join(siteDir, "deploy/publish.sh"), [], { cwd: siteDir, timeout: 600_000 });
      if (!r.ok) {
        console.error(`publish failed: ${(r.stderr || r.stdout).slice(-1500)}`);
        if (!again) throw new Error("publish failed (see journal)");
      }
    } while (again);
  }
  return function publish() {
    if (running) { again = true; return running; }
    running = loop().finally(() => { running = null; });
    return running;
  };
}

export async function writeLessonFile(full, content) {
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}
