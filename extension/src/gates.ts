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
//   re-runs the halted stage, which now passes and hands the driver's notes to implement
//   (src/notes.ts) before the run continues.
// - deviation-check (always): halts while a major deviation (recorded by the
//   work_deviation tool) is open. `/work approve <gate>` continues; `/work approve
//   <gate> --reimplement` (after /skill:revise) routes back to `implement` once, with
//   the driver's notes appended to the plan the same way.
//
// A separate name means rpiv-pi re-registering `build` can never clobber the variant,
// and a plain `/wf build` stays untouched.

import { type Bead, type Beads, approvalFor, projectLabel } from "./beads.ts";
import { appendGateNotes } from "./notes.ts";

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

// rpiv-workflow routing-dsl.ts ROUTE_NOTE. An edge sets it on itself during a pick
// (setRouteNote); the runner reads and clears it on the edge the workflow holds
// (takeRouteNote). A decision `stop` that carries a note halts the run as a blocked
// gate; without one the run finishes as completed (runner/chain-advance.ts
// isBlockedGateStop). So a wrapper must hand on its inner edge's note for every pick.
const ROUTE_NOTE = Symbol.for("rpiv.workflow.routeNote");
const setNote = (fn: EdgeFn, note: string | undefined) => {
  (fn as unknown as Record<symbol, unknown>)[ROUTE_NOTE] = note;
};
const noteOf = (fn: EdgeFn) => (fn as unknown as Record<symbol, string | undefined>)[ROUTE_NOTE];

/**
 * Call `inner` on behalf of `outer` (the edge the workflow holds): clear any stale note on
 * `inner` first, then move the note this pick set (or none) onto `outer`. Edges run
 * synchronously and the runner takes the note in the same tick, so nothing interleaves.
 */
function delegate(inner: EdgeFn, outer: EdgeFn, ctx: unknown): string {
  setNote(inner, undefined);
  const pick = inner(ctx);
  setNote(outer, noteOf(inner));
  setNote(inner, undefined);
  return pick;
}

/**
 * Route every edge into `before` through `gate` first. Returns the number of routes rewired.
 * Only function edges that can return `before` are wrapped (an edge without declared
 * targets is wrapped to be safe); every other edge stays the same function object.
 */
function routeThrough(edges: Record<string, Edge>, start: string, before: string, gate: string): { edges: Record<string, Edge>; start: string; rewired: number } {
  let rewired = 0;
  const out: Record<string, Edge> = {};
  for (const [from, target] of Object.entries(edges)) {
    if (typeof target === "string") {
      if (target === before) rewired++;
      out[from] = target === before ? gate : target;
    } else if (typeof target === "function" && (!target.targets || target.targets.includes(before))) {
      const orig = target;
      const wrapped: EdgeFn = Object.assign((ctx: unknown) => {
        const t = delegate(orig, wrapped, ctx);
        return t === before ? gate : t;
      }, orig);
      setNote(wrapped, undefined); // Object.assign copied whatever note orig held at derive time
      if (orig.targets) {
        wrapped.targets = orig.targets.map((t) => (t === before ? gate : t));
        rewired++;
      }
      out[from] = wrapped;
    } else out[from] = target;
  }
  if (start === before) rewired++;
  return { edges: out, start: start === before ? gate : start, rewired };
}

type Route = "continue" | "reimplement";
type RouteSlot = Record<string, { route: Route; at: number }>;
const routeSlot = (g: Record<symbol, unknown>): RouteSlot => (g[ROUTE_SLOT] ??= {}) as RouteSlot;

/**
 * The decision deviation-check hands to its own outgoing edge, keyed by run: the slot is
 * process-wide, and rpiv awaits the stage-end listeners before it evaluates the edge, so
 * another run's check can run in between.
 */
