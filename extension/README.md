# rpivw extension

A Pi extension that joins rpiv (methods and runs), beads (work graph), and a
private-git artifact store. Design: `../research/05-thin-layer-design.md`.

**Status: M1 (artifact store), M2 (beads bridge), and M3 (plan approval, deviations,
stamping) built.** Split and reports come in M4–M5. See `../PROGRESS.md`.

## Install

Commands are for macOS/Linux with zsh or bash. On Windows they work the same in Git Bash.

**1. Prerequisites**

| Need | Tested | Notes |
| --- | --- | --- |
| [Pi](https://github.com/badlogic/pi-mono) | 1.0.2 | `pi` on PATH. |
| rpiv-pi and its siblings | rpiv-* 2.11–2.12 | `pi install npm:@juicesharp/rpiv-pi`, restart Pi, then `/rpiv-setup` (installs rpiv-workflow, pi-subagents, and the rest). |
| git | 2.4x+ | With `user.name` and `user.email` set. |
| `bd` (beads) | 1.3.1 | For work tracking and gates; artifacts work without it. `brew install beads`, `npm install -g @beads/bd`, or mise. A separate `dolt` CLI isn't needed (bd embeds Dolt). |
| Node | 22.18+ or 23.6+ | Only to run the tests (Pi loads the extension itself). |
| plannotator, hunk | optional | Used by `/work review` when present. |

**2. Turn off bd's usage metrics** (on by default; a per-user setting):

```sh
bd metrics off
bd metrics          # confirm
```

**3. Load the extension** in every Pi session. From the root of this repo:

```sh
pi install "$PWD/extension"
```

That adds the folder to `packages` in Pi's settings (`~/.pi/agent/settings.json`, or
`$PI_CODING_AGENT_DIR/settings.json`). The extension loads from this checkout, so `git pull`
plus `/reload` updates it. To try it for one session without installing:
`pi --extension ./extension/index.ts`. Installing (not `--extension`) is required for the
`work_deviation` tool, because rpiv's stage sessions load extensions from settings.

**4. Create the store** in Pi (see [Store setup](#store-setup) for remotes):

```text
/work setup                      # local-only store at ~/rpivw
/work setup --remote <git-url>   # or: with an empty remote, or join an existing store
```

Then `/reload`.

**5. Track a project.** In Pi, inside a git checkout:

```text
/work init                  # register it and mount .rpiv/artifacts from the store
/work new "<what to do>"    # a bead
/work start <bead> ship     # run a tracked workflow (build for the plan gate)
/work next                  # what's in progress, ready, and waiting on you
```

## What M3 does

**Tracked workflows.** `/work start` runs `<name>-rpivw` for `ship`, `build`, `vet`, and
`polish`. These are derived at runtime from rpiv-pi's live built-ins, so a plain `/wf build`
is never changed:

```text
… → [plan-approval →] implement → deviation-check → (implement's original next stage)
```

- **`plan-approval`** only for workflows listed in `config.json` → `gates.planApproval`
  (default `["build"]`). See below.
- **`deviation-check`** always. The model calls the **`work_deviation`** tool from inside an
  implement stage when the plan doesn't match reality:
  - `minor`: logged on the bead and the run continues. You get a notification while
    `deviations.minor` is `"notify"`.
  - `major`: logged, a beads gate (`rpivw:deviation`) opens for the run, and the model is told
    to stop and summarize. When implement ends, `deviation-check` stops the run. Then
    `/work approve <gate> [notes]` continues as planned, or `/skill:revise` the plan and
    `/work approve <gate> --reimplement` sends the run back to implement once.
  - The tool only exists in rpiv's stage sessions when rpivw is **installed** (Pi settings
    `packages`), because `pi --extension` doesn't reach child sessions.

Verified on rpiv-workflow 2.12's real runner: implement → deviation-check (stop) → approve
--reimplement → resume → implement again → deviation-check → validate. Derived `ship`/`build`/
`vet`/`polish` variants add no validator issues compared with their bases.

## M3 details

- **Artifact stamping.** After each stage, every markdown artifact it produced gets one
  `rpivw:` block in its front matter (`id`, `work`, `run`, `workflow`). rpiv's own keys are
  untouched, and Pi's `parseFrontmatter` reads stamped files the same as before. The `id`
  is a ULID written once. If `revise` rewrites a plan and drops the block, the id is
  recovered from the store's last commit.
- **Async plan approval** for workflows listed in `config.json` → `gates.planApproval`
  (default `["build"]`). The extension registers `build-rpivw`, which is rpiv-pi's live `build`
  with a `plan-approval` script stage spliced in before `implement` (every route into
  `implement` goes through it). `/work start <bead> build` runs `build-rpivw`, while a plain
  `/wf build` stays ungated. At the gate the run creates a beads `human` gate blocking the bead,
  notifies you, and stops (`stopped at plan-approval`). `/work next` lists it under
  "awaiting you". `/work approve <gate> [notes]` resolves it and resumes the run, which re-runs the
  gate and continues into implement. `/work reject <gate> <notes>` records the requested changes,
  keeps the gate open, and prints the `/skill:revise …` command to run before approving.
  `/work review [<gate>]` opens the waiting plan in plannotator's review-gate UI (when its Pi
  extension is installed), through plannotator's event-bus API (`plannotator:request`, `annotate`
  with `gate: true`). **Approve** resolves our gate and resumes the run (notes go on the bead);
  **annotations** are recorded on the bead, keep the gate open, and start `/skill:revise <plan>
  <notes>`; **Close** changes nothing. It also prints a `file://` link plus, when hunk is
  installed, a `hunk diff` of the plan's changes from the store's history (uncommitted revise edits,
  else first draft → now). The gate's notice carries the same lines.
  Verified against rpiv-workflow 2.12's real runner (halt → resume halts again → approve →
  resume completes) and rpiv's validator (the derived workflows add no issues).
