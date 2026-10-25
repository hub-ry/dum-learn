// Markdown is built from DOM nodes. Model text is never interpreted as HTML.
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

let katexLoad;
function math(expression, display) {
  const node = h(display ? "div" : "span", { class: display ? "math display" : "math" }, display ? `$$${expression}$$` : `$${expression}$`);
  if (!katexLoad) {
    document.head.append(h("link", { rel: "stylesheet", href: "/vendor/katex/katex.min.css" }));
    katexLoad = import("/vendor/katex/katex.mjs").then((module) => module.default).catch(() => null);
  }
  katexLoad.then((katex) => {
    if (!katex) return;
    try { katex.render(expression, node, { displayMode: display, throwOnError: false, trust: false, strict: "ignore", maxExpand: 200 }); }
    catch { node.textContent = expression; }
  });
  return node;
}

const INLINE = new RegExp([
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  /\$\$([^$]+?)\$\$/,
  /\\\(([\s\S]+?)\\\)/,
  /\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?![\w$])/,
  /\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/,
  /(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])/,
  /(?<![\w_])_(?![\s_])([^_\n]+?)(?<!\s)_(?![\w_])/,
  /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/,
  /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/,
].map((pattern) => pattern.source).join("|"), "g");

function inline(text, depth = 0) {
  if (depth > 12) return [text];
  const result = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) result.push(text.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[2] != null) result.push(h("code", {}, match[2].replace(/^ (.*) $/, "$1")));
    else if (match[3] != null || match[4] != null || match[5] != null) result.push(math(match[3] ?? match[4] ?? match[5], false));
    else if (match[6] != null) result.push(h("strong", {}, inline(match[6], depth + 1)));
    else if (match[7] != null || match[8] != null) result.push(h("em", {}, inline(match[7] ?? match[8], depth + 1)));
    else result.push(h("a", { href: match[10] ?? match[11], target: "_blank", rel: "noopener noreferrer" }, match[9] ?? match[11]));
  }
  if (last < text.length) result.push(text.slice(last));
  return result;
}

export async function copyText(text, button) {
  const label = button.textContent;
  try {
    if (!navigator.clipboard) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch { button.textContent = "Couldn't copy"; }
  setTimeout(() => { button.textContent = label; }, 1600);
}

function codeBlock(code, language) {
  const copy = h("button", { type: "button", class: "quiet", "aria-label": "Copy code" }, "Copy");
  copy.addEventListener("click", () => copyText(code, copy));
  return h("div", { class: "code-block" },
    h("div", { class: "code-header" }, h("span", {}, language || "code"), copy),
    h("pre", {}, h("code", {}, code)));
}

const splitRow = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim());

export function markdown(source, final = true, depth = 0) {
  if (depth > 12) return [h("p", {}, source)];
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  const result = [];
  let i = 0;
  const blockStart = (line) => /^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\$\$|\\\[|\|.*\|\s*$|(-{3,}|\*{3,})\s*$)/.test(line);
  while (i < lines.length) {
    const line = lines[i];
    let match;
    if (!line.trim()) { i++; continue; }
    if ((match = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/))) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(match[1])) body.push(lines[i++]);
      if (i < lines.length) i++;
      result.push(codeBlock(body.join("\n"), match[2]));
      continue;
    }
    if ((match = line.match(/^\s*(\$\$|\\\[)(.*)$/))) {
      const close = match[1] === "$$" ? "$$" : "\\]";
      const rest = match[2];
      const body = [];
      if (rest.trimEnd().endsWith(close) && rest.trim().length >= close.length) {
        body.push(rest.trimEnd().slice(0, -close.length)); i++;
      } else {
        body.push(rest); i++;
        while (i < lines.length && !lines[i].trimEnd().endsWith(close)) body.push(lines[i++]);
        if (i < lines.length) { body.push(lines[i].trimEnd().slice(0, -close.length)); i++; }
        else if (!final) { result.push(h("pre", { class: "math-pending" }, body.join("\n"))); continue; }
      }
      result.push(math(body.join("\n").trim(), true));
      continue;
    }
    if ((match = line.match(/^\s*(#{1,6})\s+(.*)$/))) {
      result.push(h(`h${Math.min(6, match[1].length + 2)}`, {}, inline(match[2].replace(/\s#+\s*$/, ""))));
      i++; continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { result.push(h("hr")); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      result.push(h("blockquote", {}, markdown(body.join("\n"), final, depth + 1)));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
      result.push(h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, header.map((cell) => h("th", {}, inline(cell))))),
        h("tbody", {}, rows.map((row) => h("tr", {}, row.map((cell) => h("td", {}, inline(cell)))))))));
      continue;
    }
    if ((match = line.match(/^(\s*)([-*+]|\d+[.)])\s+/))) {
      const ordered = /\d/.test(match[2]);
      const list = h(ordered ? "ol" : "ul");
      if (ordered) list.setAttribute("start", String(parseInt(match[2], 10)));
      while (i < lines.length) {
        const itemMatch = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!itemMatch || (/\d/.test(itemMatch[2]) !== ordered && itemMatch[1].length < 2)) break;
        const body = [itemMatch[3]];
        const item = h("li", { class: itemMatch[1].length >= 2 ? "nested" : null });
        i++;
        while (i < lines.length && lines[i].trim() && !blockStart(lines[i])) body.push(lines[i++].trim());
        item.append(...inline(body.join(" ")));
        if (i < lines.length && /^\s+(```|~~~)/.test(lines[i])) {
          const fence = lines[i].match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
          const code = []; i++;
          while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++].replace(/^ {0,4}/, ""));
          if (i < lines.length) i++;
          item.append(codeBlock(code.join("\n"), fence[2]));
        }
        list.append(item);
        if (!lines[i]?.trim() && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1] ?? "")) i++;
      }
      result.push(list);
      continue;
    }
    const paragraph = [line.trim()]; i++;
    while (i < lines.length && lines[i].trim() && !blockStart(lines[i])) paragraph.push(lines[i++].trim());
    result.push(h("p", {}, inline(paragraph.join(" "))));
  }
  return result;
}