export function setDeviationRoute(runId: string, route: Route, g: Record<symbol, unknown> = globalThis as never) {
  routeSlot(g)[runId] = { route, at: Date.now() };
}
function takeDeviationRoute(g: Record<symbol, unknown>, runId: string | undefined): Route {
  if (!runId) return "continue";
  const slot = routeSlot(g);
  const v = slot[runId];
  delete slot[runId];
  return v && Date.now() - v.at < 60_000 ? v.route : "continue";
}

/** An rpiv output envelope; every one carries its run id (rpiv-workflow output.ts, OutputMeta.runId). */
interface Envelope {
  meta?: { runId?: string };
}

/** The run id on the envelopes a stage or edge can see: `primary` first, then the run's latest output, then any named channel. */
export function runIdFrom(
  primary: Envelope | undefined,
  state?: { output?: Envelope; named?: Record<string, readonly Envelope[]> },
): string | undefined {
  const direct = primary?.meta?.runId ?? state?.output?.meta?.runId;
  if (direct) return direct;
  for (const outs of Object.values(state?.named ?? {})) {
    const id = outs.at(-1)?.meta?.runId;
    if (id) return id;
  }
  return undefined;
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
    (ctx: unknown) => {
      setNote(check, undefined);
      const c = ctx as { output?: Envelope; state?: { output?: Envelope; named?: Record<string, readonly Envelope[]> } } | undefined;
      if (takeDeviationRoute(g, runIdFrom(c?.output, c?.state)) === "reimplement") return IMPLEMENT;
      // implement's own edge decides, and its note (a noted stop halts the run) comes with it.
      return typeof after === "function" ? delegate(after, check, ctx) : after;
    },
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

type ArtifactsEnvelope = Envelope & { artifacts?: readonly { handle: { kind: string; path?: string } }[] };

export interface ScriptCtx {
  cwd: string;
  input?: ArtifactsEnvelope;
  state?: { output?: ArtifactsEnvelope; named?: Record<string, readonly ArtifactsEnvelope[]> };
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

/**
 * The driver's notes for a decided gate, appended once to the plan the next stage reads.
 * Silent when they decided without a note, and when the notes are already in the file
 * (resume re-runs the halted stage, so this runs more than once).
 */
async function applyGateNotes(
  gate: Bead,
  kind: "approval" | "deviation",
  ctx: ScriptCtx,
  beads: Beads,
  bead: string,
  notify: (msg: string, level?: "info" | "warning" | "error") => void,
): Promise<void> {
  try {
    const note = approvalFor(await beads.show(bead), gate.id);
    if (!note?.notes?.trim()) return;
    // A plan gate records the plan in its reason; a deviation gate's reason is what the
    // model found, so its plan comes from the run's own channels.
    const plan = kind === "approval" ? gatePlan(gate.description) ?? findPlanPath(ctx) : findPlanPath(ctx);
    if (!plan) {
      notify(`rpivw: your ${kind} notes for gate ${gate.id} are on ${bead}; no plan artifact to add them to.`, kind === "approval" ? "warning" : "info");
      return;
    }
    const outcome = appendGateNotes(plan, ctx.cwd, { gate: gate.id, kind, notes: note.notes, at: note.at, via: note.via });
    if (outcome === "appended") notify(`rpivw: your ${kind} notes are in ${plan} (gate ${gate.id}), where implement will read them.`);
    else if (outcome === "missing") notify(`rpivw: couldn't add your notes for gate ${gate.id}: no plan at ${plan}.`, "warning");
  } catch (e) {
    notify(`rpivw: couldn't add notes for gate ${gate.id}: ${(e as Error).message}`, "warning");
  }
}

/**
 * Plan path recorded in a plan gate's reason: "Reason: <plan>.md (run <id>)". Undefined when
 * the gate found no plan (older gates recorded "the plan (run …)").
 */
export const gatePlan = (description: string | undefined) => description?.match(/Reason: (\S+\.md) \(run /)?.[1];

export const isRpivwGate = (b: Bead) => b.issue_type === "gate" && !!b.labels?.some((l) => l === GATE_LABEL || l === DEVIATION_LABEL);

// ---------------------------------------------------------------- stage bodies

export interface GateDeps {
  beads?: Beads;
  /**
   * Fallback run id, handed over by onStageStart for this cwd. It's keyed by cwd, so two
   * runs in one checkout can race; stages prefer the run id on their input envelopes.
   */
  takeRunId(cwd: string): string | undefined;
  /** Bead and project linked to a run, via the run's name. */
  linkFor(cwd: string, runId: string): Promise<{ bead?: string; projectKey?: string }>;
  notify(msg: string, level?: "info" | "warning" | "error"): void;
  /** "How to review" lines for a new plan gate (plannotator, file link, diff). */
  reviewLines?(cwd: string, plan: string, gateId: string): Promise<string[]>;
}

/** This stage's run id. Always drains the cwd handoff, so a stale id can't reach a later stage. */
function stageRunId(ctx: ScriptCtx, deps: GateDeps): string | undefined {
  const handed = deps.takeRunId(ctx.cwd);
  return runIdFrom(ctx.input, ctx.state) ?? handed;
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
    const runId = stageRunId(ctx, deps);
    if (!runId || !deps.beads) {
      throw new Error("plan approval: couldn't identify this run or reach beads. Start tracked runs with /work start, or use the plain workflow.");
    }
    const { bead, projectKey } = await deps.linkFor(ctx.cwd, runId);
    if (!bead) {
      throw new Error(`plan approval: run ${runId} isn't linked to a bead. Start it with /work start <bead> build, or use the plain workflow.`);
    }
    const mine = (await deps.beads.gates()).filter((g) => g.await_id === runId && g.labels?.includes(GATE_LABEL));
    const latest = mine.at(-1);
    if (latest?.status === "closed") {
      await applyGateNotes(latest, "approval", ctx, deps.beads, bead, deps.notify);
      return; // approved: continue into implement
    }
    if (latest) throw new Error(awaitingPlan(latest.id));

    const plan = findPlanPath(ctx);
    const shown = plan ?? "(no plan artifact found)";
    const title = (await deps.beads.show(bead)).title;
    const gate = await deps.beads.createGate({
      blocks: bead,
      title: `Plan approval: ${title}`,
      reason: `${plan ?? "no plan artifact found"} (run ${runId})`,
      awaitId: runId,
      labels: [GATE_LABEL, ...(projectKey ? [projectLabel(projectKey)] : [])],
    });
    await deps.beads.comment(bead, `plan ready for approval: ${shown}. ${approveHint(gate.id)}`);
    const review = plan ? ((await deps.reviewLines?.(ctx.cwd, plan, gate.id).catch(() => [])) ?? []) : [];
    deps.notify([`rpivw: plan ready for review: ${shown}`, ...review, approveHint(gate.id)].join("\n"), "info");
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
    const runId = stageRunId(ctx, deps);
    if (!runId || !deps.beads) return; // no decision recorded for the run: its edge continues
    setDeviationRoute(runId, "continue", g);
    const mine = (await deps.beads.gates()).filter((x) => x.await_id === runId && x.labels?.includes(DEVIATION_LABEL));
    const open = mine.filter((x) => x.status !== "closed");
    if (open.length) {
      throw new Error(`major deviation awaiting your decision: ${deviationHint(open[0].id)}`);
    }
    const redo = mine.find((x) => x.labels?.includes(REIMPLEMENT_LABEL));
    if (redo) {
      await deps.beads.updateLabels(redo.id, [REIMPLEMENTED_LABEL], [REIMPLEMENT_LABEL]);
      const { bead } = await deps.linkFor(ctx.cwd, runId);
      if (bead) {
        await deps.beads.comment(bead, `run ${runId}: re-running implement after deviation ${redo.id}`);
        await applyGateNotes(redo, "deviation", ctx, deps.beads, bead, deps.notify);
      }
      setDeviationRoute(runId, "reimplement", g);
    }
  };
}
