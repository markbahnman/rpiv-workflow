import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Bead, BeadComment, Beads, RpivMeta } from "../src/beads.ts";
import { recordDeviation } from "../src/deviation.ts";
import {
  DEVIATION_CHECK,
  DEVIATION_LABEL,
  deriveTracked,
  findPlanPath,
  GATE_LABEL,
  gateBlocks,
  gatePlan,
  installTrackedWorkflows,
  makeDeviationCheck,
  makePlanGate,
  PLAN_GATE,
  REIMPLEMENT_LABEL,
  REIMPLEMENTED_LABEL,
  scriptStage,
  setDeviationRoute,
  type WorkflowLike,
} from "../src/gates.ts";
import { applyPlanReview, type WorkCtx, workApprove, workNext, workReject, workStart } from "../src/work.ts";

// ---------------------------------------------------------------- workflow derivation

// rpiv hands edges an untyped ctx; these fakes read only `pass`.
const route = (targets: string[], fn: (ctx: { pass: boolean }) => string) =>
  Object.assign((ctx: unknown) => fn(ctx as { pass: boolean }), { targets, readsData: false });

function buildLike(): WorkflowLike {
  return {
    name: "build",
    description: "the real one",
    start: "goal",
    stages: { goal: {}, plan: {}, "code-cite-check": {}, "code-grade": {}, implement: {}, "scope-check": {}, validate: {} },
    edges: {
      goal: "plan",
      plan: "code-cite-check",
      "code-cite-check": route(["implement", "code-grade"], (c) => (c.pass ? "implement" : "code-grade")),
      "code-grade": "implement",
      implement: "scope-check",
      "scope-check": "validate",
      validate: "stop",
    },
  };
}

test("deriveTracked adds plan-approval before implement and deviation-check after it", () => {
  const g: Record<symbol, unknown> = {};
  const base = buildLike();
  const t = deriveTracked(base, { planGate: scriptStage(async () => {}), deviationCheck: scriptStage(async () => {}) }, g)!;
  assert.equal(t.name, "build-rpivw");
  assert.equal(t.edges["code-grade"], PLAN_GATE);
  assert.equal(t.edges[PLAN_GATE], "implement");
  assert.equal(t.edges.implement, DEVIATION_CHECK);
  const cite = t.edges["code-cite-check"] as ((c: { pass: boolean }) => string) & { targets: string[]; readsData: boolean };
  assert.equal(cite({ pass: true }), PLAN_GATE);
  assert.deepEqual(cite.targets, [PLAN_GATE, "code-grade"]);
  assert.equal(cite.readsData, false, "route metadata preserved");

  const check = t.edges[DEVIATION_CHECK] as ((c: unknown) => string) & { targets: string[] };
  const edgeCtx = (runId: string) => ({ output: { meta: { runId } }, state: { named: {} } });
  assert.deepEqual(check.targets, ["scope-check", "implement"]);
  assert.equal(check(edgeCtx("run-1")), "scope-check", "default: continue to implement's original next stage");
  setDeviationRoute("run-1", "reimplement", g);
  assert.equal(check(edgeCtx("run-2")), "scope-check", "another run's edge doesn't see run-1's decision");
  assert.equal(check({}), "scope-check", "an edge that can't tell its run continues");
  assert.equal(check(edgeCtx("run-1")), "implement", "a reimplement decision routes back once");
  assert.equal(check(edgeCtx("run-1")), "scope-check", "the decision is consumed");

  assert.equal(base.edges["code-grade"], "implement", "base workflow not mutated");
  assert.equal(deriveTracked({ ...base, stages: { goal: {} } }, { deviationCheck: {} }), undefined, "no implement stage → no variant");
});

