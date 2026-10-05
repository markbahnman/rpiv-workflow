// Tracked workflows (M3): plan approval + deviation check.
//
// rpiv-workflow keeps built-in workflows in a global registry
// (Symbol.for("@juicesharp/rpiv-workflow:built-ins")) and lazy providers in
// Symbol.for("@juicesharp/rpiv-workflow:built-in-providers:providers"); both are
// plain arrays, the same slots its registerBuiltIns / registerBuiltInsProvider use.
// For each base workflow with an `implement` stage we derive "<name>-rpivw" from
// the live built-in (build → build-rpivw, ship → ship-rpivw):
//
//   … → [plan-approval →] implement → deviation-check → (implement's original next)
//
// - plan-approval (only for workflows in config gates.planApproval): first entry
//   creates a beads `human` gate blocking the bead and throws, so rpiv halts the run
//   ("stopped at plan-approval"). `/work approve` resolves it and resumes; rpiv
//   re-runs the halted stage, which now passes.
// - deviation-check (always): halts while a major deviation (recorded by the
//   work_deviation tool) is open. `/work approve <gate>` continues; `/work approve
//   <gate> --reimplement` (after /skill:revise) routes back to `implement` once.
//
// A separate name means rpiv-pi re-registering `build` can never clobber the variant,
// and a plain `/wf build` stays untouched.

import { type Bead, type Beads, projectLabel } from "./beads.ts";

export const PLAN_GATE = "plan-approval";
export const DEVIATION_CHECK = "deviation-check";
export const GATE_LABEL = "rpivw:plan-approval";
export const DEVIATION_LABEL = "rpivw:deviation";
export const REIMPLEMENT_LABEL = "rpivw:reimplement";
export const REIMPLEMENTED_LABEL = "rpivw:reimplemented";
/** Base workflows /work start runs as <name>-rpivw (rpiv-pi's built-ins with an implement stage). */
export const TRACKED_BASES = ["ship", "build", "vet", "polish"];

const BUILT_INS = Symbol.for("@juicesharp/rpiv-workflow:built-ins");
const PROVIDERS = Symbol.for("@juicesharp/rpiv-workflow:built-in-providers:providers");
const ROUTE_SLOT = Symbol.for("rpivw:deviation-route");

type EdgeFn = ((ctx: unknown) => string) & { targets?: readonly string[] };
type Edge = string | EdgeFn;
export interface WorkflowLike {
  name: string;
  description?: string;
  start: string;
  stages: Record<string, unknown>;
  edges: Record<string, Edge>;
  [k: string]: unknown;
}

export const trackedName = (name: string) => `${name}-rpivw`;
export const baseName = (name: string) => name.replace(/-(rpivw|gated)$/, "");

const IMPLEMENT = "implement";

/** Route every edge into `before` through `gate` first. Returns the number of routes rewired. */
function routeThrough(edges: Record<string, Edge>, start: string, before: string, gate: string): { edges: Record<string, Edge>; start: string; rewired: number } {
  let rewired = 0;
  const out: Record<string, Edge> = {};
  for (const [from, target] of Object.entries(edges)) {
    if (typeof target === "string") {
      if (target === before) rewired++;
      out[from] = target === before ? gate : target;
    } else if (typeof target === "function") {
      const orig = target;
      const wrapped: EdgeFn = Object.assign((ctx: unknown) => {
        const t = orig(ctx);
        return t === before ? gate : t;
      }, orig);
      if (orig.targets) wrapped.targets = orig.targets.map((t) => (t === before ? gate : t));
      if (orig.targets?.includes(before)) rewired++;
      out[from] = wrapped;
    } else out[from] = target;
  }
  if (start === before) rewired++;
  return { edges: out, start: start === before ? gate : start, rewired };
}

/** The decision deviation-check hands to its own outgoing edge (edges get no run id or cwd). */
export function setDeviationRoute(route: "continue" | "reimplement", g: Record<symbol, unknown> = globalThis as never) {
  g[ROUTE_SLOT] = { route, at: Date.now() };
}
function takeDeviationRoute(g: Record<symbol, unknown>): "continue" | "reimplement" {
  const v = g[ROUTE_SLOT] as { route: "continue" | "reimplement"; at: number } | undefined;
  g[ROUTE_SLOT] = undefined;
  return v && Date.now() - v.at < 60_000 ? v.route : "continue";
}

/**
 * Derive `<name>-rpivw`. Returns undefined when the workflow has no `implement`
 * stage (or no route into it), or already contains our stages.
 */
