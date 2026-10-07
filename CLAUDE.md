# CLAUDE.md

Orientation for agents and subagents working in this repo. Read this first, then
`PROGRESS.md` for the current state. `README.md` has the project's purpose.

## What this project is

We are designing an RPIV (research → plan → implement → validate) workflow for
coding agents. This started as a **research and design project** (survey documents,
decisions, scenario walkthroughs) and now has a working prototype: the **rpivw Pi
extension** in `extension/`, built milestone by milestone (see `PROGRESS.md` → Roadmap).
Build what `PROGRESS.md` lists as the current task, or what the user asks for.

The repo is meant to be checked out on more than one machine (for example, to evaluate it
against a workflow on another computer). Keep everything committed here machine-neutral;
facts about one machine go in `CLAUDE.local.md` (see "Machine-specific notes" below).

The user's hard requirements (keep every recommendation consistent with these):

1. Workflow artifacts (research, design, plans, outcomes) are **reviewable** by a human.
2. The workflow can be **revised** as assumptions change, even mid-implementation.
3. Work can be **broken down into multiple workflows at any time**, with parent/child links.
4. Larger projects need **orchestration over time** (tracker, board, or graph), bought or built.
5. Artifacts live **local to the machine running the agent**: a git-ignored directory or a local database.
6. The design should allow **heavy use of subagents**, delegating automatable work to lighter models.
7. Progress summaries must be readable as **standalone HTML** (Claude artifact, or a phone via Google Drive).

Settled direction (2026-10-01, see `PROGRESS.md` → Decisions): the workflow runs on
**Pi**. It's built as a **Pi extension** that joins **rpiv-pi/rpiv-workflow** (phase
methods and runs) with **beads + Dolt** (work graph) and a **private-git artifact store**
(`~/rpivw`). It adopts rpiv and beads unchanged, with no forks. The single reader is
the driver, the projects are long-lived, and living specs are in scope. The current
design is `research/05-thin-layer-design.md`.

## Where things live

| Path | Purpose | Rules |
| --- | --- | --- |
| `PROGRESS.md` | Status, next tasks, decision log, published report URLs | Update it at the end of every work session. |
| `extension/` | The rpivw Pi extension (source, tests, README with setup) | Tests must pass before committing. |
| `docs/rpiv-review-guide.md` | Map of an rpiv/Pi install and the protocol for reviewing rpiv artifacts and runs | Read before reviewing rpiv output or changing workflow config. |
| `CLAUDE.local.md` | This machine's notes | Git-ignored. Template: `CLAUDE.local.example.md`. |
| `research/NN-*.md` | Numbered research documents | Add new docs with the next number. Revise in place, and add a dated entry to the doc's `## Revision log` for material changes. |
| `research/reports/` | Markdown sources for HTML reports | One file per report: `<yyyy-mm-dd>-<slug>.md`. |
| `research/inspirations/` | Git submodules | **Read-only.** Never commit changes inside them. Cite files as `research/inspirations/<repo>/<path>` plus the pinned commit. |
| `.claude/skills/html-report/` | Markdown → HTML report skill | Use it for any "readable summary" or "send to my phone" request. |
| `out/` | Generated HTML | Git-ignored. Regenerate it; never hand-edit it. |

## How to work here

- **Cite evidence.** Claims about a tool should point at a file in its submodule or
  at a URL. Mark anything from web search that you haven't checked against source as
  *unverified*. Tools in this space change monthly, so record versions and commits.
- **Separate facts from opinions.** Research docs keep "what exists" apart from
  "what we recommend". Decisions go into `PROGRESS.md` → Decisions, with a date and rationale.
- **Prefer the smallest artifact that works.** This project will be read on a phone,
  so lead with summaries and tables and put detail below.
- **Use subagents for fan-out reading** (for example, "survey tool X's docs") when
  the user asks for parallel work. Give them this file and the relevant research doc
  as context, and have them return findings for you to merge. Do not let them edit
  the numbered docs directly.
