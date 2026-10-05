---
title: Tool landscape
subtitle: SDD frameworks, work trackers, orchestrators, and review surfaces that could fill a slot in an RPIV workflow.
eyebrow: rpiv-workflow · research 02
date: 2026-09-28
status: done
tags: [survey, landscape]
---

# Tool landscape

Anything not in `research/inspirations/` was surveyed by web search on 2026-09-28 and is
**unverified** against source unless noted. Star counts and version numbers come from
secondary articles and move quickly, so treat them as rough signals only.

The tools fall into four slots. Most real setups combine one tool per slot.

| Slot | Job | Examples |
| --- | --- | --- |
| **A. Method / artifacts** | Phases, prompts, and the documents they produce | rpiv-pi, OpenSpec, Spec Kit, spec-kitty, BMAD, GSD, Superpowers, HumanLayer RPI, Kiro |
| **B. Work graph / tracker** | Units of work, status, dependencies, backlog over time | beads, Backlog.md, Task Master, GitHub Issues/Projects, Linear, Jira |
| **C. Execution / orchestration** | Running agents, parallelism, delegation, gates | rpiv-workflow, Claude Code subagents / Agent Teams, Gas Town, Vibe Kanban, spec-kitty `next` |
| **D. Review surface** | Where a human reads and approves | Plannotator, tool dashboards, beads UIs, our `html-report` |

## A. Method and artifact frameworks

