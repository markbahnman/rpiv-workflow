import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Bead, type Beads, openBeads, projectLabel, type RpivMeta, rpivMeta, titleFromBrief } from "../src/beads.ts";
import { gitOut } from "../src/exec.ts";
import { createListeners, type LifecycleContext } from "../src/lifecycle.ts";
import { artifactBucket, beadFromRunName, nextRunName, readRunHeader, runNameFor } from "../src/runs.ts";
import { openStore } from "../src/store.ts";

// ---------------------------------------------------------------- pure helpers

test("run names round-trip bead ids and satisfy rpiv's name rule", () => {
  assert.equal(runNameFor("rw-5b3", 1), "rw-5b3--r1");
  assert.equal(runNameFor("rw-5b3.1.2", 3), "rw-5b3_1_2--r3");
  assert.equal(beadFromRunName("rw-5b3_1_2--r3"), "rw-5b3.1.2");
  assert.equal(beadFromRunName("nightly-docs"), undefined);
  assert.equal(beadFromRunName(undefined), undefined);
  assert.equal(nextRunName("rw-5b3", { "rw-5b3--r1": "x", "rw-5b3--r2": "y" }), "rw-5b3--r3");
});

test("artifactBucket maps rpiv paths to store-relative buckets", () => {
  assert.deepEqual(artifactBucket(".rpiv/artifacts/plans/x.md"), ["plans", "plans/x.md"]);
  assert.deepEqual(artifactBucket(".rpiv\\artifacts\\goal\\g.md"), ["goal", "goal/g.md"]);
  assert.equal(artifactBucket(".rpiv/artifacts/loose.md"), undefined);
});

test("titleFromBrief keeps the first line and cuts long ones at a word", () => {
  assert.equal(titleFromBrief("Fix the bug\nwith details"), "Fix the bug");
  const t = titleFromBrief("word ".repeat(40), 30);
  assert.ok(t.length <= 30 && t.endsWith("…"), t);
});

