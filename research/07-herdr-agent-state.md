---
title: Herdr's view of rpiv runs
subtitle: Why a Pi pane running an rpiv phase or workflow still shows "idle" in Herdr's sidebar, and why we are not patching around it.
eyebrow: rpiv-workflow · research 07
date: 2026-10-05
status: done
tags: [observability, herdr, pi, rpiv, integration]
---

# Herdr's view of rpiv runs

The driver runs Pi inside Herdr panes and noticed that a pane stays **idle** in
Herdr's sidebar while an rpiv phase or an rpiv-workflow run is clearly working.
This note is the diagnosis. Everything in "Why" is checkable from the files and
URLs in the evidence index; the recommendation section is opinion.

## Result

> [!IMPORTANT] Herdr cannot see rpiv work, and it is not a bug on our side
> Pi's state reports only cover the **top-level TUI session's own agent loop**.
> rpiv and rpiv-workflow run every stage in **child `AgentSession`s**, so no
> top-level agent loop is active while a run is in flight, and child sessions are
> filtered out by design. Because the integration holds *full lifecycle authority*
> for the pane, Herdr also stops reading the screen, so nothing else can correct
> the state. The pane keeps whatever the root loop last reported: idle.

Two consequences worth stating plainly:

1. **This is not "rpiv is invisible".** Work done *inside* the root loop registers
   normally — a plain prompt turn makes a Pi pane show `working` (observed live
   during this investigation). It is specifically **delegated work** (workflow
   stages, fan-out units, background subagents) that Herdr never learns about.
2. **There is no upstream fix in flight.** Herdr closed the two PRs that would
   have added this, and no release note since mentions it. So "wait for upstream"
   currently means "wait for a new issue to be filed and accepted".

## Versions checked (2026-10-05)

| Component | Version | Where |
| --- | --- | --- |
| Herdr | **0.9.1** | `~/.herdr/packages/standalone/releases/0.9.1-x86_64-pc-windows-msvc/` (stable is 0.9.3) |
| Herdr's Pi integration | **v9** | `~/.pi/agent/extensions/herdr-agent-state.ts` |
| Pi | **1.0.2** | `~/.pi/agent/install/current-version` |
| rpiv-pi | **2.12.0** | `~/.pi/agent/npm/node_modules/@juicesharp/rpiv-pi/` |
| rpiv-workflow | **2.12.0** | `~/.pi/agent/npm/node_modules/@juicesharp/rpiv-workflow/` |
| pi-subagents | **0.19.0** | `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents/` |

The Herdr documentation quoted below was fetched from the `v0.9.3` docs revision
while the installed binary is 0.9.1. The state-authority wording is therefore
newer than the binary; the extension on disk is what actually decides, and that
was read directly.

## Why

### 1. The integration is the pane's only state authority

Herdr's own docs, *Agents*: "When an integration also reports state, Herdr uses
those reports **instead of reading the screen**." For a Pi pane that is not a
theory — `herdr agent list` reports it in the payload:

```
"agent":"pi", "agent_status":"idle", "screen_detection_skipped":true
```

Herdr names the reason `full_lifecycle_hook_authority` (see issue #4697's
`screen_detection_skip_reason`). So the screen manifest — which *does* recognize
Pi's working border — is deliberately not consulted for Pi panes. Whatever the
integration fails to report, Herdr does not discover another way.

### 2. The integration only reports the root TUI session's agent loop

`~/.pi/agent/extensions/herdr-agent-state.ts` (v9) is small; the whole contract is:

| Line | Handler | Effect |
| --- | --- | --- |
| 5 | `HERDR_INTEGRATION_VERSION=9` | installed version marker |
| 65 | `let reportSeq = Date.now() * 1000` | per-process report sequence (matters below) |
| 211 | `pi.events.on("herdr:blocked", …)` | extension-reported **blocked** state (root session only) |
| 229-232 | `session_start` | `if (ctx?.mode !== "tui") return;` then `rootSession = true` |
| 243 | `agent_start` | `agentActive = true` → reports `working` |
| 253 | `agent_settled` | `if (!rootSession \|\| ctx?.isIdle?.() !== true) return;` → reports `idle` |

So `working` exists only between the root session's `agent_start` and its
`agent_settled`. The file itself documents the reasoning for the mode gate: TUI
only, because "RPC/JSON/print modes are headless (no PTY Herdr can display)".

### 3. rpiv never runs a stage in that loop

`@juicesharp/rpiv-pi/extensions/rpiv-core/sdk-workflow-host.ts` is explicit, in its
own header (lines 5-9):

> every stage / fanout unit runs in a child `AgentSession` this host owns, **the
> interactive session never executes a stage** and is never swapped