export function deriveTracked(
  wf: WorkflowLike,
  stages: { planGate?: unknown; deviationCheck: unknown },
  g: Record<symbol, unknown> = globalThis as never,
): WorkflowLike | undefined {
  if (!(IMPLEMENT in wf.stages) || PLAN_GATE in wf.stages || DEVIATION_CHECK in wf.stages) return undefined;
  let edges = wf.edges;
  let start = wf.start;
  const newStages: Record<string, unknown> = { ...wf.stages };

  if (stages.planGate) {
    const r = routeThrough(edges, start, IMPLEMENT, PLAN_GATE);
    if (r.rewired === 0) return undefined;
    edges = { ...r.edges, [PLAN_GATE]: IMPLEMENT };
    start = r.start;
    newStages[PLAN_GATE] = stages.planGate;
  }

  // implement → deviation-check → whatever implement used to route to, or back to implement once.
  const after = edges[IMPLEMENT] ?? "stop";
  const declared = typeof after === "function" ? [...(after.targets ?? [])] : [after];
  const check: EdgeFn = Object.assign(
    (ctx: unknown) => (takeDeviationRoute(g) === "reimplement" ? IMPLEMENT : typeof after === "function" ? after(ctx) : after),
    { targets: [...new Set([...declared, IMPLEMENT])] },
  );
  edges = { ...edges, [IMPLEMENT]: DEVIATION_CHECK, [DEVIATION_CHECK]: check };
  newStages[DEVIATION_CHECK] = stages.deviationCheck;

  return {
    ...wf,
    name: trackedName(wf.name),
    description: `${wf.name} tracked by rpivw (${stages.planGate ? "plan approval, " : ""}deviation check after implement). ${wf.description ?? ""}`.trim(),
    start,
    stages: newStages,
    edges,
  };
}

/** A side-effect script stage, the plain-object form of rpiv's `acts.script({ run })`. */
export const scriptStage = (run: (ctx: ScriptCtx) => Promise<void>) => ({ kind: "side-effect", sessionPolicy: "fresh", run });

export interface ScriptCtx {
  cwd: string;
  input?: { artifacts?: readonly { handle: { kind: string; path?: string } }[] };
  state?: { named?: Record<string, readonly { artifacts?: readonly { handle: { kind: string; path?: string } }[] }[]> };
}

function registry(g: Record<symbol, unknown>): WorkflowLike[] {
  let r = g[BUILT_INS] as WorkflowLike[] | undefined;
  if (!r) g[BUILT_INS] = r = [];
  return r;
}

function upsert(g: Record<symbol, unknown>, wf: WorkflowLike) {
  const r = registry(g);
  const i = r.findIndex((w) => w.name === wf.name);
  if (i >= 0) r[i] = wf;
  else r.push(wf);
}

/**
 * Register `<name>-rpivw` for each base. Derives immediately if the base is already
 * registered (e.g. after /reload); otherwise adds a provider that waits for
 * rpiv-pi's provider (same flush batch, run in parallel) to register the base.
 * `onMissing` fires only for names in `required` (bases you explicitly configured).
 */
export function installTrackedWorkflows(
  bases: string[],
  makeStages: (base: string) => { planGate?: unknown; deviationCheck: unknown },
  opts: { g?: Record<symbol, unknown>; waitMs?: number; required?: string[]; onMissing?: (name: string) => void } = {},
): void {
  const g = opts.g ?? (globalThis as Record<symbol, unknown>);
  const missing = (n: string) => {
    if (opts.required?.includes(n)) opts.onMissing?.(n);
  };
  const tryDerive = (name: string) => {
    const base = registry(g).find((w) => w.name === name);
    if (!base) return false;
    const tracked = deriveTracked(base, makeStages(name), g);
    if (tracked) upsert(g, tracked);
    else missing(name);
    return true;
  };
  const pending = bases.filter((n) => !tryDerive(n));
  if (!pending.length) return;
  let providers = g[PROVIDERS] as (() => Promise<void>)[] | undefined;
  if (!providers) g[PROVIDERS] = providers = [];
  providers.push(async () => {
    const deadline = Date.now() + (opts.waitMs ?? 15_000);
    let left = pending;
    while (left.length && Date.now() < deadline) {
      left = left.filter((n) => !tryDerive(n));
      if (left.length) await new Promise((r) => setTimeout(r, 50));
    }
    for (const n of left) missing(n);
  });
}

/** Latest plan artifact visible to a stage: primary input first, then any named channel. */
export function findPlanPath(ctx: ScriptCtx): string | undefined {
  const paths: string[] = [];
  for (const a of ctx.input?.artifacts ?? []) if (a.handle.kind === "fs" && a.handle.path) paths.push(a.handle.path);
  for (const outs of Object.values(ctx.state?.named ?? {})) {
    for (const o of outs) for (const a of o.artifacts ?? []) if (a.handle.kind === "fs" && a.handle.path) paths.push(a.handle.path);
  }
  const plans = paths.map((p) => p.replace(/\\/g, "/")).filter((p) => /(^|\/)\.rpiv\/artifacts\/plans\/[^/]+\.md$/.test(p));
  return plans.at(-1);
}

/** The bead a gate blocks, from bd's "Ad-hoc gate blocking <id>" description. */
export const gateBlocks = (description: string | undefined) => description?.match(/gate blocking (\S+)/)?.[1];

