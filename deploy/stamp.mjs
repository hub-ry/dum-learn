// Adds ?v=<hash> to the site's own .js/.css URLs (HTML src/href and relative
// ES module imports) so a new publish always busts Cloudflare/browser caches.
// Vendor files are left alone (they're cached for a day and never change).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const APPS = [
  { dir: "", files: ["index.html", "app.js", "study.js", "command.js", "style.css", "time.js", "theme.js"] },
  { dir: "explore", files: ["index.html", "app.js", "render.js", "style.css", "../time.js", "../theme.js"] },
];

export async function stampAssets(out) {
  for (const app of APPS) {
    const root = path.join(out, app.dir);
    const hash = createHash("sha256");
    for (const f of app.files) hash.update(await readFile(path.join(root, f)));
    const v = hash.digest("hex").slice(0, 10);
    for (const f of app.files.filter((f) => /\.(html|js)$/.test(f))) {
      const full = path.join(root, f);
      const text = (await readFile(full, "utf8"))
        .replace(/(src|href)="((?!\/vendor\/|https?:|data:)[^"?]+\.(?:js|css))"/g, (_, a, t) => `${a}="${t}?v=${v}"`)
        .replace(/(from\s+["']\.\/[^"'?]+\.js)(["'])/g, `$1?v=${v}$2`)
        .replace(/(import\(\s*["']\.\/[^"'?]+\.js)(["'])/g, `$1?v=${v}$2`);
      await writeFile(full, text);
    }
  }
}
