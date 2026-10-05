---
title: RPIV Thin Layer
subtitle: Phase 1 design. One Pi extension joins rpiv, beads, and a private artifact store, without forking any of them.
eyebrow: rpiv-workflow · phase 1 report
date: 2026-10-01
status: review
tags: [design, pi, beads]
---

## Your decisions, applied

| You said | So the design does this |
| --- | --- |
| Keep using Pi | Build a **Pi extension** on top of rpiv-pi and rpiv-workflow |
| Only you read artifacts | No SaaS mirror. Gates stay light. |
| Private git is fine | One artifact store repo, `~/rpivw`, with a private remote |
| Long-lived projects | **Living specs** are in scope (OpenSpec-style) |
| Try Dolt + beads | beads is the work graph |

## The shape

> [!IMPORTANT] One extension, no forks
> rpiv-workflow already publishes every run's stage events (`registerLifecycle`) and
> accepts runs started by another extension. Our extension listens to those events and
> drives `bd --json`, so rpiv and beads stay unmodified and upgradable.

- **Store.** `~/rpivw/projects/<repo>/` holds the artifacts and is mounted into each
  checkout at `.rpiv/artifacts` through a directory junction. Every git worktree shares
  one store, every stage auto-commits, and each run pushes to the private remote.
- **Beads bridge.** `/work new`, `/work next` (what's ready, with linked docs),
  `/work start <bead>` (claim and run `/wf`), `/work status`, and `/work approve <gate>`.
- **Revision trail.** Store commit messages and bead comments record *why* a plan
  changed. During implement, the model calls a `work_deviation` tool. A major deviation
  parks the run behind a human gate until you approve.
- **Split.** `/split <artifact>` creates child beads with dependencies and origin links.
  A child can start at design and reuse its parent's research.
- **Reports.** `/work report` renders ready, in-progress, blocked, and pending gates to
  a phone page in your Drive folder.

## Build order

| | Milestone | Done when |
| --- | --- | --- |
| M0 | Install bd + dolt, smoke-test on Windows | `bd ready --json` works and a push round-trips |
| M1 | Store, junction mount, auto-commit | A research run lands in `~/rpivw`, from a worktree too |
| M2 | `/work` commands + lifecycle → beads | A `/wf ship` run started from a bead closes it |
| M3 | Envelope stamping, deviation tool + gates | A plan deviation parks the run with a trail |
| M4 | `/split` + a "start at design" pack | One spike becomes three linked children |
| M5 | Weekly phone report | This page, generated from beads |
| M6 | Living specs | A feature's behavior delta merges into `specs/` |

## Things to verify first

> [!WARNING]
> - rpiv reads and writes correctly through a directory junction.
> - rpiv's artifact contracts tolerate extra front-matter keys (`id`, `work`, `run`).
> - `bd dolt push` can share the store's private remote.

## What I need from you

> [!QUESTION]
> 1. Review the design (`research/05-thin-layer-design.md`), especially the store layout and default gates.
> 2. OK to install **bd** and **dolt** (M0)?
> 3. Which private git host should the store use, and a name for the extension (placeholder: `rpivw`)?
> 4. Should the extension's source live in this repo under `extension/`?
