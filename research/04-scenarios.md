---
title: Gamed-out scenarios
subtitle: Six realistic tasks walked through five candidate tool stacks, to see where each one creaks before we run real mock workflows.
eyebrow: rpiv-workflow · research 04
date: 2026-09-28
status: done
tags: [scenarios, stacks, tradeoffs]
---

# Gamed-out scenarios

These are thought experiments, not mock runs. Their job is to find the questions
the real mock workflows (Phase 2) should answer. They build on
[03 needs](03-rpiv-needs.md).

## Candidate stacks

| ID | Stack | Artifacts | Work graph | Execution |
| --- | --- | --- | --- | --- |
| **S1** | rpiv as-is | `.rpiv/artifacts/` (project, git-ignored) | None (handoffs + memory) | Pi `/wf` |
| **S2** | rpiv + beads | rpiv-style, in a user-level store with git history | beads (stealth), RPIV formula + human gates | Pi `/wf` or Claude Code skills |
| **S3** | OpenSpec store + Backlog.md | OpenSpec changes/specs in a local store repo, plus rpiv-style research docs | Backlog.md pointed at the store | Claude Code skills (rpiv methods ported) |
| **S4** | spec-kitty wholesale | `kitty-specs/` (committed) | spec-kitty lanes | spec-kitty `next` + worktrees |
| **S5** | Build lean | Our envelope, user-level store | Our own markdown/JSONL ledger | Claude Code skills + subagents |

## Scenario 1: Quick bug fix

> *"The date picker shows the previous day for users west of UTC."* About an hour of work.

| Stack | How it goes | Friction |
| --- | --- | --- |
| S1 | `/wf ship` → goal, one targeted research dispatch, acceptance, quick-plan, implement, validate, commit | Low. `ship` was designed for exactly this. |
| S2 | Same as S1, plus `bd create` and `bd close`, or pouring a formula for one bug | A formula is overkill here. We need a "no molecule" path. |
| S3 | An OpenSpec change for a bug with no behavior change needs `skip_specs: true`, plus a Backlog.md task | Two tools for a one-hour fix |
| S4 | specify → plan → tasks → WP → review → accept → merge | Heavy. The README itself says it's "overkill for one-off edits". |
| S5 | A `quick` skill: research-lite → plan → implement → validate → outcome, plus one ledger line | Low, if we build the tiering |

**Takeaway:** every stack needs a **size tier** where the tracker entry and outcome
are one-liners. The question for mocks is whether the minimum record (goal + outcome)
is worth writing for a one-hour fix. Probably yes, because it's what future research finds.

## Scenario 2: Assumptions break mid-implementation

> *"Add CSV export to the reports page."* The plan has four phases. During phase 3 the
> agent finds that reports are paginated server-side, and a naive export would time out.
> Streaming is needed, which changes phases 3 and 4 and adds a phase.

| Stack | How it goes | Friction |
| --- | --- | --- |
| S1 | Stop implement → `/skill:revise <plan>` → resume implement | Works, but the old plan is overwritten and `.rpiv` has no history. The "why" survives only in the session. |
| S2 | Same revise, but the store auto-commits so the diff is kept. The plan's revision log records the trigger. The implement bead gets a comment; a gate could force driver approval of the revised plan. | The most complete trail. Needs the auto-commit hook. |
| S3 | Edit `design.md` and `tasks.md` in the change (OpenSpec is fluid). Git in the store keeps history. | No structured "deviation" concept, so the why depends on discipline |
| S4 | The WP goes back to `planned` with review feedback. The plan is edited. The event log records the transitions. | The status history is good, but re-planning inside a mission is clunky |
| S5 | A deviation entry is appended automatically by implement, then `revise` runs | We'd build what S2 gets from rpiv |

**Takeaway:** the **deviation log + versioned store** combination is the single most
valuable feature for requirement 2, and no stack has it out of the box. It's a small
build (a revision-log convention plus auto-commit) that works on top of rpiv.
**Mock question:** should a major deviation *require* a driver gate, or just notify?

## Scenario 3: A research spike that splits

> *"Should we replace our homegrown job queue?"* Research concludes: keep the queue,
> but (a) move email jobs to the new retry policy, (b) add dead-letter handling, and
> (c) remove the cron wrappers. These are three independent pieces of work of different sizes.

| Stack | How it goes | Friction |
| --- | --- | --- |
| S1 | Research artifact exists. You start three separate `/wf` runs and paste the research path into each. | No record that the three runs came from one spike. Nothing tracks that (c) waits on (a). |
| S2 | `split` creates epic + three child beads with `origin: art_…#recommendations` and `bd dep add c a`. Each child starts at design, reusing the research. `bd ready` shows (a) and (b). | The best fit. Requires the `split` skill. |
| S3 | Three OpenSpec changes plus three Backlog.md tasks with a dependency | Works. The link back to the spike is by convention only. |
| S4 | A `research` mission type, then three `software-dev` missions | The cross-mission link is weak and there's heavy setup per mission |
| S5 | `split` writes three ledger entries | We'd also build dependency queries |

**Takeaway:** splitting is where a **real work graph earns its keep**. Starting
children *mid-pipeline* (at design, reusing parent research) needs artifact contracts
that accept "research from a parent work item". rpiv's contracts can express this,
but only within one run today.

## Scenario 4: A multi-week project with weekly reporting

> *"Offline mode for the mobile app."* About eight work items over five weeks, with
> dependencies (storage layer → sync engine → conflict UI). A weekly progress page
> goes to the phone.

