# rpiv / Pi workflow-artifact review guide

Use this guide when reviewing rpiv workflow configuration, run trails, or artifacts
created by Pi. Treat the installed extension sources as authoritative; this file is a
map and a review protocol, not a replacement for them.

> Copied into this repo from the driver's global agent instructions (2026-10-05) so agents on
> any machine share the same protocol. Keep the two in sync; this copy is the one to edit.

## Installation layout

- Pi's agent directory: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent/`. Below, `<agent>`.
- Active Pi extension list: `<agent>/settings.json` (`packages`).
- rpiv packages: `<agent>/npm/node_modules/@juicesharp/rpiv-*`.
- Primary integration package: `@juicesharp/rpiv-pi`.
- Workflow engine: `@juicesharp/rpiv-workflow`.

Before commenting on behavior, read the relevant installed source and documentation:

| Subject | Authoritative location |
| --- | --- |
| Pi integration, guidance injection, sibling coupling | `@juicesharp/rpiv-pi/README.md`, `docs/architecture.md` |
| Built-in pipelines and hand-driven sequences | `@juicesharp/rpiv-pi/docs/workflows.md` |
| Skill contracts and artifact buckets | `@juicesharp/rpiv-pi/docs/skills.md` and the target `skills/<name>/SKILL.md` |
| Workflow config, state, routing, and validation | `@juicesharp/rpiv-workflow/docs/workflow-basics.md`, then `docs/workflow-authoring.md` if editing or auditing graph definitions |
| Bundled artifact-reviewer behavior | `@juicesharp/rpiv-pi/agents/artifact-*.md` |

Do not assume a package is active merely because it is installed. Confirm the exact
`npm:` or `git:` entry in `settings.json`; rpiv-pi detects sibling presence from that
file.

## Operating model

`rpiv-pi` contributes Pi skills, bundled subagent profiles, built-in workflows,
commands, lanes, and guidance injection. It registers no tools itself. Capability
tools such as `Agent`, `ask_user_question`, `todo`, `advisor`, and web tools come from
sibling extensions.

`/wf` is supplied by `rpiv-workflow`. A workflow is a typed directed graph of stages.
Each stage runs in a detached child session. The runner records append-only JSONL state
and resumes from that state; do not treat a partial run as a single linear chat.

Built-in workflows are:

- `build`: goal -> research -> slice/gate -> parallel design -> review/synthesis ->
  plan gates -> parallel elaboration -> implement -> validate -> commit.
- `vet`: review existing changes, then loop through blueprint, implement, validate, and
  review until `blockers_count` is zero or the loop cap is reached.
- `polish`: architecture review, phased blueprinting, implementation, validation, and
  code review, with a fix loop when blockers remain.

The exact stage graph and contracts can change with extension versions. Verify them in
the installed built-in workflow source or `/wf <name>` documentation before reporting a
graph defect.

## Artifact and state locations

For a project being worked on (the Pi current working directory), rpiv writes:

```text
<project>/.rpiv/artifacts/
  goal/ discover/ research/ solutions/ slices/ designs/
  elaborations/ plans/ subplans/ verdicts/ reviews/ validation/
  architecture-reviews/ triage/ handoffs/

<project>/.rpiv/workflows/
  config.ts                 # project workflow overlay
  packs/*.ts                # project workflow packs
  runs/<run-id>.jsonl       # append-only run record
  runs/<run-id>/sessions/   # detached child-session files
```

User-level workflow overlays are under `~/.config/rpiv-workflow/`, not `~/.pi`.
Models overrides are under `~/.config/rpiv-pi/models.json`. Do not conflate either
with Pi's `~/.pi/agent/` configuration.

Artifacts are intentionally reviewable inputs and outputs. A skill contract declares
what it consumes and produces; `/wf` uses these contracts to compose stages. Check a
claim about an artifact path, kind, or downstream hand-off against the target skill's
frontmatter and the workflow run row.

## Review procedure

1. Identify the subject: a Markdown artifact, workflow config/pack, JSONL run, emitted
   review, or installed extension behavior. State the exact path and extension version
   (from its `package.json`) in the review notes.
2. Read the complete artifact or configuration first. Preserve its phase/slice ordering,
   declared decisions, file map, verification notes, and contract metadata.
3. For a workflow, verify stage names, edges, predicates, contracts, default/overlay
   precedence, and run state against `rpiv-workflow`; config and pack files are
   executable TypeScript loaded by jiti, so flag unexpected top-level side effects.
4. For a plan/design, verify every proposed `MODIFY` file against the live file and
   every `NEW` file against sibling conventions. Trace downstream imports back to the
   artifact's upstream exports exactly.
5. Check that each hard constraint or verification note is represented by an explicit
   success criterion or an observable guard/test in the proposed code.
6. Distinguish artifact defects from runtime defects. A stale artifact may describe a
   plan that was superseded by `revise` or `amend`; use timestamps, run JSONL, and the
   current worktree before claiming the system behaved incorrectly.

## Finding standard

Report concrete, actionable findings only. Cite both the artifact location (heading,
phase, slice, or JSONL row) and the supporting live-source location when applicable.

- **blocker**: implementation or workflow execution cannot complete correctly (missing
  stage, invalid edge/contract, unresolved path/import, incompatible schema, absent
  hard-invariant enforcement).
- **concern**: it can run but has a real correctness, security, reliability, or
  maintainability risk.
- **suggestion**: a non-essential improvement.

Prefer one finding per issue. Do not praise, summarize, or invent defects. If the
artifact is sound, say so briefly and name the evidence reviewed.

When reviewing an existing rpiv review artifact, preserve its declared scope and
severity semantics. `blockers_count` is the gate signal used by `vet` and `polish`; do
not infer it from unrelated prose.

## Safety and scope

Default to read-only inspection. Do not start `/wf`, resume a run, invoke `/skill`,
edit `.rpiv/workflows/*.ts`, alter artifacts, or modify `settings.json` unless the user
explicitly asks for that action. Workflow overlays execute code at load time, so inspect
their diff before running Pi in an untrusted project.

When evidence is unavailable, state what is missing rather than guessing. Prefer the
installed sources over online documentation because they describe the version actually
loaded by this Pi installation.
