---
title: M0 beads smoke test
subtitle: Installing bd and Dolt on Windows, and what a hands-on test of beads changed in the design.
eyebrow: rpiv-workflow · research 06
date: 2026-10-03
status: done
tags: [m0, beads, dolt, windows]
---

# M0: beads smoke test

## Result

> [!TIP] M0 passed
> `bd` 1.3.1 and `dolt` 2.2.0 are installed and pinned. Every beads feature the design
> relies on worked in a stealth database: hierarchical children, blocking dependencies,
> label-filtered `ready`, JSON metadata, claims, comments, and human gates. Dolt data
> pushed to a git remote and pulled back into a fresh clone.

## Install

| Tool | Version | Method | Notes |
| --- | --- | --- | --- |
| beads (`bd`) | **1.3.1**, pinned | `mise use -g github:gastownhall/beads@1.3.1` | Prebuilt Windows release, embedded-Dolt capable |
| dolt | **2.2.0**, pinned | `mise use -g github:dolthub/dolt@2.2.0` | The version beads pins. 2.3.x has a `DOLT_RESET('--hard')` regression (`beads/docs/architecture/dolt.md`, "Which Dolt version to install"). Embedded mode doesn't need this CLI; it's for `dolt sql` and server mode. |

Both are in `~/.config/mise/config.toml`. Upgrade deliberately (`mise use -g …@<ver>`),
never by tracking `latest`. `bd version` warns about "multiple bd binaries", which is
just mise's shim plus its install path and is harmless. `dolt version` nags about newer
releases; ignore it, since the pin is intentional.

## What was tested

Run in a throwaway git repo with `BEADS_DIR` set, `bd init --stealth --prefix rw`, and
`beads.role=maintainer`:

| Feature | Command(s) | Result |
| --- | --- | --- |
| Labeled beads for two projects in one DB | `bd create … -l project:dashboard` | ✓ IDs like `rw-5b3` |
| Children (split) | `bd create … --parent rw-5b3` | ✓ hierarchical IDs `rw-5b3.1`, `rw-5b3.2` |
| Blocking dependency | `bd dep add rw-5b3.2 rw-5b3.1` | ✓ `.2` drops out of `ready` |
| Per-project ready list | `bd ready --json -l project:dashboard` | ✓ only that project's beads |
| rpiv metadata | `bd update --metadata '{"rpiv":{…}}'` | ✓ round-trips in `bd show --json` |
| Claim | `bd update --claim` | ✓ status `in_progress` |
| Comment (revision "why") | `bd comments add` | ✓ |
| Human gate (plan approval) | `bd gate create --blocks <id> --type human --title … --reason …` → `bd gate resolve` | ✓ the bead leaves `ready` while the gate is open and returns after resolve |
| Dolt over git | `bd dolt remote add origin git+file:///…` → `bd dolt push` | ✓ writes `refs/dolt/data` plus a helper branch `refs/heads/__dolt_remote_info__` next to `main` |
| Restore into a fresh clone | `sync.remote` in `.beads/config.yaml` → `bd bootstrap` | ✓ |
| Two-way sync | create in clone → push → `bd dolt pull` in original | ✓ |

The real remote (`git@github.com:<user>/rpivw-store.git`) was only checked read-only
with `git ls-remote`: it exists, it's empty, and SSH auth works. No test data was pushed to it.

## Findings that change the design

1. **One beads database for all projects, not one per project.** Dolt keeps one
   database per git remote, under `refs/dolt/data`. With one store repo, per-project
   databases would collide on that ref. beads routing (`docs/multi-agent/routing.md`)
   chooses *which* database a bead lands in, so it doesn't solve this. Instead, use a single
   database at `~/rpivw/.beads` (prefix `rw`), with a **`project:<key>` label on every bead**.
   `bd ready --label` filters per project. A side benefit for a solo driver:
   `bd ready` with no label gives one cross-project "what's next" list.
2. **The wrapper must label everything it creates.** Children created with `--parent`
   and gates created with `bd gate create` do **not** inherit the parent's labels.
3. **Parse only stdout.** `bd` prints warnings (for example "beads.role not configured")
   that break JSON if stderr is merged into stdout. Spawn `bd` with separate pipes, and set
   `beads.role=maintainer` in the store repo's git config.
4. **Windows path length.** Pushes failed from a very deep temp path and succeeded from
   a short one. `C:\Users\<user>\rpivw` is short. Keep the store near the root of the home directory.
5. **Bootstrap needs an explicit `sync.remote`** when `origin` is a local path, because
   auto-detection produced the invalid `git+C:/…`. With the real SSH origin, auto-detection
   should produce `git+ssh://…`. Set `sync.remote` explicitly anyway, so it's deterministic.
6. **Store `.gitignore`** must include `.beads/` and `.beads.gate.lock` (a lock file `bd`
   left at the repo root during the test).
7. The epic itself appears in `ready` next to its children. `/work next` should show
   epics as headers, not as actionable items.

## Not yet tested

- `bd dolt push` to the real GitHub remote over `git+ssh://` (done at M1 store init).
- Behavior when `bd` runs with a project checkout as cwd and `BEADS_DIR` pointing at the store (the normal M2 case).
- Formulas and molecules (a mock question, not an M0 requirement).
