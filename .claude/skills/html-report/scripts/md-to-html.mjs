#!/usr/bin/env node
// md-to-html.mjs — turn one or more Markdown files into a single standalone,
// mobile-friendly HTML report. Zero dependencies (Node >= 18).
//
// Usage:
//   node md-to-html.mjs <in.md> [more.md ...] [-o out.html] [options]
//
// Options:
//   -o, --out <file>     Output path (default: out/<first-input-name>.html)
//   --title <text>       Override the report title
//   --subtitle <text>    Override the subtitle
//   --eyebrow <text>     Small label above the title (default: "rpiv-workflow")
//   --fragment           Emit an Artifact-ready page (no doctype/html/head/body;
//                        <title> and <style> at the top). Use when publishing
//                        with the Artifact tool.
//   --no-toc             Omit the table of contents
//   --mermaid            (standalone mode) load mermaid from jsdelivr so
//                        ```mermaid fences render. Artifacts render them natively.
//   --also <dir>         Also copy the output into <dir> (e.g. a Google Drive
//                        sync folder). Repeatable. $RPIV_REPORT_DIR is used too.
//
// Front matter (optional, first file wins): title, subtitle, eyebrow, date,
// status (draft | in-progress | review | done | blocked), tags: [a, b].

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { basename, dirname, join, resolve, extname } from "node:path";

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const opts = { inputs: [], also: [], toc: true, fragment: false, mermaid: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) die(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === "-o" || a === "--out") opts.out = next();
    else if (a === "--title") opts.title = next();
    else if (a === "--subtitle") opts.subtitle = next();
    else if (a === "--eyebrow") opts.eyebrow = next();
    else if (a === "--fragment") opts.fragment = true;
    else if (a === "--no-toc") opts.toc = false;
    else if (a === "--mermaid") opts.mermaid = true;
    else if (a === "--also") opts.also.push(next());
    else if (a === "-h" || a === "--help") {
      process.stdout.write(readFileSync(new URL(import.meta.url)).toString().split("\n")
        .filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n") + "\n");
      process.exit(0);
    } else if (a.startsWith("-")) die(`unknown option ${a}`);
    else opts.inputs.push(a);
  }
  if (!opts.inputs.length) die("no input files (try --help)");
  if (process.env.RPIV_REPORT_DIR) opts.also.push(process.env.RPIV_REPORT_DIR);
  return opts;
}

