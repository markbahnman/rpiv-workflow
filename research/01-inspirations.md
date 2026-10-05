---
title: The four inspirations
subtitle: How rpiv-mono, OpenSpec, spec-kitty, and beads model phases, artifacts, revision, decomposition, and orchestration.
eyebrow: rpiv-workflow · research 01
date: 2026-09-28
status: done
tags: [survey, inspirations]
---

# The four inspirations

Pinned versions read for this survey (submodules under `research/inspirations/`):

| Project | Commit | Version | Language / runtime |
| --- | --- | --- | --- |
| rpiv-mono | `d74b1c9` | v2.11.0 (+2) | TypeScript, runs inside the Pi agent |
| OpenSpec | `79b6aa9` | 1.13.2 (+1) | TypeScript CLI (Node ≥ 20.19) |
| spec-kitty | `da6d0af` | 4.0.0 RC line on `main` | Python CLI (3.11+) |
| beads | `ce512c3` | main | Go CLI and Dolt database |

## At a glance

| Question | rpiv-mono | OpenSpec | spec-kitty | beads |
| --- | --- | --- | --- | --- |
| What is it? | Skill pipeline + typed workflow runner | Spec/change artifact format + CLI | Mission runtime + governance | Work-graph tracker |
| Phases | discover → research → design/blueprint → plan → implement → validate → review → commit | explore → propose → apply → archive | charter → specify → plan → tasks → implement → review → accept → merge → retro | None (you bring the workflow) |
| Artifact format | Markdown + YAML front matter, schema-checked "contracts" | Markdown with strict requirement/scenario structure, spec deltas | Markdown + JSON/YAML sidecars + event log | Rows in Dolt (SQL). Text lives in fields. |
| Location | `<project>/.rpiv/artifacts/<bucket>/` (git-ignored) | `<project>/openspec/` (committed) or a separate "store" repo | `<project>/kitty-specs/<mission>/` (committed) | `<project>/.beads/` or `$BEADS_DIR` (DB) |
| Revision | `revise`, `amend`, `design --resume`: edit in place | Edit any artifact at any time. Git is the history. | Review cycles per WP, event log | Update fields. Dolt has cell-level history. |
| Split / decompose | `slice` → per-slice design → `synthesize` (within one run) | Separate changes. Stacking awareness in progress. | WPs with dependencies, lanes, and owned files | Epics, hierarchical IDs, `dep add`, molecules |
| Cross-run tracking | None. The README calls ticketing "a separate piece of work". | `tasks.md` checkboxes, dashboard | Kanban lanes, dashboard, `next` | Core purpose: `bd ready`, claim, close |
| Subagents / models | 15 named subagents, per-stage model/effort config | None built in | Agent profiles per WP role; worktrees for parallelism | Via orchestrators on top (Gas Town, Foolery, and others) |
| Host coupling | Pi only | 20+ agents via generated skills/commands | 15+ agents via commands | Any agent (CLI + JSON, MCP) |

## rpiv-mono

**Sources:** `packages/rpiv-pi/docs/{workflows,skills}.md`, `packages/rpiv-pi/skills/plan/SKILL.md`,
`packages/rpiv-workflow/docs/workflow-basics.md`, `README.md`, `roadmap.md`.

### Model

- **~30 skills** grouped as intent/research (`discover`, `research`, `explore`, `slice`),
  design (`design`, `design-slice`, `design-review`, `synthesize`), planning (`plan`,
  `blueprint`, `acceptance`, `quick-plan`, `elaborate`, `revise`, `amend`), and execution/verification
  (`implement`, `validate`, `remediate`, `code-review`, `architecture-review`, `grade`, `commit`).
  Utilities include `create-handoff`/`resume-handoff` and `annotate-guidance`.
- **Contracts.** Every skill declares `contract.produces` / `contract.consumes` in its
  front matter: an `artifactKind` plus a JSON schema over the artifact's front matter
  (for example, `plan` must have `phases[]` and `phase_count`, and consumes a `design`
  with `status: ready`). The runner uses these contracts to wire stages together
  without naming paths.
- **Artifacts** are `.rpiv/artifacts/<bucket>/<timestamp>_<slug>.md`, git-ignored
  by design (`rpiv-site/.../handoffs.md`). Front matter carries `date`, `author`,
  `commit`, `branch`, `topic`, `tags`, `status`, `parent` (the upstream artifact's
  path), and `last_updated`. Lineage is a chain of `parent` paths.
- **rpiv-workflow (`/wf`)** runs typed stage graphs: each stage runs in a detached
  child session, state is an append-only JSONL trail (`.rpiv/workflows/runs/<id>.jsonl`),
  and runs are resumable (`/wf @<run-id>`). It supports predicate routing, loops
  with budgets, fan-out/fan-in, judges and `panel()` voting, and per-stage `verify`.
  Workflows are TypeScript files layered built-in → user → project.
- **Built-ins:** `build` (slice, parallel design, gates, elaborate, implement),
  `ship` (small tasks with acceptance frozen before planning), `vet`, and `polish`.
  The review loops gate on `blockers_count`.