test("readRunHeader reads the JSONL header's name", () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    const runs = join(dir, ".rpiv", "workflows", "runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "r1.jsonl"), `${JSON.stringify({ runId: "r1", workflow: "ship", input: "x", name: "rw-1--r1" })}\n{"stage":1}\n`);
    assert.equal(readRunHeader(dir, "r1")?.name, "rw-1--r1");
    assert.equal(readRunHeader(dir, "missing"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- bd wrapper (real bd)

const hasBd = (() => {
  try {
    execFileSync("bd", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("openBeads drives a real bd database", { skip: !hasBd && "bd not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    await gitOut(dir, "init", "-q");
    execFileSync("bd", ["init", "--quiet", "--stealth", "--prefix", "rt"], {
      cwd: dir,
      env: { ...process.env, BEADS_DIR: join(dir, ".beads") },
      stdio: "ignore",
    });
    const bd = openBeads(dir);
    const label = projectLabel("github.com__me__dash");
    const a = await bd.create({ title: "Feature A", description: "line 1\nline 2", labels: [label] });
    const b = await bd.create({ title: "Other project", labels: [projectLabel("other")] });
    assert.match(a.id, /^rt-/);
    assert.deepEqual(await bd.gates(), [], "no gates yet: bd prints null, we return []");
    assert.deepEqual(await bd.comments(a.id), [], "no comments yet");
    assert.equal((await bd.show(a.id)).description, "line 1\nline 2");

    const ready = await bd.ready({ labels: [label] });
    assert.deepEqual(ready.map((x) => x.id), [a.id], "label filter isolates projects");

    await bd.patchRpiv(a.id, (m) => ({ ...m, phase: "plan", runs: ["r1"] }));
    await bd.patchRpiv(a.id, (m) => ({ ...m, artifacts: { plans: "plans/x.md" } }));
    assert.deepEqual(rpivMeta(await bd.show(a.id)), { phase: "plan", runs: ["r1"], artifacts: { plans: "plans/x.md" } });

    await bd.claim(a.id);
    assert.equal((await bd.list({ labels: [label], status: "in_progress" })).length, 1);

    await bd.comment(a.id, "deviation(minor): x");
    assert.equal((await bd.comments(a.id))[0].text, "deviation(minor): x");

    const gate = await bd.createGate({ blocks: a.id, title: "Plan approval: A", reason: ".rpiv/artifacts/plans/p.md (run r1)", awaitId: "r1", labels: ["rpivw:plan-approval", label] });
    const listed = (await bd.gates()).find((g) => g.id === gate.id)!;
    assert.equal(listed.await_id, "r1");
    assert.deepEqual([...(listed.labels ?? [])].sort(), [label, "rpivw:plan-approval"].sort());
    assert.match(listed.description ?? "", new RegExp(`gate blocking ${a.id}`));
    assert.equal((await bd.ready({ labels: [label] })).length, 0, "the gate blocks the bead");
    await bd.resolveGate(gate.id);
    assert.equal((await bd.gates()).find((g) => g.id === gate.id)!.status, "closed", "gates() includes closed gates");

    await bd.close(a.id, "done");
    assert.equal((await bd.show(a.id)).status, "closed");
    assert.equal((await bd.show(b.id)).status, "open");
    await assert.rejects(bd.show("rt-nope"), /bd show failed|not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- bridge → beads (fake bd)

function fakeBeads() {
  const calls: string[] = [];
  const meta = new Map<string, RpivMeta>();
  const beads: Beads = {
    create: async () => ({}) as Bead,
    show: async (id) => ({ id, title: "t", status: "open", issue_type: "feature" }),
    ready: async () => [],
    list: async () => [],
    claim: async (id) => void calls.push(`claim ${id}`),
    patchRpiv: async (id, patch) => {
      const next = patch({ ...(meta.get(id) ?? {}) });
      meta.set(id, next);
      return next;
    },
    comment: async (id, text) => void calls.push(`comment ${id} ${text}`),
    comments: async () => [],
    close: async (id, reason) => void calls.push(`close ${id} ${reason}`),
    createGate: async () => ({}) as Bead,
    gates: async () => [],
    resolveGate: async () => {},
  };
  return { beads, calls, meta };
}

test("a run named <bead>--r<n> drives the bead through start, stages, and close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    const store = join(dir, "store");
    const artifacts = join(store, "projects", "k", "artifacts");
    mkdirSync(join(artifacts, "plans"), { recursive: true });
    await gitOut(store, "init", "-q", "-b", "main");
    await gitOut(store, "config", "user.name", "t");
    await gitOut(store, "config", "user.email", "t@t");
    const checkout = join(dir, "co");
    const runs = join(checkout, ".rpiv", "workflows", "runs");
    mkdirSync(runs, { recursive: true });
    const runId = "2026-10-03_13-00-00-beef";
    writeFileSync(join(runs, `${runId}.jsonl`), `${JSON.stringify({ runId, workflow: "ship", input: "x", name: "rw-5b3_1--r2" })}\n`);

    const fb = fakeBeads();
    const pushed: unknown[] = [];
    const realStore = openStore(store);
    const l = createListeners({
      store: { ...realStore, push: async (o) => (pushed.push(o), { ok: true, detail: "" }) },
      resolve: async () => ({ key: "k", root: checkout, artifacts }),
      pushOnEnd: () => true,
      notify: (m) => assert.fail(m),
      beads: fb.beads,
    });
    const ctx: LifecycleContext = { cwd: checkout, runId, workflow: "ship", totalStages: 3, trigger: { kind: "command", name: "wf" } };

    await l.onWorkflowStart!(ctx);
    assert.deepEqual(fb.calls, ["claim rw-5b3.1"]);
    assert.deepEqual(fb.meta.get("rw-5b3.1"), { workflow: "ship", phase: "started", runs: [runId] });

    writeFileSync(join(artifacts, "plans", "p.md"), "plan");
    await l.onStageEnd!(
      { kind: "skill", name: "plan", stageNumber: 2, skill: "quick-plan" },
      { kind: "artifact-md", artifacts: [{ handle: { kind: "fs", path: ".rpiv/artifacts/plans/p.md" } }] },
      ctx,
    );
    assert.equal(fb.meta.get("rw-5b3.1")?.phase, "plan");
    assert.deepEqual(fb.meta.get("rw-5b3.1")?.artifacts, { plans: "plans/p.md" });
    assert.equal(await gitOut(store, "log", "-1", "--format=%s"), `${runId} plan [rw-5b3.1]: plans/p.md`);

    await l.onWorkflowEnd!({ runId, stagesCompleted: 3, success: true }, ctx);
    assert.equal(fb.meta.get("rw-5b3.1")?.phase, "done");
    assert.ok(fb.calls.includes(`close rw-5b3.1 ship run ${runId} succeeded`));
    assert.deepEqual(pushed, [{ beads: true }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stopped run comments on the bead instead of closing it; unnamed runs leave beads alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    const store = join(dir, "store");
    mkdirSync(join(store, "projects", "k", "artifacts"), { recursive: true });
    await gitOut(store, "init", "-q", "-b", "main");
    const checkout = join(dir, "co");
    const runs = join(checkout, ".rpiv", "workflows", "runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "named.jsonl"), `${JSON.stringify({ runId: "named", workflow: "ship", input: "x", name: "rw-9--r1" })}\n`);
    writeFileSync(join(runs, "plain.jsonl"), `${JSON.stringify({ runId: "plain", workflow: "ship", input: "x" })}\n`);
    const fb = fakeBeads();
    const l = createListeners({
      store: { root: store, commit: async () => null, push: async () => ({ ok: true, detail: "" }) },
      resolve: async () => ({ key: "k", root: checkout, artifacts: join(store, "projects", "k", "artifacts") }),
      pushOnEnd: () => false,
      notify: () => {},
      beads: fb.beads,
    });
    const base = { cwd: checkout, workflow: "ship", totalStages: 3, trigger: { kind: "command" as const, name: "wf" } };

    await l.onWorkflowEnd!({ runId: "named", stagesCompleted: 1, success: false, error: "stopped at implement-scope-check: excess" }, { ...base, runId: "named" });
    assert.equal(fb.calls.length, 1);
    assert.match(fb.calls[0], /^comment rw-9 run named \(ship\) stopped: stopped at implement-scope-check: excess\. Fix, then resume with \/wf @named$/);

    await l.onWorkflowStart!({ ...base, runId: "plain" });
    await l.onWorkflowEnd!({ runId: "plain", stagesCompleted: 3, success: true }, { ...base, runId: "plain" });
    assert.equal(fb.calls.length, 1, "unlinked run touched no bead");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("childRunId recognizes rpiv stage child sessions and extracts the run id", async () => {
  const { childRunId } = await import("../src/runs.ts");
  assert.equal(childRunId("C:\\Users\\me\\proj\\.rpiv\\workflows\\runs\\2026-10-04_10-00-00-abcd\\sessions"), "2026-10-04_10-00-00-abcd");
  assert.equal(childRunId("/home/me/proj/.rpiv/workflows/runs/r1/sessions/"), "r1");
  assert.equal(childRunId("C:\\Users\\me\\.pi\\agent\\sessions\\--C--Users-me-proj--"), undefined, "launcher session");
  assert.equal(childRunId(undefined), undefined);
});