| Tool | Shape | Artifacts | Notes for us |
| --- | --- | --- | --- |
| **rpiv-pi** | ~30 skills, typed pipelines | `.rpiv/artifacts/<bucket>/*.md`, git-ignored | Baseline. Pi-only. See research 01. |
| **HumanLayer RPI** (`humanlayer/humanlayer` `.claude/commands`) | research → plan → implement → validate, clearing context between phases | `thoughts/shared/{research,plans,tickets}/` | The ancestor of the rpiv style. Research agents "document, don't judge"; plans are built through conversation. Designed for Claude Code, with Linear tickets as the tracker. [source](https://github.com/humanlayer/humanlayer/blob/main/.claude/commands/create_plan.md) |
| **OpenSpec** | explore → propose → apply → archive | `openspec/specs` + `openspec/changes` | Living specs + deltas. See research 01. |
| **GitHub Spec Kit** | constitution → specify → plan → tasks → implement | `specs/NNN-feature/{spec,plan,tasks}.md` plus a constitution file (exact paths unverified) | The most popular option and portable across agents. v0.10 (2026) replaced `--ai` flags with integrations, extensions, presets, and hooks. It churns. [source](https://github.com/github/spec-kit) |
| **spec-kitty** | Spec Kit descendant with a runtime | `kitty-specs/<mission>/` | Adds lanes, worktrees, and a dashboard. See research 01. |
| **BMAD Method** (v6) | Persona agents: Analyst, PM, Architect, Scrum Master, Dev, QA | PRD + architecture, *sharded* into self-contained story files | Story files carry their rationale, constraints, and tests, so the Dev agent needs no other context. It detects workflow state from which output files exist. [docs](https://docs.bmad-method.org/reference/agents/) |
| **GSD (Get Shit Done)** | discuss → plan → execute → verify | Phase plans under a project dir | Built for context rot: each atomic plan runs in a fresh subagent context and the main session stays small. About 50 markdown files, a Node helper, and hooks. [source](https://github.com/gsd-build/get-shit-done) |
| **Superpowers** (obra) | brainstorm → write-plan → execute-plan, plus TDD/debug skills | Plans as markdown | Skills trigger automatically and it uses worktrees. It's a methodology pack more than an artifact system. [source](https://github.com/obra/superpowers) |
| **Kiro** (AWS) | IDE/CLI with requirements → design → tasks | `.kiro/specs/*` | An integrated product rather than a pack, tied to the AWS/Bedrock perimeter. Out of scope unless you want an IDE. |

**Pattern:** every framework independently arrives at *intent → research/design →
task breakdown → execute in fresh context → verify*. They differ mainly in where
artifacts live, how much ceremony each phase has, and whether anything tracks work
beyond one feature.

## B. Work graph and trackers

| Tool | Storage | Local-only? | Agent interface | Split / deps | Notes |
| --- | --- | --- | --- | --- | --- |
| **beads** | Dolt DB in `.beads/` | Yes (`--stealth`, `BEADS_DIR`) | CLI `--json`, MCP | Epics, hierarchical IDs, `blocks`/`parent`/`related` deps, gates | Built for agents. Heavy dependency (Dolt, migrations). See research 01. |
| **Backlog.md** | Markdown files, one task per file, in `backlog/` | Yes (plain files; you could git-ignore them) | CLI + MCP server | Dependencies, milestones, acceptance criteria, definition of done | Terminal kanban + web UI. Markdown-native, so tasks are reviewable as documents. [source](https://github.com/MrLesk/Backlog.md) |
| **Task Master** (`task-master-ai`) | `.taskmaster/tasks/tasks.json` | Yes | CLI + MCP | PRD → tasks with dependencies and complexity scores, `next` | PRD-parsing flow. JSON isn't pleasant to review by hand. [source](https://github.com/eyaltoledano/claude-task-master) |
| **spec-kitty lanes** | Event JSONL per mission | Committed by default | CLI | WPs with deps | Only inside spec-kitty. |
| **GitHub Issues / Projects** | GitHub | No | `gh` CLI, MCP | Sub-issues, project boards | Good if work is public or team-facing. Fails requirement 5 for artifacts, but could hold only the *index*. |
| **Linear** | SaaS | No | Hosted MCP (Apr 2026), agent delegation | Projects, cycles, initiatives, sub-issues | Strong agent story: delegate an issue to a coding agent. SaaS, so it fails the local requirement. [changelog](https://linear.app/changelog/2026-04-23-linear-agent-mcp-support) |
| **Jira** | SaaS / DC | No | MCP servers | Epics, subtasks | Only if an employer requires it. |
| **Plain files we own** | `ledger.md` or `work/*.md` with front matter | Yes | Any agent reads files | Whatever we define | Zero dependencies. We'd have to build queries ("what's ready?") ourselves. |

## C. Execution and orchestration

| Tool | What it orchestrates | Notes |
| --- | --- | --- |
| **rpiv-workflow** (`/wf`) | Typed skill graphs in detached Pi sessions | JSONL runs, resume, loops, fan-out, judges, per-stage models. Pi-only. |
| **Claude Code subagents** | One-shot delegation from a session, with custom agent definitions (`.claude/agents/*.md`), per-agent model and tools | Cheap and available now. Subagents can't talk to each other; the parent synthesizes. |
| **Claude Code Agent Teams** | A lead plus teammates with a shared task list and messaging | Experimental and off by default (per 2026 guides, unverified). Worth watching for requirement 6. |
| **Gas Town** (Yegge) | 20–30 parallel agents on beads: Mayor, Polecats, a Refinery merge queue | Very large (~189k LOC Go per reports). An example of where beads-based orchestration leads. [post](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04) |
| **Vibe Kanban** | Kanban cards that each spawn an agent (Claude Code, Codex, and others) in a worktree | Also an MCP server, so agents can create and move cards. A good human review surface for parallel work. [source](https://github.com/BloopAI/vibe-kanban) |
| **Foolery / BeadBoard** | UIs on beads with wave planning, a verification queue, and live terminals | BeadBoard's runtime is built on Pi (per beads' community list). |
| **spec-kitty `next` + orchestrator** | WP dispatch into worktrees | Only within spec-kitty. |

## D. Review surfaces

| Tool | What it shows | Notes |
| --- | --- | --- |
| **Plannotator** | Plans, diffs, files, and URLs with inline annotation | Already installed as a skill on this machine. A strong fit for "review the plan before implement". |
| **OpenSpec / spec-kitty dashboards** | Change and mission status | Tied to their formats. |
| **beads UIs** (beads-ui, bd-board, BeadSpec) | Boards, dependency graphs, gate queues | BeadSpec shows OpenSpec changes next to beads, which is close to our "documents + graph" idea. |
| **`html-report` (this repo)** | Any markdown rendered as a phone-friendly page | Covers requirement 7. It's read-only; annotation would come from Plannotator or artifact comments. |

## Takeaways

1. **Slot A is crowded and converging.** We should *borrow* method ideas, not pick a winner.
   The distinct ideas worth keeping are rpiv's contracts and acceptance-first, OpenSpec's
   living spec, BMAD's self-contained story shards, and GSD's fresh-context atomic plans.
2. **Slot B is the real decision.** The local-first candidates are beads (graph, DB,
   heavy), Backlog.md (markdown, light), Task Master (JSON), or our own files. Each makes
   a different tradeoff between queryability and reviewability.
3. **Slot C depends on the host.** On Pi, rpiv-workflow already exists. On Claude Code
   we'd use subagents now and watch Agent Teams. Picking a host is an open decision
   (see research 03).
4. **Slot D is nearly solved** by combining Plannotator (interactive review), `html-report`
   (phone reading), and whatever board the slot B choice provides.