test("without a plan gate only deviation-check is added; function edges out of implement are kept", () => {
  const g: Record<symbol, unknown> = {};
  const ship: WorkflowLike = {
    name: "ship",
    start: "plan",
    stages: { plan: {}, implement: {}, validate: {}, fix: {} },
    edges: { plan: "implement", implement: route(["validate", "fix"], (c) => (c.pass ? "validate" : "fix")), validate: "stop", fix: "stop" },
  };
  const t = deriveTracked(ship, { deviationCheck: {} }, g)!;
  assert.equal(t.name, "ship-rpivw");
  assert.equal(t.edges.plan, "implement");
  assert.ok(!(PLAN_GATE in t.stages));
  const check = t.edges[DEVIATION_CHECK] as ((c: { pass: boolean }) => string) & { targets: string[] };
  assert.deepEqual(check.targets, ["validate", "fix", "implement"]);
  assert.equal(check({ pass: false }), "fix", "original routing function still decides");
});

// rpiv-workflow routing-dsl.ts: setRouteNote / takeRouteNote use this symbol on the edge function.
const ROUTE_NOTE = Symbol.for("rpiv.workflow.routeNote");
type Noted = ((c: unknown) => string) & { targets?: string[]; [ROUTE_NOTE]?: string };
const setRouteNote = (fn: Noted, note: string) => void (fn[ROUTE_NOTE] = note);
const takeRouteNote = (fn: Noted) => {
  const n = fn[ROUTE_NOTE];
  fn[ROUTE_NOTE] = undefined;
  return n;
};

test("route notes survive derivation: a noted stop still halts build-rpivw", () => {
  // Shaped like rpiv-pi's build: code-demote can reach implement and notes some picks;
  // validate can't reach implement and notes its stops (a noted stop = blocked gate, not success).
  let demote: "implement" | "code-snapshot" = "code-snapshot";
  const codeDemote: Noted = Object.assign(
    () => {
      if (demote === "code-snapshot") setRouteNote(codeDemote, "unit failed: correctness");
      return demote;
    },
    { targets: ["implement", "code-snapshot"] },
  );
  let validateFails = true;
  const validate: Noted = Object.assign(
    () => {
      if (!validateFails) return "commit";
      setRouteNote(validate, "validate failed with no remediable handle");
      return "stop";
    },
    { targets: ["commit", "stop"] },
  );
  const implementNext: Noted = Object.assign(
    () => {
      setRouteNote(implementNext, "integrity stop");
      return "stop";
    },
    { targets: ["validate", "stop"] },
  );
  setRouteNote(codeDemote, "stale note from an earlier run");
  const base: WorkflowLike = {
    name: "build",
    start: "plan",
    stages: { plan: {}, "code-demote": {}, "code-snapshot": {}, implement: {}, validate: {}, commit: {} },
    edges: { plan: "code-demote", "code-demote": codeDemote, "code-snapshot": "code-demote", implement: implementNext, validate, commit: "stop" },
  };
  const t = deriveTracked(base, { planGate: {}, deviationCheck: {} }, {})!;

  assert.equal(t.edges.validate, validate, "edges that can't reach implement aren't wrapped");
  assert.equal(validate({}), "stop");
  assert.equal(takeRouteNote(t.edges.validate as Noted), "validate failed with no remediable handle");

  const wrapped = t.edges["code-demote"] as Noted;
  assert.notEqual(wrapped, codeDemote);
  assert.equal(takeRouteNote(wrapped), undefined, "a note on the original at derive time isn't copied");
  assert.equal(wrapped({}), "code-snapshot");
  assert.equal(takeRouteNote(wrapped), "unit failed: correctness", "the runner finds the pick's note on the edge it holds");
  assert.equal(takeRouteNote(codeDemote), undefined, "and none is left behind on rpiv's original");
  demote = "implement";
  assert.equal(wrapped({}), PLAN_GATE);
  assert.equal(takeRouteNote(wrapped), undefined, "a noteless pick carries no note");

  const check = t.edges[DEVIATION_CHECK] as Noted;
  assert.equal(check({}), "stop");
  assert.equal(takeRouteNote(check), "integrity stop", "deviation-check hands on implement's own edge's note");
  assert.equal(takeRouteNote(implementNext), undefined);
  validateFails = false;
});

