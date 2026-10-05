---
name: html-report
description: Render one or more Markdown files (research notes, progress summaries, scenario write-ups) into a single standalone, phone-friendly HTML report, then optionally publish it as a Claude artifact or copy it to a synced folder (e.g. Google Drive). Use when the user asks for a readable/HTML/mobile summary, a progress report, or "something I can read on my phone".
argument-hint: "<file.md> [more.md ...] [-o out/<name>.html]"
---

# html-report

Converts Markdown into one self-contained HTML page with the project's report
styling (light/dark aware, readable at phone width, tables and code scroll
sideways inside their own boxes). The converter is a zero-dependency Node script:
`.claude/skills/html-report/scripts/md-to-html.mjs`.

## Steps

1. **Write or update the Markdown source first.** Reports are views over Markdown
   under `research/` (or wherever the source lives); never hand-edit the generated
   HTML. For a progress summary, write `research/reports/<yyyy-mm-dd>-<slug>.md`.
   Optional front matter:

   ```yaml
   ---
   title: Landscape survey
   subtitle: One sentence on what this report covers.
   eyebrow: rpiv-workflow · research       # small label above the title
   date: 2026-09-28
   status: draft | in-progress | review | done | blocked | superseded
   tags: [survey, orchestration]
   ---
   ```

   Without a `title`, the first `# H1` becomes the title. Supported Markdown: GFM
   tables (with alignment), fenced code, ```` ```mermaid ```` fences, task lists,
   nested lists, raw HTML blocks such as `<details>`, and callouts:
   `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`,
   `[!DECISION] <title>`, `[!QUESTION]`, `[!TODO]`.

2. **Render.** Pick the mode for where it's going:

   ```bash
   # Standalone file for Drive / phone / email (full HTML document)
   node .claude/skills/html-report/scripts/md-to-html.mjs research/reports/x.md \
        -o out/x.html --mermaid

   # Artifact-ready page (no doctype/head/body wrapper; <title> + <style> first)
   node .claude/skills/html-report/scripts/md-to-html.mjs research/reports/x.md \
        -o out/x.artifact.html --fragment

   # Several sources into one report (each becomes a section, first front matter wins)
   node .claude/skills/html-report/scripts/md-to-html.mjs a.md b.md -o out/combined.html
   ```

   `out/` is git-ignored. `--also <dir>` (repeatable) or the `RPIV_REPORT_DIR`
   environment variable also copies the file to a directory, such as a Google
   Drive for Desktop folder. `--no-toc` drops the contents box, and `--help`
   lists every option.

3. **Deliver.**
   - **Claude artifact:** publish the `--fragment` output with the Artifact tool,
     passing a one-sentence `description` and, on first publish, `icon: "report"`.
     To update the same artifact later, publish the same file path again (same
     session) or pass its `url`. Add the report's row to `PROGRESS.md` under
     "Published reports", and record the (private) URL in `CLAUDE.local.md`,
     not in the repo.
   - **Phone via Drive:** use the standalone output with `--also "$RPIV_REPORT_DIR"`.
     Mermaid needs network access in standalone mode, so the diagram source is
     shown as text when the page is opened offline.
   - **Chat:** send the standalone file with SendUserFile when the user wants the file itself.

## Notes

- Fonts (Bricolage Grotesque, Source Serif 4, JetBrains Mono) load from Google
  Fonts. Offline, the page falls back to system fonts and still reads correctly.
- The script never executes content from the Markdown. Raw HTML in the source is
  passed through as-is, so only render Markdown you trust.
- Keep reports short enough to read on a phone. Link to the full Markdown in the
  repo for the long version.