and again at line 216. The mechanism is the Pi SDK: `createAgentSession({…})` at
line 284, driven by `await session.prompt(options.prompt)` at line 437
(`dispatchChildPrompt`). `/wf` runs are *floated* so the editor stays foreground
while runs are in flight (`workflow-execution-host.ts:107`, "the float fix").

Net effect during any rpiv phase or `/wf` run: **no top-level agent loop is
running**, so neither `agent_start` nor `agent_settled` fires, so Herdr's state
for the pane is simply stale.

### 4. Child sessions could not report even if they ran the extension

Pi's default extension mode for any session is `"print"`:

```
dist/core/agent-session.js:148   _extensionMode = "print";
```

Only the interactive TUI rebinds it (`bindExtensions({ mode })` →
`agent-session.js:2567`). Child sessions do inherit the process environment, so
`HERDR_ENV` / `HERDR_PANE_ID` are set in them and the integration's `enabled()`
check passes — but `session_start` returns at the mode gate and `rootSession` is
never set, so they stay silent forever.

rpiv also strips a whole class of extensions from child resource loaders —
"Launcher-only 'ambient observer' extensions: they register session-lifecycle
handlers + side effects (timers, intervals, OSC/terminal writers, spinners) but
expose NO tools or commands a stage skill invokes"
(`sdk-workflow-host.ts:145` `withoutAmbientExtensions`, `:134`
`isAmbientChildExtension`, opt-out via a `pi.ambientObserver` flag in
`package.json`, plus a transitional denylist at `:85`). Herdr's state reporter is
squarely in that category, so the intent on rpiv's side is "children do not get
terminal-observing extensions" — the same conclusion, reached independently.

### 5. Nothing in the installed stack emits a Herdr event

Grepping `herdr` / `HERDR` across every `.ts`/`.js` file of rpiv-pi 2.12.0,
rpiv-workflow 2.12.0, and pi-subagents 0.19.0: **zero hits**. rpiv-workflow and
rpiv-pi emit no run-lifecycle events on the extension bus at all. pi-subagents
emits `subagents:started|completed|failed|steered|created|compacted|ready`
(`dist/index.js:519-765`) — none of which Herdr listens for.

The integration *does* consume a custom event channel (`herdr:blocked`, line 211),
so the mechanism for extension-reported state exists in v9 — but only for blocked,
and nothing installed here emits it either.

### 6. Upstream saw this and closed it