test("installTrackedWorkflows derives now if the base exists, else waits via a provider", async () => {
  const BUILT = Symbol.for("@juicesharp/rpiv-workflow:built-ins");
  const PROV = Symbol.for("@juicesharp/rpiv-workflow:built-in-providers:providers");
  const stages = () => ({ deviationCheck: {} });

  const now: Record<symbol, unknown> = { [BUILT]: [buildLike()] };
  installTrackedWorkflows(["build"], stages, { g: now });
  assert.deepEqual((now[BUILT] as WorkflowLike[]).map((w) => w.name), ["build", "build-rpivw"]);
  installTrackedWorkflows(["build"], stages, { g: now });
  assert.equal((now[BUILT] as WorkflowLike[]).length, 2, "re-install replaces by name");

  const later: Record<symbol, unknown> = {};
  installTrackedWorkflows(["build"], stages, { g: later, waitMs: 2000 });
  setTimeout(() => (later[BUILT] as WorkflowLike[]).push(buildLike()), 100);
  await (later[PROV] as (() => Promise<void>)[])[0]();
  assert.deepEqual((later[BUILT] as WorkflowLike[]).map((w) => w.name), ["build", "build-rpivw"]);

  const missing: string[] = [];
  const none: Record<symbol, unknown> = {};
  installTrackedWorkflows(["build", "polish"], stages, { g: none, waitMs: 120, required: ["build"], onMissing: (n) => missing.push(n) });
  await (none[PROV] as (() => Promise<void>)[])[0]();
  assert.deepEqual(missing, ["build"], "only configured bases warn");
});

test("findPlanPath prefers plan artifacts from input or named channels", () => {
  const fs = (path: string) => ({ handle: { kind: "fs", path } });
  assert.equal(
    findPlanPath({
      cwd: ".",
      input: { artifacts: [fs(".rpiv/artifacts/verdicts/v.json")] },
      state: { named: { plan: [{ artifacts: [fs(".rpiv\\artifacts\\plans\\p1.md")] }], splice: [{ artifacts: [fs(".rpiv/artifacts/plans/p2.md")] }] } },
    }),
    ".rpiv/artifacts/plans/p2.md",
  );
  assert.equal(findPlanPath({ cwd: "." }), undefined);
  assert.equal(gateBlocks("Ad-hoc gate blocking rw-5b3.1\n\nReason: x"), "rw-5b3.1");
  assert.equal(gatePlan("Ad-hoc gate blocking rw-1\n\nReason: .rpiv/artifacts/plans/p.md (run r1)"), ".rpiv/artifacts/plans/p.md");
});

// ---------------------------------------------------------------- fake bd

function world() {
  const beads = new Map<string, Bead>();
  const calls: string[] = [];
  let n = 0;
  const api: Beads = {
    create: async () => ({}) as Bead,
    show: async (id) => {
      const b = beads.get(id);
      if (!b) throw new Error(`no ${id}`);
      return b;
    },
    ready: async () => [...beads.values()].filter((b) => b.status === "open" && b.issue_type !== "gate"),
    list: async () => [],
    claim: async () => {},
    patchRpiv: async (id, f): Promise<RpivMeta> => {
      const b = beads.get(id)!;
      const next = f({ ...((b.metadata?.rpiv as RpivMeta) ?? {}) });
      b.metadata = { ...b.metadata, rpiv: next };
      return next;
    },
    comment: async (id, text) => void calls.push(`comment ${id}: ${text}`),
    comments: async (): Promise<BeadComment[]> => [],
    close: async () => {},
    createGate: async (p) => {
      const g: Bead = {
        id: `rw-g${++n}`,
        title: p.title,
        description: `Ad-hoc gate blocking ${p.blocks}\n\nReason: ${p.reason}`,
        status: "open",
        issue_type: "gate",
        await_id: p.awaitId,
        labels: p.labels,
      };
      beads.set(g.id, g);
      return g;
    },
    gates: async () => [...beads.values()].filter((b) => b.issue_type === "gate"),
    resolveGate: async (id) => {
      beads.get(id)!.status = "closed";
      calls.push(`resolve ${id}`);
    },
    updateLabels: async (id, add, remove) => {
      const b = beads.get(id)!;
      b.labels = [...(b.labels ?? []).filter((l) => !remove.includes(l)), ...add];
    },
  };
  beads.set("rw-5b3", { id: "rw-5b3", title: "CSV export", status: "in_progress", issue_type: "feature", labels: ["project:k"] });
  return { api, beads, calls };
}