| Stack | How it goes | Friction |
| --- | --- | --- |
| S1 | Many runs and handoffs. Progress is reconstructed by hand from artifact folders. | No project view at all |
| S2 | Epic with children and deps. A weekly report skill reads `bd list --json` and outcome artifacts, then renders through `html-report`. Gates show where the driver is the bottleneck. | Good. Board UIs (beads-ui, bd-board) are free extras. |
| S3 | Backlog.md board + milestones. The report reads task files and change folders. | Good. Markdown tasks read nicely in the report. |
| S4 | Multiple missions and the dashboard | The dashboard is per mission; cross-mission roll-up is weaker |
| S5 | We build the roll-up | Most of the work is building the tracker |

**Takeaway:** S2 and S3 are close here. **Mock question:** on a real multi-item
project, does beads' graph power (ready, claims, gates) matter more than Backlog.md's
readable task files? The report generator is the same small build either way.

## Scenario 5: Delegated fan-out

> *"Rename the logger API and add structured fields at about 60 call sites."*
> Mechanical, highly parallel, and cheap per unit.

| Stack | How it goes | Friction |
| --- | --- | --- |
| S1 | `blueprint` with phases grouped by `files:`, then implement. rpiv fan-out is for design and elaborate, not implement (worktree isolation is on its roadmap). | Sequential implementation is slow but safe |
| S2 | A formula pours N small beads (a file group each). Workers on a small model claim beads in worktrees. A verifier bead per group runs on another model. | Needs a worker loop (a Claude Code subagent per bead). Merge overhead. |
| S3 | Backlog.md tasks + Claude Code subagents | Claims and collisions are handled by hand |
| S4 | WPs with `owned_files`, one worktree per lane | Designed for this. Setup cost is high for a rename. |
| S5 | The orchestrator splits by file group and dispatches subagents with `isolation: worktree` and a mid-tier model, then a fresh-context verifier | Works today with Claude Code primitives. No persistent claims. |

**Takeaway:** for work finished in one sitting, **plain subagent fan-out** (S5-style)
is enough, and a persistent tracker adds little. Persistent claims matter only when
fan-out spans sessions or days. This suggests a design rule: **the tracker holds work
items; subagent fan-out within a run doesn't need to touch it.**

## Scenario 6: Cold resume after ten days

> A fresh agent (or you, on a phone) needs to know "where is the offline-mode project,
> and what do I do next?"

| Stack | What they read | Friction |
| --- | --- | --- |
| S1 | The latest handoff, if one was written, then the artifact folders | High, since it depends on having written a handoff |
| S2 | `bd ready` + `bd prime` (memory), then the artifacts linked from the ready bead | Low |
| S3 | The Backlog.md board, then the linked change folder | Low |
| S4 | `spec-kitty next` | Low within a mission |
| S5 | Our ledger + a `status` skill | As good as we build it |

**Takeaway:** "what's next" should be **one command** that returns the ready work
items and their linked artifacts. The weekly HTML report is the human version of that command.

## Scorecard

Qualitative: ●●● strong, ●● workable, ● weak. Reasoning is in the scenario tables above.

| Requirement | S1 rpiv | S2 rpiv + beads | S3 OpenSpec + Backlog.md | S4 spec-kitty | S5 build lean |
| --- | :-: | :-: | :-: | :-: | :-: |
| 1. Reviewable artifacts | ●●● | ●●● | ●●● | ●● | ●● |
| 2. Revise as assumptions change | ●● | ●●● | ●● | ●● | ●● |
| 3. Split at any time | ● | ●●● | ●● | ● | ●● |
| 4. Orchestration over time | ● | ●●● | ●●● | ●● | ● |
| 5. Local artifacts | ●●● | ●●● | ●●● | ● | ●●● |
| 6. Subagents / model tiers | ●●● | ●●● | ●● | ●● | ●● |
| 7. Phone-readable progress | ● | ●● | ●● | ●● | ●● |
| Setup and operating cost (●●● = cheapest) | ●●● | ●● | ●● | ● | ● |
| Low lock-in (●●● = least) | ● | ●● | ●●● | ● | ●●● |

## What this suggests

> [!NOTE] Update 2026-10-01
> The driver chose Pi + beads, so **S2 is the direction** and S3 is dropped. Living specs
> are still borrowed from OpenSpec. The mocks now compare ways of mapping RPIV onto beads
> (see [05](05-thin-layer-design.md)).

> [!DECISION] Proposed direction (for confirmation)
> Treat **S2 (rpiv methods + beads)** and **S3 (OpenSpec store + Backlog.md)** as the two
> finalists. Build a thin, shared layer both need regardless of tracker: the artifact
> envelope, the user-level store with auto-commit, the revision/deviation log, the
> `split` skill, and the weekly report. Then run the same mock scenarios on both.

Small builds that pay off in every stack:

1. **Store + envelope:** a user-level artifact store with git history and an envelope validator (C1, C2).
2. **Revision/deviation convention:** a revision log in each artifact plus auto-commit at stage boundaries (C3).
3. **`split` skill:** children with `origin` links, written to whichever tracker is chosen (C4).
4. **`status` / weekly report:** ready work + outcomes → `html-report` (C8).

## Questions the mock runs must answer

1. Is the minimum record for a quick fix (goal + outcome) worth writing? (S1)
2. Should a major plan deviation *block* for driver approval? (S2)
3. Can a child work item start at design and reuse its parent's research without friction? (S3)
4. On a real multi-item project, does the beads graph beat readable markdown tasks? (S4)
5. Where does subagent fan-out stop and tracker-level work begin? (S5)
6. Can a fresh agent resume from one command plus linked artifacts? (S6)

## Revision log

- 2026-09-28: First version, from the Phase 0 survey.
- 2026-10-01: S2 selected after the driver answered the questions.