### Strengths for our goals

- The best **phase discipline** of the four: research that documents what exists
  without suggesting changes, designs verified slice by slice, and acceptance frozen
  *before* planning so the plan can't narrow its own scope.
- **Machine-checkable artifact contracts** make artifacts composable and let stages be swapped.
- Local, git-ignored artifacts already match requirement 5.
- Per-stage model and effort control plus fresh-context subagents give requirement 6
  a head start, and the roadmap is explicitly working on verification under cheaper models.

### Gaps

- **No layer above the run.** Nothing tracks "these five runs belong to one project",
  what's blocked, or what's next. Handoffs are the only cross-session bridge.
- **Revision is in place.** `revise` and `amend` rewrite the plan. The prior
  version survives only in the run trail or in your memory, because `.rpiv/` is
  git-ignored and has no history of its own.
- **Splitting happens only inside a run** (`slice`). There's no first-class way to say
  "this research doc spawns three independent workflows".
- **Pi-only.** Claude Code and other hosts would need a port. Non-Pi hosting is on
  the roadmap as "possible", not planned.
- No index or query over artifacts beyond listing directories (`_shared/list-recent.mjs`).

### What to take

Contract front matter, bucketed artifact kinds, acceptance-before-plan, the
research-documents-don't-judge rule, JSONL run trails, fresh-context verifiers, and
per-stage model tiers.

## OpenSpec

**Sources:** `docs/concepts.md`, `docs/customization.md`, `docs/stores-beta/user-guide.md`,
`schemas/spec-driven/schema.yaml`, `openspec/work/simplify-context-and-workspace-model/goal.md`,
`openspec/initiatives/context-store-and-initiatives/README.md`.

### Model

- **Two trees:** `openspec/specs/<capability>/spec.md` is *what is true* (behavior
  contracts: `### Requirement:` with SHALL/MUST plus `#### Scenario:` Given/When/Then),
  and `openspec/changes/<id>/` is *what is in motion* (`proposal.md`, `design.md`,
  `tasks.md`, and delta specs marked ADDED/MODIFIED/REMOVED). `archive` merges the
  deltas into the living specs.
- **Schemas are data.** `schema.yaml` declares artifacts, their templates,
  instructions, and a `requires:` DAG. Teams can define their own workflow artifacts,
  and `config.yaml` injects project context and per-artifact rules into every prompt.
- **Fluid by design:** "no phase gates, work on what makes sense". `validate`
  checks structure, not quality.
- **Stores (beta):** a standalone git repo that only does planning, registered by
  name on each machine (`--store team-plans`). A code repo can point at it with
  `store: team-plans` in its config. OpenSpec never clones or pushes stores itself.
- **Current direction** (their own `work/` experiment): *"Specs are what is true.
  Work is what is in motion."* A `work/<id>/` folder holds `goal.md`, `roadmap.md`,
  `runbook.md`, and `slices/`. They explicitly avoid global `decisions.md` and
  `questions.md` files, and they retired "initiatives", "context stores", and
  "workspaces" as product nouns because they were too many concepts.

### Strengths for our goals

- The **living spec** is the one thing none of the others has: a durable statement
  of current behavior that outlives each change. It answers "what did we decide the
  system does?" months later.
- **Delta specs** make review of a change's *behavioral* impact easy.
- A **store** gives a clean answer to requirement 5 without git-ignoring anything:
  keep planning in its own local git repo, versioned, and never push it.
- Lightweight enough to adopt for part of a workflow.

### Gaps

- **No research phase artifact.** `explore` is conversational.
- `tasks.md` is a flat checklist with no status engine, dependencies, or claims.
- No execution runner, subagent model, or verification gates.
- Specs are committed to the product repo by default, which conflicts with requirement 5
  unless you use a store.

### What to take

Living specs plus change deltas, schema-as-data artifact DAGs, the project
`context:`/`rules:` injection pattern, stores as a local planning repo, and the
lesson of their retired initiative model: every extra noun costs adoption.

## spec-kitty

**Sources:** `README.md`, `docs/architecture/{mission-system,kanban-workflow,artifact-placement-seam}.md`,
`kitty-specs/write-surface-coherence-01KVTVZS/`.

### Model

- **Mission types** (`software-dev`, `research`, `plan`, `documentation`) are
  doctrine packs that define steps, templates, and guards. A **mission** is
  `kitty-specs/<slug>-<ULID>/`.
- **A mission folder** holds `spec.md`, `plan.md`, `research.md`, `data-model.md`,
  `contracts/`, `tasks.md`, `tasks/WPnn-*.md` (one prompt per work package),
  `meta.json`, `status.events.jsonl` (event-sourced status), `status.json`,
  `lanes.json`, `acceptance-matrix.json`, `retrospective.yaml`, and per-WP
  `review-cycle-N.md`.
- **Work package front matter** has `dependencies`, `requirement_refs: [FR-001…]`,
  `owned_files`, `authoritative_surface`, `role`, `agent_profile`, `subtasks`,
  `history`, and branch targets. That gives it traceability from requirement to WP
  to files.