- **Close each session** by updating `PROGRESS.md` (what was done, what's next, open
  questions), and, if the user wants it, rendering a report with the `html-report` skill.
- **Turn off bd's usage metrics on every machine.** `bd` (beads) sends anonymous usage
  metrics by default: command names, version, and OS. The driver wants them off. When you
  install or first set up `bd` on a machine, run `bd metrics off` before using it for
  anything else (including `/work setup`), then confirm with `bd metrics`. The setting is
  per user (`~/.config/bd/config.yaml`), so do it once per machine and account.

## Requirements and conventions

These hold on every machine. Paths use `~` for the home folder; on Windows that's
`%USERPROFILE%`.

- **Scripts are Node.** Don't depend on Python. The report script has no dependencies, and
  `pandoc` is optional.
- **Pi.** Its agent folder is `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`. Active packages are listed
  in `<agent folder>/settings.json` → `packages`. rpiv-* packages install under
  `<agent folder>/npm/node_modules/@juicesharp/`. Pi's docs and types ship inside its package
  (`@earendil-works/pi-coding-agent/{docs,dist}`); find it from `which pi` (or, for a managed install,
  `<agent folder>/install/current-version`). Pi and rpiv update themselves, so check the installed
  versions before relying on their internals, and re-check the extension APIs after a Pi upgrade.
  Tested with Pi 1.0.2 and rpiv-* 2.11–2.12.
- **rpivw** loads through a `packages` entry in Pi's settings that points at this checkout's
  `extension/` folder, so edits are live after `/reload`. Its warnings and errors are also logged to
  `<store>/.git/rpivw.log`.
- **Extension tests:** `cd extension && node --test test/`, then `npm run typecheck` (tsc --noEmit
  against the installed Pi's types; needs `tsc` on PATH or npx). No dependencies and no build. Keep
  the TypeScript erasable (type stripping) and use `.ts` import extensions. Tests that need `bd`
  skip without it.
- **beads and Dolt.** Tested with `bd` 1.3.1 and `dolt` 2.2.0. Any install method works (mise, a
  package manager, a release binary); rpivw finds `bd` via `RPIVW_BD`, then PATH, then mise's install
  folder. Don't upgrade them without the driver (see research 06). Parse `bd --json` from stdout only.
  On Windows, keep Dolt and git work on short paths.
- **The store** (`RPIVW_STORE`, default `~/rpivw`) is user data, separate from this repo. On a new
  machine, create or join it with `/work setup` (see `extension/README.md`). Choose the store's
  remote per machine: a store holding work artifacts must not push to a personal remote. A store
  without a remote is fine (local-only).
- **Submodules** under `research/inspirations/` are reference material. On Windows, spec-kitty and
  openspec need `core.longpaths=true` to check out.
- Ask before installing anything system-wide.
- Never start `/wf`, edit Pi's `settings.json`, or change `~/.config/rpiv-*` without the driver
  asking (see `docs/rpiv-review-guide.md`, which is also the protocol for reviewing rpiv
  artifacts, workflow configs, and run trails).

## Machine-specific notes

Facts about one machine (OS, shell, install paths, versions actually installed, the store
remote, known quirks) go in **`CLAUDE.local.md`** at the repo root. It's git-ignored, and Claude
Code loads it automatically next to this file. On a new machine, copy
`CLAUDE.local.example.md` to `CLAUDE.local.md` and fill it in as you learn the setup.

## Vocabulary

- **Artifact**: a durable document produced by a phase (research, design, plan, validation, review, and so on).
- **Work item**: a unit of tracked work (a ticket, bead, WP, or change). It may point at artifacts.
- **Run**: one execution of a workflow over a work item (compare rpiv-workflow's JSONL runs).
- **Split**: turning one artifact or work item into several child work items with preserved lineage.
- **Driver**: the human who steers architecture and approves gates.