- **Safe in rpiv's child sessions.** rpiv runs each stage in a child session that loads
  extensions from disk. rpivw recognizes a child by its session directory
  (`.rpiv/workflows/runs/<run-id>/sessions`) and leaves the launcher's lifecycle registration,
  mounts, and workflow registry alone.

## What M2 does

- `/work new` creates a bead in the store's single beads database, labeled `project:<key>`,
  with your brief verbatim as its description.
- `/work start <bead>` claims the bead and sends `/wf <workflow> <brief> --name <bead>--r<n>`
  through Pi's normal command path, so the run gets its usual detached lane. rpiv records the
  name in the run's JSONL header, and the listener reads it back to find the bead. A `/wf` you
  start by hand with a name in that format is linked the same way, and so are resumes.
- While a linked run executes, the bead is claimed, `metadata.rpiv` tracks `workflow`, `phase`
  (the last finished stage), `runs`, and the latest artifact per bucket. A failed stage adds a
  bead comment. A stopped run adds a comment with the `/wf @<run-id>` resume hint, and a
  successful run closes the bead. The end-of-run push includes `bd dolt push`.
- Bead names are reversible in run names because bead IDs never contain `_` (`rw-5b3.1` → `rw-5b3_1--r1`).

## What M1 does

- **Registers projects** in the store (`~/rpivw/registry.json`). The key comes from the
  normalized `origin` URL (`github.com__owner__repo`), else the root commit, else a generated
  `local__<hex>` for an empty repo. `/work init` **pins** it in the repo's local git config
  (`rpivw.key`), so adding or renaming a remote later doesn't move the project. Projects
  registered before pinning existed get pinned at the next session start.
- **Creates the git repo if needed.** In a folder with no repo, `/work init` asks before
  running `git init -b main` (or skips the question with `--git`). It refuses in your home
  directory, at a filesystem root, and inside the store. It never makes commits in your repo.
- **Mounts** `~/rpivw/projects/<key>/artifacts` into each checkout as `.rpiv/artifacts`
  (a directory junction on Windows), on `session_start` and on `/work init`. Every clone and
  worktree of a project shares one folder. Real content is never overwritten:
  a non-empty local `.rpiv/artifacts` is reported, and `--migrate` moves it in.
- **Adds `.rpiv/` to the repo's `.git/info/exclude`**, which is local only and changes nothing in the project.
- **Commits the store after every rpiv-workflow stage**, with messages like
  `<run-id> plan [<bead>]: plans/x.md`. When a run ends it copies the run JSONL
  into `artifacts/runs/`, commits, and pushes. A failed push only warns.

It hooks rpiv-workflow by adding a listener bundle to rpiv's global lifecycle registry
(`Symbol.for("@juicesharp/rpiv-workflow:lifecycle")`), the same thing rpiv's
`registerLifecycle` does, so it needs no npm dependencies. This was checked against
rpiv-workflow 2.11 and 2.12; startup warns on other versions.

