# rpiv-workflow

A research-first project to design a **research → plan → implement → validate (RPIV)**
workflow for working with coding agents. The workflow should keep an experienced
human "driver" in the loop, keep its artifacts reviewable, and scale from a
one-hour bug fix to a multi-week project delegated across many subagents.

This repo does not contain the workflow yet. It holds the research, decisions, and
mock runs that will shape it, plus small tools that support that work.

## What we are trying to build

A workflow (skills, conventions, and eventually some tooling) where:

1. **Every phase leaves a reviewable artifact.** Research, design, plans, and
   outcomes are written down in a stable format a human can read, diff, and
   comment on, and a fresh agent can pick up cold.
2. **Plans can be revised as assumptions change**, during planning or mid-implementation,
   without losing the record of what changed and why.
3. **Work can be split at any point.** Any artifact can spawn several child
   workflows (for example, a research doc that turns into three features), and the
   links between parent and children are preserved.
4. **Larger projects get higher-order orchestration over time**, through a
   backlog/graph/board layer. That layer could be an existing tool (beads,
   Backlog.md, Linear, GitHub Issues), a built-in feature of a workflow tool, or
   something we build.
5. **Artifacts live on the machine running the agent**, in a git-ignored directory
   or a local database, not in the product repo's history.
6. **Automatable work is delegated.** An orchestrating model hands mechanical or
   well-specified tasks to subagents and lighter or cheaper models, and verifies
   their output.
7. **Progress is readable away from the terminal.** Summaries render as standalone
   HTML that can be viewed as a Claude artifact or on a phone (for example, via
   Google Drive).

## Inspirations

Pinned as git submodules under `research/inspirations/` (read-only reference):

| Project | Why it's here |
| --- | --- |
| [rpiv-mono](https://github.com/juicesharp/rpiv-mono) | The RPIV pipeline for the Pi coding agent that this project starts from. Contract-carrying skills, typed `/wf` workflow graphs, and git-ignored `.rpiv/artifacts/`. |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | Lightweight spec-driven development: living specs, per-change proposals with spec deltas, and standalone planning "stores". |
| [spec-kitty](https://github.com/spec-kitty/spec-kitty) | Heavyweight SDD with missions, work packages, kanban lanes, git-worktree isolation, and retrospectives. |
| [beads](https://github.com/gastownhall/beads) | A dependency-graph issue tracker built for agents (`bd ready`), with formulas/molecules for repeatable workflows and gates. |

## Repository layout

```text
README.md                 This file: purpose and layout
CLAUDE.md                 Orientation and ground rules for agents working in this repo
PROGRESS.md               Living status: done / in flight / next, decisions, published reports
research/
  inspirations/           Git submodules (read-only reference sources)
  01-inspirations.md      Deep dive on the four inspiration projects
  02-landscape.md         Wider survey of tools (SDD frameworks, trackers, orchestrators, review UIs)
  03-rpiv-needs.md        Per-phase and cross-cutting requirements: build vs. adopt, tradeoffs, risks
  04-scenarios.md         Gamed-out scenarios comparing candidate tool stacks
  05-thin-layer-design.md Phase 1 design: Pi extension joining rpiv, beads, and the artifact store
  06-m0-beads-smoke-test.md  M0: bd/dolt install and hands-on beads test
  reports/                Markdown sources for HTML progress reports
.claude/skills/
  html-report/            Skill + zero-dependency script: Markdown -> standalone HTML report
extension/                The rpivw Pi extension (from M1)
out/                      Generated HTML (git-ignored)
```

## Getting started

```bash
git clone --recurse-submodules <this repo>
# On Windows, some submodules have very long paths:
git -C research/inspirations/spec-kitty config core.longpaths true
git -C research/inspirations/openspec config core.longpaths true
git submodule update --init --depth 50
```

Render a report (Node 18+; no install step):

```bash
node .claude/skills/html-report/scripts/md-to-html.mjs research/reports/<file>.md -o out/<file>.html
```

See `.claude/skills/html-report/SKILL.md` for artifact publishing and Drive export.

## License

MIT. See [LICENSE](LICENSE). The submodules under `research/inspirations/` keep their own licenses.