/** Plan path recorded in a gate's reason: "Reason: <plan> (run <id>)". */
export const gatePlan = (description: string | undefined) => description?.match(/Reason: (\S+)/)?.[1];

export const isRpivwGate = (b: Bead) => b.issue_type === "gate" && !!b.labels?.some((l) => l === GATE_LABEL || l === DEVIATION_LABEL);

// ---------------------------------------------------------------- stage bodies

export interface GateDeps {
  beads?: Beads;
  /** The run id handed over by onStageStart for this cwd (script stages don't get it). */
  takeRunId(cwd: string): string | undefined;
  /** Bead and project linked to a run, via the run's name. */
  linkFor(cwd: string, runId: string): Promise<{ bead?: string; projectKey?: string }>;
  notify(msg: string, level?: "info" | "warning" | "error"): void;
}

/** What a halted run shows, and what `/work next` surfaces. */
/** The halt reason rpiv shows ("✗ plan-approval script threw — stopping workflow: …"); the gate id leads so a cut-off toast still says what to do. */
export const awaitingPlan = (gateId: string) => `⏸ waiting for plan approval (gate ${gateId}): /work review ${gateId} · /work approve ${gateId}`;
export const approveHint = (gateId: string) => `/work approve ${gateId} [notes]  ·  /work reject ${gateId} <notes>`;
export const deviationHint = (gateId: string) =>
  `/work approve ${gateId} [notes] to continue  ·  /skill:revise the plan, then /work approve ${gateId} --reimplement`;

/**
 * The `plan-approval` stage body. Fails closed: if the run can't be tied to a bead,
 * the run stops with an explanation instead of skipping the approval.
 */
export function makePlanGate(deps: GateDeps) {
  return async (ctx: ScriptCtx): Promise<void> => {
    const runId = deps.takeRunId(ctx.cwd);
    if (!runId || !deps.beads) {
      throw new Error("plan approval: couldn't identify this run or reach beads. Start tracked runs with /work start, or use the plain workflow.");
    }
    const { bead, projectKey } = await deps.linkFor(ctx.cwd, runId);
    if (!bead) {
      throw new Error(`plan approval: run ${runId} isn't linked to a bead. Start it with /work start <bead> build, or use the plain workflow.`);
    }
    const mine = (await deps.beads.gates()).filter((g) => g.await_id === runId && g.labels?.includes(GATE_LABEL));
    const latest = mine.at(-1);
    if (latest?.status === "closed") return; // approved: continue into implement
    if (latest) throw new Error(awaitingPlan(latest.id));

    const plan = findPlanPath(ctx) ?? "the plan";
    const title = (await deps.beads.show(bead)).title;
    const gate = await deps.beads.createGate({
      blocks: bead,
      title: `Plan approval: ${title}`,
      reason: `${plan} (run ${runId})`,
      awaitId: runId,
      labels: [GATE_LABEL, ...(projectKey ? [projectLabel(projectKey)] : [])],
    });
    await deps.beads.comment(bead, `plan ready for approval: ${plan}. ${approveHint(gate.id)}`);
    const review = (await deps.reviewLines?.(ctx.cwd, plan, gate.id).catch(() => [])) ?? [];
    deps.notify([`rpivw: plan ready for review: ${plan}`, ...review, approveHint(gate.id)].join("\n"), "info");
    throw new Error(awaitingPlan(gate.id));
  };
}

/**
 * The `deviation-check` stage body, after implement. Halts while a major deviation
 * gate for this run is open. A resolved gate labeled --reimplement routes back to
 * implement exactly once (the label is swapped so the next pass continues).
 * Runs that aren't linked to a bead have nothing to check and pass.
 */
export function makeDeviationCheck(deps: GateDeps, g: Record<symbol, unknown> = globalThis as never) {
  return async (ctx: ScriptCtx): Promise<void> => {
    setDeviationRoute("continue", g);
    const runId = deps.takeRunId(ctx.cwd);
    if (!runId || !deps.beads) return;
    const mine = (await deps.beads.gates()).filter((x) => x.await_id === runId && x.labels?.includes(DEVIATION_LABEL));
    const open = mine.filter((x) => x.status !== "closed");
    if (open.length) {
      throw new Error(`major deviation awaiting your decision: ${deviationHint(open[0].id)}`);
    }
    const redo = mine.find((x) => x.labels?.includes(REIMPLEMENT_LABEL));
    if (redo) {
      await deps.beads.updateLabels(redo.id, [REIMPLEMENTED_LABEL], [REIMPLEMENT_LABEL]);
      const { bead } = await deps.linkFor(ctx.cwd, runId);
      if (bead) await deps.beads.comment(bead, `run ${runId}: re-running implement after deviation ${redo.id}`);
      setDeviationRoute("reimplement", g);
    }
  };
}