function die(msg) {
  process.stderr.write(`md-to-html: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- helpers

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Escape text but keep existing entities (&amp; &#123;) intact.
const escText = (s) =>
  s.replace(/&(?!#?\w+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function slugify(text, used) {
  let base = text.toLowerCase().replace(/<[^>]+>/g, "").replace(/&\w+;/g, "")
    .replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-") || "section";
  let slug = base;
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
  used.add(slug);
  return slug;
}

function parseFrontMatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      v = v.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else v = v.replace(/^["']|["']$/g, "");
    meta[kv[1]] = v;
  }
  return { meta, body: src.slice(m[0].length) };
}

// ---------------------------------------------------------------- inline

const TAG_RE = /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/g;

function inline(src) {
  const slots = [];
  const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src;

  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|~<>])/g, (_, c) => hold(esc(c)));
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, c) =>
    hold(`<code>${esc(c.replace(/^ ([\s\S]*) $/, "$1"))}</code>`));
  s = s.replace(/<(https?:\/\/[^\s<>]+)>/g, (_, u) => hold(`<a href="${esc(u)}">${esc(u)}</a>`));
  s = s.replace(TAG_RE, (t) => hold(t));
  s = escText(s);

  // images, then links; link text stays in the stream so emphasis applies
  s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (_, alt, url, title) =>
    hold(`<img src="${esc(url)}" alt="${esc(alt)}"${title ? ` title="${esc(title)}"` : ""} loading="lazy">`));
  s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (_, text, url, title) =>
    `${hold(`<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ""}>`)}${text}${hold("</a>")}`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_, pre, u) =>
    pre + hold(`<a href="${u}">${u}</a>`));

  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
  s = s.replace(/(^|[^*\w])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_(?=\S)([\s\S]*?\S)_(?![_\w])/g, "$1<em>$2</em>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  s = s.replace(/( {2,}|\\)\n/g, "<br>\n");

  while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
  return s;
}

// ---------------------------------------------------------------- blocks

const RE = {
  fence: /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*).*$/,
  heading: /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/,
  quote: /^ {0,3}> ?/,
  list: /^( *)([-*+]|\d{1,9}[.)])( +|$)/,
  tableDelim: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
  htmlBlock: /^ {0,3}<(\/?(div|details|summary|section|figure|table|pre|svg|p|ul|ol|aside|nav|header|footer|blockquote|dl|hr)\b|!--)/i,
};

const indentOf = (l) => l.match(/^ */)[0].length;
const isBlank = (l) => /^\s*$/.test(l);

function startsBlock(line) {
  return RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) ||
    RE.quote.test(line) || RE.list.test(line) || RE.htmlBlock.test(line);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "", inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") inCode = !inCode;
    if (c === "|" && !inCode) { cells.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const CALLOUTS = {
  NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning",
  CAUTION: "Caution", DECISION: "Decision", QUESTION: "Open question", TODO: "To do",
};

class Renderer {
  constructor() {
    this.used = new Set();
    this.headings = [];
    this.firstH1 = null;
    this.consumeH1 = true; // first H1 becomes the page title unless a title was given
  }

  blocks(lines, tight = false) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }

      let m;
      if ((m = line.match(RE.fence))) {
        const fence = m[1], lang = m[2];
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
        i++;
        const code = esc(body.join("\n"));
        if (lang === "mermaid") out.push(`<div class="figure-wrap"><pre class="mermaid">${code}</pre></div>`);
        else out.push(`<div class="code-wrap">${lang ? `<span class="code-lang">${esc(lang)}</span>` : ""}<pre><code${lang ? ` class="language-${esc(lang)}"` : ""}>${code}</code></pre></div>`);
        continue;
      }

      if ((m = line.match(RE.heading))) {
        const level = m[1].length;
        const html = inline(m[2]);
        i++;
        if (level === 1 && this.consumeH1 && this.firstH1 === null) { this.firstH1 = html; continue; }
        const id = slugify(html, this.used);
        if (level <= 3) this.headings.push({ level, id, html });
        out.push(`<h${level} id="${id}">${html}</h${level}>`);
        continue;
      }

      if (RE.hr.test(line)) { out.push("<hr>"); i++; continue; }

      if (RE.quote.test(line)) {
        const body = [];
        while (i < lines.length && !isBlank(lines[i]) &&
          (RE.quote.test(lines[i]) || !startsBlock(lines[i]))) {
          body.push(lines[i].replace(RE.quote, ""));
          i++;
        }
        const cm = body[0]?.match(/^\[!(\w+)\]\s*(.*)$/);
        if (cm && CALLOUTS[cm[1].toUpperCase()]) {
          const kind = cm[1].toLowerCase();
          const label = cm[2] ? inline(cm[2]) : CALLOUTS[cm[1].toUpperCase()];
          out.push(`<aside class="callout callout-${kind}"><p class="callout-label">${label}</p>${this.blocks(body.slice(1))}</aside>`);
        } else out.push(`<blockquote>${this.blocks(body)}</blockquote>`);
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && RE.tableDelim.test(lines[i + 1]) &&
        lines[i + 1].includes("-")) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) =>
          c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "");
        i += 2;
        const rows = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
        const cell = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c ?? "")}</${tag}>`;
        out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell("td", r[k], k)).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }

      if (RE.list.test(line)) { i = this.list(lines, i, out); continue; }

      if (RE.htmlBlock.test(line)) {
        const body = [];
        while (i < lines.length && !isBlank(lines[i])) body.push(lines[i++]);
        out.push(body.join("\n"));
        continue;
      }

      const para = [];
      while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i]))) {
        if (para.length && lines[i].includes("|") && i + 1 < lines.length && RE.tableDelim.test(lines[i + 1])) break;
        para.push(lines[i++].replace(/^ {1,3}/, ""));
      }
      const html = inline(para.join("\n"));
      out.push(tight ? html : `<p>${html}</p>`);
    }
    return out.join("\n");
  }

  list(lines, i, out) {
    const first = lines[i].match(RE.list);
    const base = first[1].length;
    const ordered = /\d/.test(first[2]);
    const start = ordered ? parseInt(first[2], 10) : 1;
    const items = [];
    let loose = false, cur = null, sawBlank = false;

    while (i < lines.length) {
      const line = lines[i];
      const m = line.match(RE.list);
      if (m && m[1].length === base && /\d/.test(m[2]) === ordered) {
        if (cur && sawBlank) loose = true;
        cur = { lines: [line.slice(m[0].length)], contentIndent: m[0].length };
        items.push(cur);
        sawBlank = false;
        i++;
        continue;
      }
      if (isBlank(line)) {
        const nxt = lines.slice(i + 1).find((l) => !isBlank(l));
        if (nxt === undefined || indentOf(nxt) <= base && !(nxt.match(RE.list)?.[1].length === base)) break;
        sawBlank = true;
        cur.lines.push("");
        i++;
        continue;
      }
      const ind = indentOf(line);
      if (ind > base) {
        if (sawBlank && ind < cur.contentIndent && !RE.list.test(line)) break;
        cur.lines.push(line.slice(Math.min(ind, cur.contentIndent)));
        i++;
        continue;
      }
      if (!sawBlank && !startsBlock(line)) { cur.lines.push(line); i++; continue; }
      break;
    }

    const tag = ordered ? "ol" : "ul";
    const lis = items.map((it) => {
      let task = null;
      const tm = it.lines[0].match(/^\[([ xX])\]\s+(.*)$/);
      if (tm) { task = tm[1] !== " "; it.lines[0] = tm[2]; }
      const inner = this.blocks(it.lines, !loose);
      if (task === null) return `<li>${inner}</li>`;
      return `<li class="task${task ? " done" : ""}"><span class="check" aria-hidden="true"></span><span class="sr-only">${task ? "Done: " : "Open: "}</span><div>${inner}</div></li>`;
    });
    const hasTasks = lis.every((l) => l.startsWith('<li class="task'));
    out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}${hasTasks ? ' class="tasks"' : ""}>${lis.join("")}</${tag}>`);
    return i;
  }
}

// ---------------------------------------------------------------- page

const STATUS = {
  draft: "Draft", "in-progress": "In progress", review: "In review",
  done: "Done", blocked: "Blocked", superseded: "Superseded",
};

function toc(headings) {
  if (!headings.length) return "";
  const top = Math.min(...headings.map((h) => h.level));
  const tops = headings.filter((h) => h.level === top);
  if (tops.length < 3 && top === 2) return "";
  const nest = tops.length <= 8 || top === 1;
  const label = (h) => h.html.replace(/<\/?a[^>]*>/g, "");
  let html = "", open = false;
  headings.forEach((h, k) => {
    if (h.level === top) {
      if (open) html += "</ol></li>";
      open = false;
      html += `<li><a href="#${h.id}">${label(h)}</a>`;
      const next = headings[k + 1];
      if (nest && next && next.level === top + 1) { html += "<ol>"; open = true; }
      else html += "</li>";
    } else if (h.level === top + 1 && open) {
      html += `<li><a href="#${h.id}">${label(h)}</a></li>`;
    }
  });
  if (open) html += "</ol></li>";
  return `<details class="toc" open><summary>Contents</summary><ol>${html}</ol></details>`;
}

const FONTS = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=JetBrains+Mono:wght@400;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap";

const CSS = String.raw`
:root{
  --paper:#F6F7F4; --surface:#FFFFFF; --sunk:#ECEFEA; --ink:#1C2421; --muted:#5A6660;
  --rule:#D8DDD8; --accent:#2E5C88; --accent-soft:#E3ECF5; --ochre:#A87520; --ochre-soft:#F5ECD9;
  --good:#2F7A4F; --good-soft:#E1F0E6; --bad:#A63D32; --bad-soft:#F6E2DF; --warn:#9A6A12; --warn-soft:#F5EBD4;
  --display:"Bricolage Grotesque",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --body:"Source Serif 4",Charter,"Iowan Old Style",Georgia,serif;
  --mono:"JetBrains Mono",ui-monospace,"Cascadia Mono",Consolas,monospace;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    color-scheme:dark;
    --paper:#121816; --surface:#19201D; --sunk:#0E1311; --ink:#E1E7E3; --muted:#98A49E;
    --rule:#2C3531; --accent:#8FB6DE; --accent-soft:#1C2A38; --ochre:#D9A94E; --ochre-soft:#2E2515;
    --good:#7CC79A; --good-soft:#16281E; --bad:#E58A7F; --bad-soft:#321B18; --warn:#D9B25E; --warn-soft:#2E2614;
  }
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --paper:#121816; --surface:#19201D; --sunk:#0E1311; --ink:#E1E7E3; --muted:#98A49E;
  --rule:#2C3531; --accent:#8FB6DE; --accent-soft:#1C2A38; --ochre:#D9A94E; --ochre-soft:#2E2515;
  --good:#7CC79A; --good-soft:#16281E; --bad:#E58A7F; --bad-soft:#321B18; --warn:#D9B25E; --warn-soft:#2E2614;
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:400 1.0625rem/1.65 var(--body);
  -webkit-text-size-adjust:100%;text-rendering:optimizeLegibility}