| Item | State | Content |
| --- | --- | --- |
| [herdr#3796](https://github.com/herdrdev/herdr/issues/3796) | closed, **not planned** | "Pi pane reports idle or done while an async subagent is still running" (reported against Pi 0.85.1 + pi-subagents 0.60.0) |
| [herdr PR #3821](https://github.com/herdrdev/herdr/pull/3821) | closed, **unmerged** | adds a listener for `herdr:busy` (pi-subagents) and `herdr:working` (pi-extensible-workflows); verified by its author on 0.9.0 |
| [herdr PR #3924](https://github.com/herdrdev/herdr/pull/3924) | closed, **unmerged** | "feat: support Pi busy activity reports"; documents `pi.events.emit("herdr:busy", { active: true, label })` with `blocked → working → idle` precedence |

The release notes for 0.9.2 and 0.9.3 (GitHub releases API) mention Pi only for
`/new` false-done notifications and Windows session paths; neither adds background
work reporting. Note also that PR #3821's description confirms a second dead end:
"Because the integration holds full lifecycle authority for the pane, no other
source can correct the state: a `working` report from another source is accepted
and ignored."

There is an inverse hazard on the same code path: [herdr#4697](https://github.com/herdrdev/herdr/issues/4697)
documented a pane stuck at `working` **forever** because a subagent worker process
inherited `HERDR_ENV`/`HERDR_PANE_ID`, reported for the parent pane, and anchored
`reportSeq` (`Date.now() * 1000`, line 65) above the real root process — after
which every genuine report was dropped as stale. Relevant to us because our
extension and rpiv's children share one process and one environment.

## Evidence index

Local, read directly (paths as resolved on this machine):

- `~/.pi/agent/extensions/herdr-agent-state.ts` — the whole integration (v9, ~280 lines).
- `~/.pi/agent/install/releases/1.0.2/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` — default extension mode (`:148`), `bindExtensions` (`:2567`, `:2626`), `agent_settled` emission (`:676`), `agent_start` emission (`:868`).
- `~/.pi/agent/npm/node_modules/@juicesharp/rpiv-pi/extensions/rpiv-core/sdk-workflow-host.ts` — child sessions, ambient-extension filter.
- `~/.pi/agent/npm/node_modules/@juicesharp/rpiv-pi/extensions/rpiv-core/workflow-execution-host.ts` — float/focus behaviour.
- `herdr agent list`, `herdr integration status`, `herdr agent explain` — live state from the running server.

Web, fetched as raw primary sources (not search snippets): herdr v0.9.3 docs
`agents.mdx` and `integrations.mdx` (raw.githubusercontent.com), the GitHub API for
issues #3796/#4697, PRs #3821/#3924, and the releases list.

## What we recommend

**Decision: do nothing locally; keep run progress in rpivw's own surfaces.** The
driver's requirement 7 (progress readable as standalone HTML, or on a phone) is
already served by the store, `/work status`, and the report skill. Herdr's role in
this stack is pane management, not run monitoring, and no cheap local change makes
it a trustworthy monitor.

Options considered, all rejected for now:

| Option | Cost | Why not |
| --- | --- | --- |
| File/revive upstream: Herdr listens for `herdr:busy`, rpiv/pi-subagents emit it | two repos, one already-closed PR | Correct long-term fix, but out of our hands and currently with no in-flight work. Revisit if someone reopens it. |
| Have `rpivw` emit `pi.events.emit("herdr:blocked", {active:true,label:"rpivw run"})` around runs (v9 does consume this) | ~20 lines in our extension | Semantically wrong — `blocked` means "a human is needed" in Herdr, and it fires notifications, `herdr agent wait`, and workspace rollups. Would train the driver to ignore real blocks. |
| Report straight to Herdr's socket as `--source herdr:pi` with a bumped `seq` | small, but touches an undocumented race | This is exactly the failure mode of #4697 (a reporter can permanently mute the real one). Would risk panes stuck at `working` forever. |
| `herdr integration uninstall pi`, fall back to screen manifests | 1 command | *Unverified:* during a floated run the root turn is idle, so there may be nothing on screen to read. Also loses session restore. Cheap enough to try if the driver ever wants a data point. |

A smaller point that did come out of this: **`/work start`'s visibility story is
Pi's, not Herdr's.** rpivw's notifications go through Pi's UI (see the 2026-10-04
entry in `PROGRESS.md`). Whether those surface as Herdr notifications is untested
(open question below).

## How to re-verify (after a Pi or Herdr upgrade)

Drift risk is real here: this note rests on a managed Pi install and a Herdr
integration that Herdr rewrites on update. Re-check in this order.

```powershell
herdr --version
herdr integration status | Select-String "pi:"
herdr agent list            # expect screen_detection_skipped:true for panes running pi
```

Then re-read the two contract points:

```powershell
# 1. Does the integration still gate on TUI mode and only fire on agent_start/settled?
Select-String -Path "$env:USERPROFILE\.pi\agent\extensions\herdr-agent-state.ts" `
  -Pattern 'ctx\?\.mode !== "tui"|pi\.on\("agent_start"|pi\.on\("agent_settled"|herdr:blocked|herdr:busy'

# 2. Does anything in the stack now emit a Herdr event? (expect zero hits today)
Get-ChildItem "$env:USERPROFILE\.pi\agent\npm\node_modules\@juicesharp\rpiv-pi" -Recurse -File |
  Select-String -Pattern "herdr" -ErrorAction SilentlyContinue
```

If a future integration gains `herdr:busy`, the next step is ours and small: emit
it around run start/finish (rpivw already tracks both) so a Herdr pane shows
`working` for the length of a run. Until then, treat a Pi pane's Herdr state as
"what the top-level turn is doing", never as "is a run in flight".

## What this note does not establish

- No live A/B test of the `integration uninstall pi` fallback (screen-manifest
  behaviour during a floated run is inferred, not observed).
- No test of what Herdr shows while an *awaited* (non-floated) `/wf` run or a
  foreground `Agent` tool call is in flight. The model predicts `working` for a
  blocking subagent call and `idle` for a detached one; only the detached case was
  observed (a pane reported `working` during an ordinary prompt turn, and Herdr's
  own issue #3796 covers the detached case).
- Nothing about how rpiv work looks in Herdr on Linux/macOS, or under Herdr's
  preview channel.

## Open questions

1. Do Pi's toasts/notifications reach Herdr's notification system, so a halted run
   pings the driver while they are in another pane? (Untested.)
2. Does Herdr's screen manifest report `working` for a Pi pane with the integration
   uninstalled while a floated rpiv run is in flight? (One command to test.)
3. Worth re-filing upstream, given two closed PRs already implement it? If yes, the
   ask should cover **all** delegated work (`herdr:busy` from workflows and
   subagents), not just the pi-subagents case in #3796.

## Revision log

- 2026-10-05: First draft. Diagnosis from Herdr 0.9.1 + integration v9 + Pi 1.0.2 +
  rpiv 2.12.0 source, plus the closed upstream issues/PRs. Decision: no local
  workaround; keep progress reporting inside rpivw.
