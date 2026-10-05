---
title: RPIV Workflow Survey
subtitle: Phase 0 findings. What exists for a research → plan → implement → validate workflow, what we'd build, and the questions that decide the next step.
eyebrow: rpiv-workflow · phase 0 report
date: 2026-09-28
status: review
tags: [survey, phase-0]
---

## The short version

> [!IMPORTANT] Proposed shape
> Three loosely coupled layers joined by IDs:
> **artifact store** (markdown documents, local, with its own git history) ·
> **work graph** (adopt beads or Backlog.md; don't build) ·
> **execution** (rpiv's phase methods, made host-agnostic so it runs under Pi or Claude Code).

- **No existing tool covers all seven requirements.** rpiv is the best at phases and
  artifacts but has nothing above a single run. beads is the best work graph but
  doesn't hold documents. OpenSpec has the only *living spec*. spec-kitty does
  everything but is heavy.
- **The biggest gap is revision.** No stack keeps a "why the plan changed" trail out
  of the box. A deviation log plus a versioned artifact store is a small, high-value build.
- **The second gap is splitting.** Turning one piece of research into several
  workflows needs a work-graph operation with lineage links. beads fits best.
- **Keeping artifacts local is harder than it looks.** A git-ignored folder in the
  project (rpiv's approach) is wiped by `git clean` and fragments across git
  worktrees. A user-level store with its own git history avoids both.

## What exists

| Slot | Best candidates | Notes |
| --- | --- | --- |
| Method and artifacts | rpiv-pi, OpenSpec, Spec Kit, BMAD, GSD, Superpowers | Converging on intent → research/design → tasks → fresh-context execution → verify |
| Work graph | **beads**, **Backlog.md**, Task Master, Linear, GitHub | Only beads and Backlog.md are both local and agent-native |
| Execution | rpiv-workflow (Pi), Claude Code subagents / Agent Teams, Gas Town, Vibe Kanban | Host choice drives this |
| Review | Plannotator, tool dashboards, `html-report` | Mostly solved already |

## Finalist stacks

| | S2: rpiv + beads | S3: OpenSpec store + Backlog.md |
| --- | --- | --- |
| Strength | Graph semantics: ready, claims, human gates, formulas as RPIV templates | Everything is readable markdown. Living specs. |
| Weakness | Dolt and Go dependencies, schema migrations | Weaker dependency queries. Links are by convention. |
| Best at | Splitting, multi-week projects, resuming cold | Review, low lock-in |

Both need the same thin layer: an **artifact envelope**, a **local store with
history**, a **revision/deviation log**, a **`split` skill**, and a **status/weekly report**.

## Scenarios gamed out

1. **Quick bug fix:** every stack needs a light tier; spec-kitty is overkill.
2. **Plan breaks mid-implementation:** a deviation log plus a versioned store is the missing piece.
3. **Research spike splits into three:** a real work graph earns its keep here.
4. **Multi-week project:** S2 and S3 tie. Mock runs will decide.
5. **Fan-out of 60 mechanical edits:** plain subagents are enough within one session.
6. **Cold resume after ten days:** needs one "what's next" command.

## Decisions I need from you

> [!QUESTION]
> 1. **Host:** keep using Pi, move to Claude Code, or both?
> 2. **Solo or team:** will anyone else read the artifacts or the board?
> 3. **Backup:** is a private git remote for the artifact store OK, or only this machine plus Drive?
> 4. **Living specs:** long-lived products, or mostly discrete tasks?
> 5. **Tracker appetite:** is installing Dolt and beads fine, or is markdown-only a hard preference?

## Next

Phase 1 designs the thin layer from your answers. Phase 2 runs the six scenarios as
mock workflows on both finalist stacks.

Full detail is in the repo under `research/01`–`04`.