.page{max-width:44rem;margin:0 auto;padding-inline:clamp(16px,5vw,32px);padding-block:clamp(28px,6vw,56px) 64px}
.masthead{display:grid;gap:.5rem;padding-bottom:1.25rem;margin-bottom:1.5rem;border-bottom:2px solid var(--ink)}
.eyebrow{font:600 .72rem/1.2 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin:0}
.masthead h1{font:700 clamp(1.9rem,6vw,2.6rem)/1.08 var(--display);letter-spacing:-.015em;margin:0;text-wrap:balance}
.subtitle{margin:0;color:var(--muted);font-size:1.08rem;text-wrap:pretty}
.meta{display:flex;flex-wrap:wrap;gap:.4rem .9rem;align-items:center;font:.78rem/1.4 var(--mono);color:var(--muted);margin-top:.35rem}
.chip{display:inline-flex;align-items:center;gap:.35rem;padding:.12rem .55rem;border-radius:999px;font:600 .72rem/1.5 var(--mono);
  letter-spacing:.03em;background:var(--sunk);color:var(--ink)}
.chip::before{content:"";width:.45rem;height:.45rem;border-radius:50%;background:currentColor}
.chip.s-done{background:var(--good-soft);color:var(--good)} .chip.s-blocked{background:var(--bad-soft);color:var(--bad)}
.chip.s-in-progress,.chip.s-review{background:var(--accent-soft);color:var(--accent)} .chip.s-draft{background:var(--warn-soft);color:var(--warn)}
.chip.s-superseded{background:var(--sunk);color:var(--muted)}
.tags{display:flex;flex-wrap:wrap;gap:.3rem}.tag{padding:.05rem .45rem;border:1px solid var(--rule);border-radius:4px}
.toc{margin:0 0 2rem;padding:.75rem 1rem;background:var(--surface);border:1px solid var(--rule);border-radius:6px;font:.9rem/1.45 var(--display)}
.toc summary{cursor:pointer;font:600 .72rem/1.2 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:.2rem 0}
.toc ol{margin:.5rem 0 0;padding-left:1.3rem;display:grid;gap:.3rem}.toc ol ol{margin-top:.3rem;font-size:.85rem;gap:.2rem}
.toc li::marker{color:var(--muted);font-family:var(--mono);font-size:.8em}
.toc a{color:var(--ink);text-decoration:none}.toc a:hover{color:var(--accent);text-decoration:underline}
.doc h1{font:700 clamp(1.5rem,5vw,1.9rem)/1.15 var(--display);letter-spacing:-.01em;margin:3rem 0 1rem;padding-top:1.25rem;border-top:2px solid var(--ink);text-wrap:balance}
.doc:first-child h1{margin-top:0;padding-top:0;border-top:0}
h2,h3,h4,h5,h6{font-family:var(--display);line-height:1.2;text-wrap:balance;scroll-margin-top:1rem}
h2{font-size:1.55rem;font-weight:700;margin:2.75rem 0 .75rem;padding-top:.9rem;border-top:1px solid var(--rule)}
h3{font-size:1.2rem;font-weight:700;margin:2rem 0 .5rem}
h4{font-size:1rem;font-weight:700;margin:1.5rem 0 .4rem}
h5,h6{font:600 .75rem/1.3 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:1.25rem 0 .3rem}
p,ul,ol,blockquote,.table-wrap,.code-wrap,.callout,.figure-wrap{margin:0 0 1rem}
ul,ol{padding-left:1.4rem}li{margin:.25rem 0}li>ul,li>ol{margin:.25rem 0 .4rem}
li::marker{color:var(--muted)}
a{color:var(--accent);text-underline-offset:.15em;text-decoration-thickness:1px}
a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
strong{font-weight:600}
hr{border:0;border-top:1px dashed var(--rule);margin:2rem 0}
code{font:.86em/1.4 var(--mono);background:var(--sunk);padding:.08em .32em;border-radius:3px;overflow-wrap:anywhere}
.code-wrap{position:relative;background:var(--sunk);border:1px solid var(--rule);border-radius:6px;overflow-x:auto}
.code-wrap pre{margin:0;padding:.9rem 1rem;font:.8rem/1.55 var(--mono);tab-size:2}
.code-wrap pre code{background:none;padding:0;font-size:inherit;overflow-wrap:normal;white-space:pre}
.code-lang{position:sticky;left:0;display:block;padding:.35rem 1rem 0;font:600 .65rem/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.figure-wrap{overflow-x:auto;background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:.75rem}
.figure-wrap pre.mermaid{margin:0;font:.8rem/1.4 var(--mono);white-space:pre;color:var(--muted)}
.table-wrap{overflow-x:auto;border:1px solid var(--rule);border-radius:6px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font:.86rem/1.45 var(--display);font-variant-numeric:tabular-nums}
th,td{padding:.55rem .7rem;text-align:left;vertical-align:top;border-bottom:1px solid var(--rule);min-width:7rem}
th:first-child,td:first-child{min-width:6rem}
thead th{font:600 .68rem/1.3 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);background:var(--sunk);white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
td code{font-size:.8em}
blockquote{margin-left:0;padding:.1rem 0 .1rem 1rem;border-left:3px solid var(--rule);color:var(--muted)}
.callout{padding:.8rem 1rem;border-radius:6px;background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 25%,transparent)}
.callout>:last-child{margin-bottom:0}
.callout-label{font:600 .7rem/1.2 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin:0 0 .4rem}
.callout-decision,.callout-question,.callout-todo{background:var(--ochre-soft);border-color:color-mix(in srgb,var(--ochre) 30%,transparent)}
.callout-decision .callout-label,.callout-question .callout-label,.callout-todo .callout-label{color:var(--ochre)}
.callout-warning,.callout-caution{background:var(--bad-soft);border-color:color-mix(in srgb,var(--bad) 30%,transparent)}
.callout-warning .callout-label,.callout-caution .callout-label{color:var(--bad)}
.callout-tip{background:var(--good-soft);border-color:color-mix(in srgb,var(--good) 30%,transparent)}
.callout-tip .callout-label{color:var(--good)}
ul.tasks,ol.tasks{list-style:none;padding-left:.2rem}
li.task{list-style:none;display:grid;grid-template-columns:1.1rem 1fr;gap:.55rem;align-items:start}
li.task .check{width:1rem;height:1rem;margin-top:.3rem;border:1.5px solid var(--muted);border-radius:3px}
li.task.done .check{background:var(--good);border-color:var(--good);
  background-image:linear-gradient(45deg,transparent 42%,var(--surface) 42%,var(--surface) 54%,transparent 54%),linear-gradient(-45deg,transparent 46%,var(--surface) 46%,var(--surface) 58%,transparent 58%);
  background-size:60% 60%,60% 60%;background-position:25% 70%,75% 35%;background-repeat:no-repeat}
