# Progress

The living status of the project. Agents: read this after `CLAUDE.md`, and update it
at the end of every session.

## Current phase

**Phase 3 (prototype). M0–M2 verified live. M3 built and its gaps closed 2026-10-05; the plan
gate is verified live, the deviation path and plannotator approval are not yet. Next: make the repo
portable so it can be tried on another machine (the driver's work laptop), then M3's exit check, M5,
M4.**

## Roadmap

| Phase | Goal | Status |
| --- | --- | --- |
| 0. Orientation and survey | README/CLAUDE.md, report tooling, inspiration deep dive, landscape, needs, scenarios | Done (2026-09-28) |
| 1. Decisions and thin-layer design | Record the driver's decisions. Design the Pi extension joining rpiv, beads, and the artifact store. | Draft done (2026-10-01), in review |
| 2. Mock workflows | Replay scenarios 1–6 on the chosen stack (rpiv + beads) and answer research 05's mock questions | Planned |
| 3. Prototype (M0–M5) | Build the extension milestone by milestone (research 05 → Build order) | M0 done; M1, M2 verified live; M3 built (2026-10-04) with its gaps closed (2026-10-05), awaiting a live run. M4 next. |
| 4. Living specs and delegation (M6+) | Living specs, model tiers, independent verifiers, cost tracking | Planned |

Phases 2 and 3 interleave: M0–M2 have to exist before the mocks can run for real.

## Done

- 2026-10-12: **A stopped run's report was lost to a Windows command-line limit, and the spawn
  failure underneath hid which tool failed.** Found driving the bead-board run
  `2026-10-06_22-34-07-c86b` (bead rw-2l1) to its stop at rpiv-pi's `implement-scope-check`. 92 tests.
  - `onWorkflowEnd` posts the full stop report as one `bd comments add` argument; this run's report
    measured **125,286 chars** against Windows' 32,767-char `CreateProcess` cap. `execFile` fails
    that case by throwing **synchronously**, so the throw bypassed `exec.ts`'s `{code, stderr}`
    mapping *and* `beads.ts`'s `bd <verb> failed:` prefix — the log read only
    `rpivw: spawn ENAMETOOLONG`, naming no tool, and the comment was silently dropped (the store
    commit, trail archive, and stage records all landed first).
  - Fix: `beads.comment` writes text over 8,000 chars to a temp file and calls
    `bd comments add -f <file>` (verified end-to-end against real bd 1.3.1 with a 125 KB comment,
    which lands intact and is deleted afterwards); `exec.ts` maps a synchronous spawn throw into the
    same `{code, stderr}` shape as an exit, so no caller can lose its prefix again. New
    `test/exec.test.ts`, plus a fake-bd test for the file path and the short-comment argv path.
  - Not a rpivw defect, recorded for the next run: rpiv-pi's unsliced `ship` routes
    `implement-scope-check` with a pass-only `match("verdict", { reconcile: "pass" })`, so its
    tiered `untracked-only`/`excess` verdicts are terminal there by design (build/vet route them to
    `scope-quarantine`). A checkout with **no commits** always yields `untracked-only`, because the
    floor's dirty set is `git status --porcelain` and every file is `??`. The target repo now has its
    baseline commit, which is what the floor needs to mean anything.

- 2026-10-07: **Code review fixes.** A whole-extension review (checked against rpiv-* 2.12.0)
  found a blocker, five concerns, and two smaller issues; all are fixed. 89 tests.
  - Gate stages read the run id from their input envelopes (`OutputMeta.runId`) instead of a
    per-cwd handoff. The deviation route slot is keyed by run, so concurrent tracked runs can't
    take each other's ids or "reimplement" decisions.
  - bd calls share one queue per store on `globalThis`. Stage child sessions open their own
    `Beads` in the same process, so the old per-instance queues ran bd concurrently.
    `patchRpiv` now does its read-modify-write as one queued job, so concurrent loop units can't
    lose each other's updates.
  - A plan gate with no plan says "no plan artifact found", and `gatePlan` only matches `.md`
    paths. Before this, `/work reject` could send `/skill:revise the <notes>`.
  - `/work start` no longer claims the bead; the run claims it when it starts. Before this, a
    refused `/wf` left the bead in progress with no run.
  - `/work review` checks that plannotator is loaded (a `review-status` probe) before it hands
    the plan over, so it can no longer wait forever when plannotator isn't loaded.
  - `/work approve` keeps the notes as typed: only `--reimplement` counts as a flag.
  - New `npm run typecheck` (tsc --noEmit against the installed Pi's types). It found the
    missing `GateDeps.reviewLines` field and some incomplete test fakes.
  - **Blocker, fixed:** `routeThrough` used to wrap every function edge of `build-rpivw`, and
    the wrapper hid the route notes that rpiv's original edges set at runtime. rpiv treats a
    `stop` that carries a note as a blocked gate and halts the run; without the note it finishes
    the run as completed. So a failing validate (or reconcile or scope) gate in `build-rpivw`
    looked like success, and rpivw closed the bead. Now only edges that can return `implement`
    are wrapped (in rpiv-pi's real `build`: 3 of 13 function edges, and none of the
    failure-stop gates), and wrappers (including `deviation-check`'s call to implement's own
    edge) move each pick's note onto the edge the runner holds. Reproduced and re-checked
    against rpiv-workflow 2.12.0's `routing-dsl.ts`. Audit of every run trail in the four
    registered projects: no run was affected. The only `build-rpivw` run (creative_blog
    `2026-10-04_09-59-19-dbdb`, bead rw-1x8) took no decision stop; validate passed and it
    reached commit, so the bead closed correctly.

- 2026-10-05: **M3 gaps closed (3 of 3).** Your notes at a gate now reach the implement lane:
  the decision is recorded in `metadata.rpiv.approvals[<gate>]`, and the stage that took it
  appends a marked `## Reviewer notes` section once to the plan the gate holds — the artifact
  implement already reads, since rpiv-pi wires implement as `acts({ loop: …, reads: ["plans"] })`.
  Appending is marker-guarded because a resume replays the halted stage. Works for plan gates and
  for `--reimplement` on a deviation gate. `/work reject <gate> <notes>` now starts
  `/skill:revise <plan> <notes>` itself instead of printing the command. `/work next` lists the plan
  a gate is holding, with a `file://` link (a link to the *rendered* plan still comes with M5).
  78 tests.
- 2026-09-28: Initialized submodules (spec-kitty and openspec need `core.longpaths` on Windows).
- 2026-09-28: Wrote `README.md`, `CLAUDE.md`, `PROGRESS.md`, and `.gitignore`.
- 2026-09-28: Built the `html-report` skill (`.claude/skills/html-report/`).
- 2026-09-28: Research 01–04: inspirations, landscape, needs, and scenarios.
- 2026-10-01: Recorded the driver's answers (below). Checked the installed Pi (0.87.1)
  extension API and rpiv-workflow's lifecycle and embedding API (2.11.0).
- 2026-10-05: **Research 07: Herdr cannot see rpiv work.** A Pi pane stays `idle` in Herdr's sidebar while an rpiv phase or a `/wf` run is in flight. Cause is structural, not a bug on our side: Herdr's Pi integration (v9) reports state only for the top-level TUI session's own `agent_start`→`agent_settled` loop, rpiv runs every stage in SDK child `AgentSession`s (`sdk-workflow-host.ts`: "the interactive session never executes a stage"), child sessions default to Pi's `"print"` extension mode and are rejected at the TUI gate, and nothing in rpiv-pi/rpiv-workflow/pi-subagents emits any Herdr event. Because the integration holds full lifecycle authority, Herdr also skips screen detection (`screen_detection_skipped:true`), so nothing else can correct the state. Upstream filed it twice and closed both unmerged (#3796 not planned; PRs #3821, #3924 unmerged). Decision: no local workaround; progress stays in rpivw's own surfaces. Note has a re-verify recipe for the next Pi/Herdr upgrade.
- 2026-10-05: **Portability 1–3.** `/work setup [--remote <url>] [--prefix rw]` creates a store or joins one: an empty remote
  gets the first push (git + Dolt), an existing store is cloned and beads restored via `bd bootstrap` with `sync.remote` pinned
  first (its own detection breaks on local paths). It sets `beads.role` (clones lack it) and works without `bd`. `bd init
  --stealth` was checked to touch no global git config. `bd` sends anonymous usage metrics by default, so setup says so.
  `push.remote` (default `origin`) is configurable; a store without it is local-only and never warns. The Pi agent folder
  follows `PI_CODING_AGENT_DIR`. 73 tests, including two "machines" joining over a bare remote.
- 2026-10-05: **plannotator approval resolves the gate.** `/work review` now opens the plan with plannotator's event-bus API
  (`plannotator:request`, action `annotate`, `gate: true`) instead of `/plannotator-annotate`, and applies the decision when it
  arrives: Approve resolves the gate and resumes the run; annotations go on the bead and start `/skill:revise`; Close does
  nothing. Checked against plannotator pi-extension 0.27.25's real listener (request shape and channel). 67 tests. Not yet
  verified live with the browser.
- 2026-10-04: **Fix: first plan gate crashed + `/work review`.** The `blog-b` project's `build-rpivw` run (rw-1x8) stopped with
  `plan-approval script threw: Cannot read properties of null (reading 'filter')`. `bd gate list --json` prints `null`, not
  `[]`, when no gates exist (the store's first gate). All of bd's list calls now normalize `null` to `[]`, and the real-bd test
  covers an empty DB. The halt reason now reads `⏸ waiting for plan approval (gate …): /work review … · /work approve …`
  (rpiv has no paused state for script stages, so the toast still says "script threw"). New `/work review [<gate>]`: plannotator
  (`/plannotator-annotate`), a `file://` link, and a `hunk diff` command from the store history. 65 tests.
- 2026-10-04: **Fix: stale ctx after `/new`.** The `blog-a` project's `build` run (rw-nqt) finished hours after the session that
  started it. Its end-of-run store push failed (cause not recorded), and the warning was sent through a command ctx captured by
  `/work start`, which Pi rejects after session replacement, so the listener threw into rpiv. The bead closed correctly. The store
  was left 44 commits unpushed. Fixed: notifications go through a never-throwing wrapper that falls back to the newest session's
  UI. Commands no longer rebind the session notifier. Warnings are logged to `~/rpivw/.git/rpivw.log`, push errors show the
  `fatal:` line, and session start warns about unpushed store commits. 61 tests. Pi is now 1.0.2 (managed install). The extension
  APIs it uses were re-checked.
- 2026-10-04: **M3 complete (part 2): deviations.** The driver installed rpivw via Pi settings `packages`. `/work start` now
  runs `<name>-rpivw` (ship/build/vet/polish, derived at runtime): `deviation-check` after implement, plus `plan-approval` for
  configured workflows (renamed from `build-gated`). The `work_deviation` tool (minor: log/notify, continue; major: deviation
  gate, the model stops, the run halts after implement). `/work approve <gate> [--reimplement]` continues or loops back to
  implement once. Verified on rpiv-workflow 2.12’s real runner and validator. 59 tests.
- 2026-10-04: **M3 (part 1): stamping + async plan approval + child-session safety.** Front matter gets one `rpivw:`
  block (id/work/run/workflow; the id survives `revise` via store history). `build-gated` is derived at runtime from rpiv-pi’s
  live `build`, with a `plan-approval` script stage before `implement`. `/work approve|reject`, plus gates in `/work next` and
  tab completion. Verified with rpiv-workflow 2.12’s real runner (halt → re-halt → approve → complete) and its validator (no
  new issues vs. base). Found that rpiv child sessions load extensions from disk: `--extension` doesn’t reach them, and a
  permanent install would have let children replace the launcher’s lifecycle hook, so children are now detected and skipped.
  55 tests. - 2026-10-04: **M2 verified live** by the driver in `blog-a`: `/work new` → `/work start` → the linked run updates the bead.
  `/work start` now skips in-progress beads (resume with `/wf @<run>`, or `--force`).
- 2026-10-04: **Tab completion for `/work`** (`src/complete.ts`): subcommands, bead IDs by ID prefix or title word
  (`status`, `start`, `new --parent`), workflows after `start <bead>`, and flags. Bead lists come from a 15s background-refreshed
  cache. Verified against live beads in `blog-a`. 42 tests.
- 2026-10-03: **`/work init` handles new projects:** in a folder with no repo it offers `git init -b main` (or `--git`),
  refusing in home, at a filesystem root, or in the store. Empty repos get a generated `local__<hex>` key. The key is pinned in
  local git config (`rpivw.key`), so adding a remote later no longer moves a project. Registered projects get pinned on
  session start. 36 tests, plus an end-to-end run against a throwaway store.
- 2026-10-03: **Fix:** `/work sync` failed in Pi with `spawn bd ENOENT`. Pi started without mise on PATH, and mise shims
  can't run without `mise` either. `src/bin.ts` now resolves bd via `RPIVW_BD`, then PATH (skipping orphaned shims), then mise's
  install folder (the pinned version). Verified with mise stripped from PATH.
- 2026-10-03: **M2 built** (`extension/src/{beads,runs,work}.ts`): a `bd` wrapper (queued single writer, stdout-only JSON,
  read-modify-write of `metadata.rpiv`), and `/work new|next|start|status <bead>`. The lifecycle bridge now claims the bead
  on run start, tracks phase and latest artifacts, comments on failures and stops, closes on success, and pushes beads at
  the end. Runs are linked by name (`/wf … --name <bead>--r<n>`, which survives resume). 30 tests, including one against a
  real `bd`. Read-only commands were checked against the live store. **Not yet verified live:** `/work start` launching
  `/wf` via `sendUserMessage`.
- 2026-10-03: **M1 live run** (driver, `dashboard`, `/wf ship` run `2026-10-03_11-00-44-04d2`): the store
  committed per stage, archived the run JSONL, and pushed. **The tooling works.** The run itself stopped at stage 10/13:
  rpiv's `implement-scope-check` flagged the **submodule gitlink** `dashboard-app` as an undeclared write.
  The plan declared `dashboard-app/Cargo.toml`, but the superproject's `git status --porcelain` shows only the
  gitlink, and `ship` has no branch for `excess`. This is an rpiv limitation with submodule workspaces, not ours.
  Fixes from the run: loop units (grade panel, fan-out phases) now commit via `onUnitEnd` (they had been swept into
  the next stage's commit), and remote-less projects are named after their folder. `/work init <name>` renames.
- 2026-10-03: **M1 store:** created `~/rpivw` (README, registry, config, gitignore) and initialized one
  beads DB (prefix `rw`, stealth). Pushed `main` and `refs/dolt/data` to `rpivw-store`. The shared origin
  needed `bd dolt remote add … --allow-git-origin` (beads refuses to share an origin by default).
- 2026-10-03: **M1 extension** (`extension/`): registry, repo-key, junction mount + migrate, local exclude,
  serialized store commits, lifecycle bridge (commit per stage, archive the run and push at the end), and
  `/work init|status|mount|sync`. 17 tests. Verified: loads via Pi's jiti, no double registration on
  reload, rpiv's digest works through the junction, and `git clean` removes only the junction. Found that
  rpiv-* auto-updated to 2.12.0. The lifecycle surface is unchanged, so the bridge accepts 2.11–2.12.
- 2026-10-03: **M0:** installed bd 1.3.1 and dolt 2.2.0 via mise (pinned). The smoke test passed (research 06).
  Design change: one shared beads DB with `project:<key>` labels.
- 2026-10-03: Settled the store layout and checkpoint defaults. Added "Checkpoints and gates" to research 05.
- 2026-10-01: Research 05: thin-layer design (store, beads bridge, revision/deviation, split, reports, living specs).

## Next up

1. **Portability: clean up the repo for publishing** (2026-10-05), so agents on the driver's work laptop can evaluate it
   against an existing workflow. Review findings (fix in roughly this order):
   - [x] **Store bootstrap.** No command creates a store; `~/rpivw` was built by hand (research 06). Add `/work setup`
     (git init, `config.json`, `registry.json`, `bd init --stealth --prefix rw`) that works with no remote.
   - [x] **Remote optional and configurable.** `store.push` hard-codes `origin`; a store with no remote warns after
     every run. Add `push.remote` (default `origin`), skip pushing quietly when it doesn't exist, and keep beads' Dolt
     remote optional. Work artifacts must never default to a personal remote.
   - [x] **Pi agent dir.** `lifecycle.ts` and `review.ts` hard-code `~/.pi/agent`; honor `PI_CODING_AGENT_DIR` like Pi does.
   - [x] **Docs: separate "this machine" from "the project".** `CLAUDE.md` → Environment notes (Windows 11, broken scoop
     python, Pi managed-install paths, mise pins, the `..\..\Projects\…` package path, the personal store remote) moves to
     a git-ignored `CLAUDE.local.md`; keep generic requirements in `CLAUDE.md`. `extension/README.md` "Try it" uses an
     absolute `C:/Users/<user>/…` path; use `pi --extension ./extension/index.ts` and a relative `packages` entry.
   - [x] **Install guide** (`extension/README.md` → Install, macOS/zsh first): prerequisites with tested versions, `bd
     metrics off`, `pi install "$PWD/extension"`, `/work setup`, first project. Verified: the `dolt` CLI isn't needed (the
     two-machine setup test passes with no `dolt` on PATH; bd embeds Dolt). **Unverified:** `pi install` with an absolute
     local path (not run here, since it edits Pi's settings); `brew install beads` installs the latest bd, not 1.3.1.
   - [x] **Node floor.** `engines` is now `^22.18.0 || >=23.6.0` (unflagged type stripping per Node's release notes; not
     tested on those exact versions).
   - [x] **Submodules over HTTPS.** `.gitmodules` now uses `https://github.com/…` (all four are public), so a clone works
     without GitHub SSH keys. Existing clones: `git submodule sync`.
   - [x] **The rpiv review guide** is now `docs/rpiv-review-guide.md` (copied from the driver's global agent instructions,
     Pi paths via `PI_CODING_AGENT_DIR`); `CLAUDE.md` points to it.
   - [x] **Personal references** replaced: GitHub user → `<user>` / `example-user`, absolute home paths → `~/…`, and the
     driver's project names → `blog-a`, `blog-b`, `dashboard` (with submodule `dashboard-app`) in the log and tests.
   - [~] **macOS target** (the work laptop: macOS, Ghostty, zsh). Code audit done from Windows (2026-10-05):
     - Path identity now goes through `src/paths.ts`: `realpath.native` (resolves `/var` → `/private/var` and on-disk
       case) and case folding on macOS as well as Windows (APFS is case-insensitive by default). Used by mount,
       registry, and the unsafe-dir check.
     - `bd` and `hunk` are also looked for in `/opt/homebrew/bin`, `/usr/local/bin`, and `~/.local/bin` when PATH lacks
       them (a Pi not started from a login shell).
     - Printed `cd <store> && hunk …` commands are POSIX-quoted when the path has spaces.
     - Install docs are macOS/zsh first; `RPIVW_STORE` goes in `~/.zshenv`.
     **Still to do on the Mac** (the agent there): `bd metrics off`; `cd extension && node --test test/` (all should
     pass, the bd tests too if `bd` is installed); `/work setup`, `/work init` in a real repo (check `.rpiv/artifacts` is a
     symlink into the store and `/work status` says "mount ok"); a small `/work start <bead> ship`; then record results in
     `CLAUDE.local.md` and here.
   - Already portable: `RPIVW_STORE` / `RPIVW_BD` / `RPIV_REPORT_DIR` with defaults, mise lookup honors `MISE_DATA_DIR`
     and XDG dirs, junction on Windows vs. symlink elsewhere, plannotator/hunk detected and optional, real-bd tests skip
     without `bd`.
2. **M3 exit check (driver):** a `major` `work_deviation` in a live `build-rpivw` run parks it after implement, shows in
   `/work status` and `/work next`, and continues via `/work approve` and `--reimplement`. Also: Approve in plannotator
   resumes a run.
3. **M3 gaps:** ~~approval notes into the next stage's prompt~~ (2026-10-05: notes ride in the plan
   body; see Decisions), ~~`/work reject` starting the revise~~ (2026-10-05), ~~a link to a rendered
   plan in the gate notice~~ — `/work next` now shows the plan and a `file://` link; the *rendered*
   plan link needs M5's report rendering, so it lands with item 4.
4. **M5 reports**, then **M4 split** (research 05).
5. M1 leftovers: a run from a git worktree; rpiv scope-check vs. submodule workspaces (report upstream?).
6. Contract tests against a pinned rpiv (research 05 → Risks 1).

## Open questions

- Research 05 → "Questions for Phase 2 mocks".
- Research 07 → does a Herdr pane see anything at all while an awaited `/wf` run (or a foreground `Agent` call) is in flight, and do Pi's toasts reach Herdr's notifications? Worth one measurement before anyone re-files upstream.

## Decisions

| Date | Decision | Rationale | Source |
| --- | --- | --- | --- |
| 2026-10-01 | **Host is Pi.** Build the workflow as a Pi extension on top of rpiv-pi and rpiv-workflow. | The driver wants custom extensions to make agents conform to the workflow. rpiv already has the best phase methods. | Driver; research 03 C6 |
| 2026-10-01 | **Solo reader.** No SaaS tracker mirror. | Only the driver reads artifacts | Driver |
| 2026-10-01 | **The artifact store is a private git repo** (user-level, one repo for all projects). | Backup plus revision history in one mechanism | Driver; research 03 C2 |
| 2026-10-01 | **Living specs are in scope** (milestone M6). | Projects are long-lived (dashboard, websites, TUIs) | Driver; research 03 C9 |
| 2026-10-01 | **The work graph is beads + Dolt.** Stack S2 is the direction; S3 is dropped. | The driver wants to try a real graph tool | Driver; research 04 |
| 2026-10-01 | Adopt rpiv and beads unchanged and join them with one extension (lifecycle hooks + `bd --json`). No forks. | Keeps upgrades cheap; rpiv-workflow exposes `registerLifecycle` and external triggers | Research 05 |
| 2026-10-03 | **One store repo for all projects** (`~/rpivw/projects/<repo-key>/`) | One remote and one push. A project can be split out later with `git subtree split`. | Driver; research 05 M1 |
| 2026-10-03 | **Plan approval is an async gate on `build`** (beads human gate + `await-gate` script stage). Off for `ship`. | Lets you review plans on your phone. Trying it async first. | Driver; research 05 M3 |
| 2026-10-03 | **Minor deviations notify** (`deviations.minor: notify`). Switch to `log` once you trust the flow. | The workflow itself is still being tuned | Driver; research 05 M3 |
| 2026-10-03 | Extension name **`rpivw`** (for now). Source lives in **this repo under `extension/`**. The store lives separately at `~/rpivw`. | Keep the tool and the data apart | Driver |
| 2026-10-03 | Store remote: a **private GitHub repo** (`<user>/rpivw-store`) | Driver's choice | Driver |
| 2026-10-05 | **No local workaround for Herdr agent state.** Don't emit `herdr:blocked` around runs, don't report to Herdr's socket ourselves, and don't rely on a Pi pane's Herdr state to mean "a run is in flight". Revisit only if an integration gains `herdr:busy` (then rpivw emits it). | The only channel integration v9 consumes is `blocked`, which means "needs a human" and fires notifications/waits; socket-level reporting collides with herdr#4697 (a child reporter can permanently mute the root). Run progress is already readable via `/work status`, the store, and reports. | Driver; research 07 |
| 2026-10-05 | **A gate decision's notes ride in the plan body**, as one marker-guarded `## Reviewer notes` section appended by the stage that took the decision. The *why* stays in the store commit message and the bead comments. | rpiv-pi owns implement's wiring (`acts({ loop: …, reads: ["plans"] })`), so the plan file is the only channel we know the model reads; a prompt we don't own can't be relied on. The marker keeps a replayed resume from duplicating the section. | Driver; research 05 M3 → Revision log |
| 2026-10-03 | Install bd **1.3.1** and dolt **2.2.0** via mise, both pinned | beads pins Dolt 2.2.0 because of a 2.3.x regression. Pinning bd guards against schema migrations. | Research 06 |
| 2026-10-03 | **One beads database for all projects**, with a `project:<key>` label per bead | Dolt allows one database per remote ref, and there is one store remote | Research 06 |
| *(proposed)* | Mount the store at `.rpiv/artifacts` via a directory junction | rpiv hardcodes that path | Research 05 M1 |
| *(proposed)* | Keep the "why" of revisions in store commit messages + bead comments, not in artifact bodies | rpiv's `revise` rewrites plan bodies | Research 05 M3 |

## Published reports

Render any of these with the `html-report` skill. Links to published copies are private and
kept in `CLAUDE.local.md`.

| Date | Report | Source |
| --- | --- | --- |
| 2026-09-28 | Phase 0 survey summary | `research/reports/2026-09-28-phase-0-survey.md` |
| 2026-10-01 | Phase 1 thin-layer design | `research/reports/2026-10-01-phase-1-design.md` |