## Commands

| Command | Effect |
| --- | --- |
| `/work new "<brief>" [--type feature\|bug\|task\|chore\|epic] [--parent <bead>]` | Create a bead for this project |
| `/work next [--all]` | In-progress and ready beads for this project (or every project). Epics are listed separately. |
| `/work start <bead> [ship\|build\|<workflow>] [--force]` | Claim the bead and start the linked `/wf` run. Refuses beads from other projects, in-progress beads (resume with `/wf @<run>`), epics, and closed beads unless `--force`. |
| `/work status [<bead>]` | No bead: store, project, mount, and in-progress beads. With a bead: phase, runs, artifacts, recent notes. |
| `/work init [name] [--migrate] [--git]` | Register this repo (or rename it), pin its key, mount the store, and create `project.md`. Creates the git repo if missing (asks first, or `--git`). Commits the store. |
| `/work mount` | Re-create the junction (for example after a `git clean -x`) |
| `/work sync` | Push the store: git plus `bd dolt push` |

### Tab completion

`/work <Tab>` completes subcommands. `status`/`start` complete bead IDs for the current
project from a partial ID or a word in the title, with type, status, phase, and title shown
beside each. `start <bead> <Tab>` offers `ship|build|vet|polish`. `new` completes `--type`
values and `--parent` beads (epics first), and `next`/`init` complete their flags.
`start` only offers beads that can be started: no in-progress beads (resume those with
`/wf @<run>`), epics, closed beads, or gates. `/work start` refuses an in-progress bead
unless `--force`, and names its last run.

Bead lists come from a 15-second cache. A stale cache is served at once and refreshed in the
background, so only the first lookup in a session waits on `bd` (about 0.7 s, capped at 3 s).

## Store setup

`/work setup` creates the store (`RPIVW_STORE`, default `~/rpivw`): a git repo with
`README.md`, `config.json`, `registry.json`, and a `.gitignore`, plus a stealth beads
database (`bd init --stealth --prefix rw`) when `bd` is available. It works without a remote.

- `--remote <git-url>` with an **empty** repo: the new store gets it as `origin` (and as the
  beads Dolt remote) and makes the first push.
- `--remote <git-url>` with an **existing** store: clones it and restores beads from its
  `refs/dolt/data` (`bd bootstrap`). This is how a second machine joins.
- Re-running is safe: it fills in what's missing and changes nothing else.
- `bd` shares anonymous usage metrics by default (command names, version, OS), and setup says
  so. **Run `bd metrics off` before `/work setup`** on a new machine; it's a per-user setting.

## Settings

- `RPIVW_STORE` overrides the store location (default `~/rpivw`). On Windows, keep it short,
  because Dolt and git fail on deep paths. With zsh, set it in `~/.zshenv` (read by every zsh,
  including the one Pi is launched from); GUI-launched apps may not see shell variables.
- `bd` is found via `RPIVW_BD`, then PATH, then mise's install folder (preferring the version
  pinned in `~/.config/mise/config.toml`). A mise shim on PATH is skipped when `mise` itself
  isn't on PATH, because shims can't run without it. `/work status` shows which `bd` is used.
- `~/rpivw/config.json` holds global settings (gates, deviations, `push.onWorkflowEnd`,
  `push.remote`). `projects/<key>/config.json` overrides them per project.
- `push.remote` (default `origin`) is the store remote that runs and `/work sync` push to. A
  store without it is local-only: nothing is pushed and nothing warns.
- Pi's agent folder (for its settings and the installed rpiv version) follows
  `PI_CODING_AGENT_DIR`, as Pi does, else `~/.pi/agent`.

## Development

```bash
cd extension
node --test test/        # Node 22.18+ / 23.6+ runs the .ts files directly
```

No build step and no dependencies. Keep the code to *erasable* TypeScript (no enums,
namespaces, or parameter properties) so Node's type stripping and Pi's jiti both load it.
Imports use explicit `.ts` extensions.

Verified on Windows 11 (Git 2.56, rpiv-workflow 2.12.0):
- rpiv's artifact digest (`computeWorktreeDigest`) sees files through the junction.
- `git clean -fd`, `-xfd`, and `-xffd` remove only the junction. The store's files survive, and `/work mount` (or the next session start) restores the junction.