li.task.done>div{color:var(--muted)}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
details:not(.toc){margin:0 0 1rem;border:1px solid var(--rule);border-radius:6px;padding:.5rem .9rem;background:var(--surface)}
details:not(.toc)>summary{cursor:pointer;font:600 .95rem/1.4 var(--display)}
details[open]:not(.toc)>summary{margin-bottom:.5rem}
img{max-width:100%;height:auto}
.colophon{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--rule);font:.72rem/1.5 var(--mono);color:var(--muted)}
@media (max-width:480px){body{font-size:1rem}h2{font-size:1.35rem}th,td{min-width:6rem}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
html{scroll-behavior:smooth}
`;

function renderPage(opts) {
  const r = new Renderer();
  let meta = {};
  const bodies = [];
  r.consumeH1 = !opts.title;
  for (const file of opts.inputs) {
    const raw = readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
    const fm = parseFrontMatter(raw);
    if (!Object.keys(meta).length) meta = fm.meta;
    const html = r.blocks(fm.body.replace(/\t/g, "    ").split("\n"));
    r.consumeH1 = false;
    bodies.push(opts.inputs.length > 1 ? `<section class="doc">${html}</section>` : html);
  }

  const title = opts.title ? esc(opts.title) : meta.title ? inline(meta.title)
    : r.firstH1 ?? esc(basename(opts.inputs[0], extname(opts.inputs[0])));
  const plainTitle = title.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
  const subtitle = opts.subtitle ?? meta.subtitle;
  const eyebrow = opts.eyebrow ?? meta.eyebrow ?? "rpiv-workflow";
  const status = typeof meta.status === "string" ? meta.status.toLowerCase() : null;
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  const date = meta.date ?? new Date().toISOString().slice(0, 10);

  const metaRow = [
    `<span>${esc(String(date))}</span>`,
    status ? `<span class="chip s-${esc(status)}">${esc(STATUS[status] ?? status)}</span>` : "",
    tags.length ? `<span class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</span>` : "",
  ].filter(Boolean).join("");

  const content = `<main class="page">
<header class="masthead">
<p class="eyebrow">${esc(eyebrow)}</p>
<h1>${title}</h1>
${subtitle ? `<p class="subtitle">${inline(subtitle)}</p>` : ""}
<div class="meta">${metaRow}</div>
</header>
${opts.toc ? toc(r.headings) : ""}
${bodies.join("\n<hr>\n")}
<footer class="colophon">Generated ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC from ${opts.inputs.map((f) => esc(basename(f))).join(", ")}</footer>
</main>`;

  const fontLink = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${FONTS}">`;

  if (opts.fragment) {
    return `<title>${esc(plainTitle)}</title>\n${fontLink}\n<style>${CSS}</style>\n${content}\n`;
  }
  const mermaid = opts.mermaid
    ? `<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script><script>mermaid.initialize({startOnLoad:true,theme:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"neutral"});</script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(plainTitle)}</title>
${fontLink}
<style>${CSS}</style>
</head>
<body>
${content}
${mermaid}
</body>
</html>
`;
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
for (const f of opts.inputs) {
  try { readFileSync(f); } catch { die(`cannot read ${f}`); }
}
const out = resolve(opts.out ?? join("out", `${basename(opts.inputs[0], extname(opts.inputs[0]))}.html`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, renderPage(opts));
process.stdout.write(`${out}\n`);
for (const dir of opts.also) {
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, basename(out));
  copyFileSync(out, dest);
  process.stdout.write(`${dest}\n`);
}