- **Kanban:** 9 lanes (`planned → claimed → in_progress → for_review → in_review →
  approved → done`, plus `blocked` and `canceled`) and 27 guarded transitions. Each
  WP runs in its own git worktree under `.worktrees/`. `spec-kitty next` tells an
  agent what to do, and there's a local dashboard.
- **Governance:** a charter, `dispatch` that opens an "Op record", and retrospectives
  generated after each mission, which feed proposals back into doctrine.

### Strengths for our goals

- Strongest **traceability and parallel-safety** story: FR IDs, owned files, and worktrees.
- **Event-sourced status** (append-only JSONL) is a good pattern for auditable progress.
- **Retrospectives** close the loop from outcomes back into process, which relates to
  requirement 2 ("revise the workflow as assumptions change").
- The mission-type idea means research, planning, and docs work get their own shapes.

### Gaps

- **Heavy.** The architecture docs spend pages on where an artifact physically lives
  (`artifact-placement-seam.md` describes a 5-layer placement resolver, written
  because "three missions in a row spent their discovery budget re-deriving facts").
  That's a warning sign for our own design.
- Artifacts are committed in the repo, which conflicts with requirement 5.
- Fast-moving: a 4.x RC, and removed flags (`--feature` → `--mission`).
- Python toolchain, and it's tied to its own git topology (coordination branches, lanes).

### What to take

Work-package front matter (deps, requirement refs, owned files, role), an append-only
status event log, lane semantics (especially `for_review`/`in_review` as separate
states), review-cycle files, retrospectives, and mission types. Leave the placement machinery.

## beads

**Sources:** `README.md`, `docs/workflows/{index,molecules,gates}.md`, `docs/community-tools.md`,
`docs/related-projects.md`.

### Model

- An **issue graph for agents**: `bd create`, `bd dep add`, `bd ready` (unblocked
  work), `bd update --claim` (atomic claim), and `bd close`. Hash IDs (`bd-a1b2`)
  avoid merge collisions. Hierarchical IDs (`bd-a3f8.1.1`) express epic → task →
  subtask. There are graph links (`relates-to`, `supersedes`, `duplicates`).
- **Storage** is Dolt (versioned SQL) in `.beads/`, embedded or as a server.
  `--stealth` plus `BEADS_DIR` gives local-only use with no git operations.
  `bd dolt push/pull` syncs across machines.
- **Workflows as data:** a *formula* (TOML) is cooked into a *proto* (template epic)
  and poured into a *molecule* (real beads). *Wisps* are ephemeral molecules.
  *Gates* park a step until a human, a timer, a GitHub run/PR, or another bead
  resolves it.
- **Agent memory:** `bd prime` injects workflow context plus `bd remember` notes.
  Compaction summarizes old closed issues.
- **Ecosystem:** many UIs (beads-ui, bd-board, BeadSpec, which imports OpenSpec task
  lists) and orchestrators (Gas Town, Foolery, BeadBoard, which is built on Pi).

### Strengths for our goals

- Directly addresses requirements 3 and 4: splitting is `create --parent`, and
  orchestration over time is `ready`/`claim`/`close` over a dependency graph.
- **Gates** map naturally onto our human checkpoints (design review, plan approval).
- **Formulas** could encode the RPIV phases themselves as a reusable template
  (research → design → plan → implement → validate as dependent beads), which gives
  any work item a visible workflow position.
- Local-only mode fits requirement 5. The JSON CLI suits subagents.

### Gaps

- **Not a document store.** Long research or plans don't belong in issue fields, so
  beads should *point at* markdown artifacts, not contain them.
- **Operational weight:** a Go binary, Dolt, schema migrations with version guards,
  and a fast-moving project. Its own README spends a section on upgrade procedure.
- Community tools warn that the old `.beads/issues.jsonl` is an export, not the
  source of truth. Anything we build must go through the `bd --json` CLI.

### What to take

The ready-frontier model, claims, gates, formulas as workflow templates, hash IDs,
and the "tracker points at documents" split. Evaluate it as the orchestration layer
rather than rebuilding it.

## Cross-cutting observations

1. **Every tool has converged on a three-layer shape**, even when one tool fills
   only one layer: **documents** (what we think), **work graph** (what we're doing),
   and **execution** (who is doing it now). rpiv is strong on documents and execution,
   beads on the work graph, OpenSpec on documents, and spec-kitty tries to do all
   three and pays for it in complexity.
2. **Status belongs in an append-only log, not in the document.** spec-kitty's
   `status.events.jsonl` and rpiv's run JSONL both do this. Documents that carry
   mutable status fields (`status: in-progress`) drift.
3. **Identity should not be a file path.** spec-kitty uses ULIDs, beads uses hashes,
   and rpiv uses timestamp slugs plus `parent:` paths, which break if files move.
4. **The lighter tools are winning adoption** (OpenSpec's stated philosophy and its
   own retreat from initiatives and stores), and the heavy ones document their own
   complexity problems.