const wctx = (api: Beads): WorkCtx => ({ beads: api, project: { key: "k", name: "dash" }, projectNames: { k: "dash" } });

// ---------------------------------------------------------------- plan gate

test("plan gate: halts with a new gate, halts again while open, passes once approved", async () => {
  const w = world();
  const notes: string[] = [];
  let handed: string | undefined = "run-1";
  const gate = makePlanGate({
    beads: w.api,
    takeRunId: () => handed,
    linkFor: async () => ({ bead: "rw-5b3", projectKey: "k" }),
    notify: (m) => notes.push(m),
    reviewLines: async (_cwd, plan, id) => [`annotate: /work review ${id}`, `open: ${plan}`],
  });
  const ctx = { cwd: "/co", input: { artifacts: [{ handle: { kind: "fs", path: ".rpiv/artifacts/plans/p.md" } }] } };

  await assert.rejects(gate(ctx), /waiting for plan approval \(gate rw-g1\): \/work review rw-g1 · \/work approve rw-g1/);
  const g = w.beads.get("rw-g1")!;
  assert.equal(g.await_id, "run-1");
  assert.deepEqual(g.labels, [GATE_LABEL, "project:k"]);
  assert.equal(
    notes[0],
    "rpivw: plan ready for review: .rpiv/artifacts/plans/p.md\nannotate: /work review rw-g1\nopen: .rpiv/artifacts/plans/p.md\n" +
      "/work approve rw-g1 [notes]  ·  /work reject rw-g1 <notes>",
  );
  await assert.rejects(gate(ctx), /waiting for plan approval \(gate rw-g1\)/);
  assert.equal((await w.api.gates()).length, 1, "no duplicate gate");

  assert.match(await workNext(wctx(w.api), ""), /awaiting you \(dash\):\n {2}rw-g1 {2}Plan approval: CSV export/);
  const waiting = await workNext({ ...wctx(w.api), root: join(tmpdir(), "checkout") }, "");
  assert.match(waiting, / {6}plan: \.rpiv\/artifacts\/plans\/p\.md\n {6}open: file:\/\/\/.*checkout\/\.rpiv\/artifacts\/plans\/p\.md/, "the gate shows the plan it holds");
  const rej = await workReject(wctx(w.api), "rw-g1 split the export into two phases");
  assert.equal(rej.revise, "/skill:revise .rpiv/artifacts/plans/p.md split the export into two phases");
  assert.match(rej.message, /recorded on rw-5b3; rw-g1 stays open/);
  await assert.rejects(workApprove(wctx(w.api), "rw-g1 --reimplement"), /applies to deviation gates/);

  const ok = await workApprove(wctx(w.api), "rw-g1 looks good, watch memory");
  assert.deepEqual(ok, { message: "plan approved (rw-g1 for rw-5b3)", runId: "run-1" });
  assert.ok(w.calls.includes("comment rw-5b3: plan approved: looks good, watch memory (gate rw-g1)"));
  await gate(ctx);
  await assert.rejects(workApprove(wctx(w.api), "rw-g1"), /already resolved/);
  await assert.rejects(workApprove(wctx(w.api), "rw-5b3"), /isn't an rpivw gate/);

  handed = undefined;
  await assert.rejects(gate(ctx), /couldn't identify this run/, "fails closed");
});

test("gate stages take the run id from their input envelopes before the cwd handoff", async () => {
  // Two runs in one checkout: the cwd handoff can hold the other run's id.
  const w = world();
  const taken: string[] = [];
  const linked: string[] = [];
  const deps = {
    beads: w.api,
    takeRunId: (cwd: string) => (taken.push(cwd), "run-other"),
    linkFor: async (_cwd: string, runId: string) => (linked.push(runId), { bead: "rw-5b3", projectKey: "k" }),
    notify: () => {},
  };
  const plan = ".rpiv/artifacts/plans/p.md";
  const envelope = { meta: { runId: "run-1" }, artifacts: [{ handle: { kind: "fs", path: plan } }] };
  await assert.rejects(makePlanGate(deps)({ cwd: "/co", input: envelope }), /waiting for plan approval/);
  assert.equal(w.beads.get("rw-g1")!.await_id, "run-1");
  assert.deepEqual(linked, ["run-1"]);
  assert.deepEqual(taken, ["/co"], "the handoff is still drained");

  // deviation-check: the input may be a non-producing stage's; the named channels still carry the id.
  const g: Record<symbol, unknown> = {};
  await recordDeviation({ severity: "major", found: "f", impact: "i", proposal: "revise" }, devDeps(w.api, []));
  await assert.rejects(
    makeDeviationCheck(deps, g)({ cwd: "/co", state: { named: { plans: [envelope] } } }),
    /major deviation awaiting your decision: \/work approve rw-g2/,
  );
});

test("a plan gate with no plan artifact says so, and nothing treats the wording as a path", async () => {
  const w = world();
  const gate = makePlanGate({ beads: w.api, takeRunId: () => "run-1", linkFor: async () => ({ bead: "rw-5b3", projectKey: "k" }), notify: () => {} });
  await assert.rejects(gate({ cwd: "/co" }), /waiting for plan approval \(gate rw-g1\)/);
  assert.match(w.beads.get("rw-g1")!.description!, /Reason: no plan artifact found \(run run-1\)/);
  assert.equal(gatePlan(w.beads.get("rw-g1")!.description), undefined);
  assert.ok(w.calls.some((c) => c.startsWith("comment rw-5b3: plan ready for approval: (no plan artifact found).")));
  assert.equal(gatePlan("Ad-hoc gate blocking rw-1\n\nReason: the plan (run r1)"), undefined, "the old placeholder isn't a path");

  const rej = await workReject(wctx(w.api), "rw-g1 split it");
  assert.equal(rej.revise, undefined, "no /skill:revise without a plan");
  assert.match(rej.message, /revise the plan, then \/work approve rw-g1/);
  assert.doesNotMatch(await workNext(wctx(w.api), ""), /plan:/);
});

test("a deviation gate's reason is never shown as its plan", async () => {
  const w = world();
  await recordDeviation({ severity: "major", found: "docs/api.md", impact: "i", proposal: "revise" }, devDeps(w.api, []));
  assert.doesNotMatch(await workNext({ ...wctx(w.api), root: "/co" }, ""), /plan:/);
});

test("/work approve keeps the notes as typed; only --reimplement is a flag", async () => {
  const w = world();
  await recordDeviation({ severity: "major", found: "f", impact: "i", proposal: "revise" }, devDeps(w.api, []));
  await workApprove(wctx(w.api), "rw-g1 keep --dry-run as the default,  then --reimplement   phase 3");
  const a = (w.beads.get("rw-5b3")!.metadata!.rpiv as RpivMeta).approvals!["rw-g1"];
  assert.equal(a.notes, "keep --dry-run as the default,  then phase 3");
  assert.equal(w.beads.get("rw-g1")!.status, "closed");
  assert.ok(w.beads.get("rw-g1")!.labels!.includes(REIMPLEMENT_LABEL));
});

test("plan gate fails closed for runs not linked to a bead", async () => {
  const w = world();
  const gate = makePlanGate({ beads: w.api, takeRunId: () => "run-x", linkFor: async () => ({}), notify: () => {} });
  await assert.rejects(gate({ cwd: "/co" }), /isn't linked to a bead/);
});

test("plannotator review: close keeps the gate, annotations ask for a revise, approve resolves and resumes", async () => {
  const w = world();
  const gate = makePlanGate({
    beads: w.api,
    takeRunId: () => "run-1",
    linkFor: async () => ({ bead: "rw-5b3", projectKey: "k" }),
    notify: () => {},
  });
  await assert.rejects(gate({ cwd: "/co", input: { artifacts: [{ handle: { kind: "fs", path: ".rpiv/artifacts/plans/p.md" } }] } }));

  const closed = await applyPlanReview(wctx(w.api), "rw-g1", { feedback: "", exit: true });
  assert.match(closed.message, /closed without a decision; rw-g1 stays open/);
  assert.equal(closed.runId, undefined);
  assert.equal(w.beads.get("rw-g1")!.status, "open");

  const changes = await applyPlanReview(wctx(w.api), "rw-g1", { feedback: "Phase 2: use KV, not D1" });
  assert.equal(changes.revise, "/skill:revise .rpiv/artifacts/plans/p.md Phase 2: use KV, not D1");
  assert.equal(changes.runId, undefined);
  assert.equal(w.beads.get("rw-g1")!.status, "open", "annotations keep the gate open");
  assert.ok(w.calls.includes("comment rw-5b3: plan changes requested in plannotator (gate rw-g1):\nPhase 2: use KV, not D1"));

  const ok = await applyPlanReview(wctx(w.api), "rw-g1", { approved: true, feedback: "watch bundle size" });
  assert.deepEqual(ok, { message: "plan approved in plannotator (rw-g1 for rw-5b3)", runId: "run-1" });
  assert.equal(w.beads.get("rw-g1")!.status, "closed");
  assert.ok(w.calls.includes("comment rw-5b3: plan approved in plannotator: watch bundle size (gate rw-g1)"));
  await assert.rejects(applyPlanReview(wctx(w.api), "rw-g1", { approved: true }), /already resolved/, "a late second decision is refused");
});

// ---------------------------------------------------------------- deviations

const devDeps = (api: Beads, notes: string[], runId: string | undefined = "run-1") => ({
  beads: api,
  runId,
  link: async () => ({ bead: "rw-5b3", projectKey: "k" }),
  minorPolicy: "notify" as const,
  notify: (m: string) => void notes.push(m),
});

test("work_deviation: minor logs and notifies; major opens a deviation gate and tells the model to stop", async () => {
  const w = world();
  const notes: string[] = [];
  const minor = await recordDeviation({ severity: "minor", found: "paginator already exists", impact: "phase 2 smaller", proposal: "continue", phase: "2" }, devDeps(w.api, notes));
  assert.match(minor.text, /Continue implementing/);
  assert.equal(minor.gateId, undefined);
  assert.ok(w.calls.some((c) => /deviation\(minor\) \[phase 2\], run run-1: found: paginator already exists/.test(c)));
  assert.match(notes[0], /minor deviation on rw-5b3 \[phase 2\]/);

  const quiet: string[] = [];
  await recordDeviation({ severity: "minor", found: "x", impact: "y", proposal: "continue" }, { ...devDeps(w.api, quiet), minorPolicy: "log" });
  assert.deepEqual(quiet, [], "minorPolicy log stays quiet");

  const major = await recordDeviation({ severity: "major", found: "reports are paginated server-side", impact: "phases 3-4", proposal: "revise" }, devDeps(w.api, notes));
  assert.equal(major.gateId, "rw-g1");
  assert.match(major.text, /Stop implementing now/);
  const g = w.beads.get("rw-g1")!;
  assert.deepEqual(g.labels, [DEVIATION_LABEL, "project:k"]);
  assert.equal(g.await_id, "run-1");
  assert.equal(g.title, "Deviation: CSV export");

  const none = await recordDeviation({ severity: "major", found: "x", impact: "y", proposal: "revise" }, { ...devDeps(w.api, notes), runId: undefined });
  assert.match(none.text, /No tracked rpiv run/);
});

test("deviation-check halts while a major deviation is open; approve continues, --reimplement loops once", async () => {
  const w = world();
  const g: Record<symbol, unknown> = {};
  const routeAfter = () => {
    const t = deriveTracked(buildLike(), { deviationCheck: {} }, g)!;
    return (t.edges[DEVIATION_CHECK] as (c: unknown) => string)({ output: { meta: { runId: "run-1" } } });
  };
  const check = makeDeviationCheck({ beads: w.api, takeRunId: () => "run-1", linkFor: async () => ({ bead: "rw-5b3" }), notify: () => {} }, g);

  await check({ cwd: "/co" });
  assert.equal(routeAfter(), "scope-check", "no deviations: continue");

  await recordDeviation({ severity: "major", found: "server-side pagination", impact: "3-4", proposal: "revise" }, devDeps(w.api, []));
  await assert.rejects(check({ cwd: "/co" }), /major deviation awaiting your decision: \/work approve rw-g1 .*--reimplement/);
  assert.match(await workNext(wctx(w.api), ""), /rw-g1 {2}Deviation: CSV export {2}→ {2}\/work approve rw-g1 \[notes\] to continue/);
  await assert.rejects(workReject(wctx(w.api), "rw-g1 nope"), /is a deviation/);

  const r = await workApprove(wctx(w.api), "rw-g1 --reimplement plan revised for streaming");
  assert.equal(r.message, "deviation: re-implement with the revised plan (rw-g1 for rw-5b3)");
  assert.ok(w.beads.get("rw-g1")!.labels!.includes(REIMPLEMENT_LABEL));

  await check({ cwd: "/co" }); // resumed after approval
  assert.equal(routeAfter(), "implement", "routes back to implement");
  assert.ok(w.beads.get("rw-g1")!.labels!.includes(REIMPLEMENTED_LABEL), "decision consumed");
  await check({ cwd: "/co" }); // after the re-implement pass
  assert.equal(routeAfter(), "scope-check", "only once");
});

test("deviation-check passes unlinked runs; plain approve of a deviation continues", async () => {
  const w = world();
  const g: Record<symbol, unknown> = {};
  await makeDeviationCheck({ beads: w.api, takeRunId: () => undefined, linkFor: async () => ({}), notify: () => {} }, g)({ cwd: "/co" });
  await recordDeviation({ severity: "major", found: "f", impact: "i", proposal: "continue" }, devDeps(w.api, []));
  const r = await workApprove(wctx(w.api), "rw-g1 fine as is");
  assert.equal(r.message, "deviation: continue as planned (rw-g1 for rw-5b3)");
  assert.ok(w.calls.includes("comment rw-5b3: deviation: continue as planned: fine as is (gate rw-g1)"));
});

test("the driver's approval notes land in the plan once, where implement reads them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    const plan = ".rpiv/artifacts/plans/p.md";
    mkdirSync(join(dir, ".rpiv", "artifacts", "plans"), { recursive: true });
    writeFileSync(join(dir, plan), "# Plan\n\nphase 1\n");
    const w = world();
    const notes: string[] = [];
    const gate = makePlanGate({
      beads: w.api,
      takeRunId: () => "run-1",
      linkFor: async () => ({ bead: "rw-5b3", projectKey: "k" }),
      notify: (m) => notes.push(m),
    });
    const ctx = { cwd: dir, input: { artifacts: [{ handle: { kind: "fs", path: plan } }] } };

    await assert.rejects(gate(ctx), /waiting for plan approval \(gate rw-g1\)/);
    assert.equal(readFileSync(join(dir, plan), "utf8"), "# Plan\n\nphase 1\n", "an open gate doesn't touch the plan");

    await workApprove(wctx(w.api), "rw-g1 split phase 2 into two slices");
    await gate(ctx); // the resume that follows an approval
    const body = readFileSync(join(dir, plan), "utf8");
    assert.match(body, /^# Plan\n\nphase 1\n\n<!-- rpivw:notes rw-g1 -->\n## Reviewer notes \(plan gate rw-g1, \d{4}-\d\d-\d\d \d\d:\d\d via approve\)\n/);
    assert.match(body, /Honor these notes when implementing\. Where they conflict with the plan above, they win\./);
    assert.match(body, /split phase 2 into two slices\n$/);
    assert.deepEqual(notes.at(-1), "rpivw: your approval notes are in .rpiv/artifacts/plans/p.md (gate rw-g1), where implement will read them.");
    assert.equal(notes.length, 2, "one gate-ready notice, one notes notice");

    await gate(ctx); // resumes replay the stage: no second copy
    assert.equal(readFileSync(join(dir, plan), "utf8"), body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a decision with no notes leaves the plan alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    const plan = ".rpiv/artifacts/plans/p.md";
    mkdirSync(join(dir, ".rpiv", "artifacts", "plans"), { recursive: true });
    writeFileSync(join(dir, plan), "# Plan\n");
    const w = world();
    const notes: string[] = [];
    const gate = makePlanGate({
      beads: w.api,
      takeRunId: () => "run-1",
      linkFor: async () => ({ bead: "rw-5b3", projectKey: "k" }),
      notify: (m) => notes.push(m),
    });
    const ctx = { cwd: dir, input: { artifacts: [{ handle: { kind: "fs", path: plan } }] } };
    await assert.rejects(gate(ctx));
    await workApprove(wctx(w.api), "rw-g1");
    await gate(ctx);
    assert.equal(readFileSync(join(dir, plan), "utf8"), "# Plan\n");
    assert.equal(notes.length, 1, "only the gate-ready notice, nothing about notes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deviation's --reimplement notes land in the plan the re-implement reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    const plan = ".rpiv/artifacts/plans/p.md";
    mkdirSync(join(dir, ".rpiv", "artifacts", "plans"), { recursive: true });
    writeFileSync(join(dir, plan), "# Plan\n");
    const w = world();
    const notes: string[] = [];
    const g: Record<symbol, unknown> = {};
    const check = makeDeviationCheck({ beads: w.api, takeRunId: () => "run-1", linkFor: async () => ({ bead: "rw-5b3" }), notify: (m) => notes.push(m) }, g);
    await recordDeviation({ severity: "major", found: "server-side pagination", impact: "3-4", proposal: "revise" }, devDeps(w.api, []));
    await workApprove(wctx(w.api), "rw-g1 --reimplement redo phase 3 against KV");

    const ctx = { cwd: dir, state: { named: { plans: [{ artifacts: [{ handle: { kind: "fs", path: plan } }] }] } } };
    await check(ctx);
    const body = readFileSync(join(dir, plan), "utf8");
    assert.match(body, /<!-- rpivw:notes rw-g1 -->\n## Reviewer notes \(deviation gate rw-g1, .* via approve\)\n/);
    assert.match(body, /redo phase 3 against KV/);
    assert.deepEqual(notes, ["rpivw: your deviation notes are in .rpiv/artifacts/plans/p.md (gate rw-g1), where implement will read them."]);
    await check(ctx); // the re-implement pass itself, and any later resume
    assert.equal(readFileSync(join(dir, plan), "utf8"), body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- start mapping

test("/work start runs tracked bases as <name>-rpivw", async () => {
  const w = world();
  w.beads.set("rw-9", { id: "rw-9", title: "T", status: "open", issue_type: "feature", labels: ["project:k"] });
  const c = wctx(w.api);
  const reopen = () => void (w.beads.get("rw-9")!.status = "open");
  assert.match((await workStart(c, "rw-9 build", {})).command, /^\/wf build-rpivw /);
  reopen();
  assert.match((await workStart(c, "rw-9", {})).command, /^\/wf ship-rpivw /, "default ship is tracked too");
  reopen();
  w.beads.get("rw-9")!.metadata = { rpiv: { workflow: "build-gated" } };
  assert.match((await workStart(c, "rw-9", {})).command, /^\/wf build-rpivw /, "old -gated runs map to the new name");
  reopen();
  assert.match((await workStart(c, "rw-9 my-custom", {})).command, /^\/wf my-custom /, "untracked workflows run as-is");
});
