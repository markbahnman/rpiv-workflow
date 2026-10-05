import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitOut } from "../src/exec.ts";
import { createListeners, LIFECYCLE_KEY, registerLifecycle, type LifecycleContext } from "../src/lifecycle.ts";
import { commitMessage, openStore } from "../src/store.ts";

async function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  const root = join(dir, "store");
  mkdirSync(join(root, "projects", "k", "artifacts"), { recursive: true });
  await gitOut(root, "init", "-q", "-b", "main");
  await gitOut(root, "config", "user.name", "t");
  await gitOut(root, "config", "user.email", "t@t");
  writeFileSync(join(root, "README.md"), "store");
  await gitOut(root, "add", ".");
  await gitOut(root, "commit", "-q", "-m", "init");
  return { dir, root, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("commitMessage is one readable line", () => {
  assert.equal(
    commitMessage({ runId: "r1", stage: "plan", ref: "rw-5b3", paths: [".rpiv/artifacts/plans/a.md", ".rpiv\\artifacts\\goal\\g.md"] }),
    "r1 plan [rw-5b3]: plans/a.md, goal/g.md",
  );
  assert.equal(commitMessage({ runId: "r1", stage: "x", suffix: "(failed)" }), "r1 x (failed)");
});

test("store.commit commits only when something changed, and serializes", async () => {
  const s = await tempStore();
  try {
    const store = openStore(s.root);
    assert.equal(await store.commit(["projects/k"], "noop"), null);
    writeFileSync(join(s.root, "projects", "k", "artifacts", "a.md"), "a");
    writeFileSync(join(s.root, "projects", "k", "artifacts", "b.md"), "b");
    const [a, b] = await Promise.all([store.commit(["projects/k"], "first"), store.commit(["projects/k"], "second")]);
    assert.ok(a, "first commit happened");
    assert.equal(b, null, "second saw nothing left to commit");
    assert.equal(await gitOut(s.root, "log", "-1", "--format=%s"), "first");
  } finally {
    s.done();
  }
});

test("store.push: a local-only store skips quietly; the configured remote is the one pushed", async () => {
  const s = await tempStore();
  try {
    const local = await openStore(s.root).push();
    assert.deepEqual({ ok: local.ok, skipped: local.skipped }, { ok: true, skipped: true });
    assert.match(local.detail, /local-only store \(no "origin" remote\)/);

    const bare = join(s.dir, "work.git");
    await gitOut(s.dir, "init", "-q", "--bare", bare);
    await gitOut(s.root, "remote", "add", "work", bare);
    assert.equal((await openStore(s.root).push()).skipped, true, "origin still missing");
    const pushed = await openStore(s.root, { remote: () => "work" }).push();
    assert.deepEqual(pushed, { ok: true, detail: "git: pushed" });
    assert.equal(await gitOut(bare, "rev-parse", "main"), await gitOut(s.root, "rev-parse", "HEAD"));
  } finally {
    s.done();
  }
});

test("registerLifecycle uses rpiv-workflow's global slot and disposes cleanly", () => {
  const g: Record<symbol, unknown> = {};
  const a = {};
  const dispose = registerLifecycle(a, g);
  assert.deepEqual(g[LIFECYCLE_KEY], [a]);
  dispose();
  assert.deepEqual(g[LIFECYCLE_KEY], []);
});

test("listeners commit each stage and archive the run at the end", async () => {
  const s = await tempStore();
  try {
    const checkout = join(s.dir, "checkout");
    const artifacts = join(s.root, "projects", "k", "artifacts");
    mkdirSync(join(checkout, ".rpiv", "workflows", "runs"), { recursive: true });
    const notes: string[] = [];
    const l = createListeners({
      store: openStore(s.root),
      resolve: async () => ({ key: "k", root: checkout, artifacts }),
      pushOnEnd: () => false,
      notify: (m) => notes.push(m),
    });
    const ctx: LifecycleContext = {
      cwd: checkout,
      runId: "2026-10-03_10-00-00-abcd",
      workflow: "ship",
      totalStages: 2,
      trigger: { kind: "external", source: "beads", ref: "rw-5b3" },
    };

    mkdirSync(join(artifacts, "research"));
    writeFileSync(join(artifacts, "research", "r.md"), "research");
    await l.onStageEnd!(
      { kind: "skill", name: "research", stageNumber: 1, skill: "research" },
      { kind: "research", artifacts: [{ handle: { kind: "fs", path: ".rpiv/artifacts/research/r.md" } }] },
      ctx,
    );
    assert.equal(await gitOut(s.root, "log", "-1", "--format=%s"), "2026-10-03_10-00-00-abcd research [rw-5b3]: research/r.md");

    // Loop units (grade panel members, fan-out phases) fire onUnitEnd, not onStageEnd.
    mkdirSync(join(artifacts, "verdicts"));
    writeFileSync(join(artifacts, "verdicts", "v.json"), "{}");
    await l.onUnitEnd!(
      { kind: "skill", name: "grade (plans-dim-correctness)", stageNumber: 6, skill: "grade" },
      { role: "produce", index: 0, unitId: "plans-dim-correctness", label: "correctness", skill: "grade" },
      { kind: "json", artifacts: [{ handle: { kind: "fs", path: ".rpiv/artifacts/verdicts/v.json" } }] },
      ctx,
    );
    assert.equal(await gitOut(s.root, "log", "-1", "--format=%s"), `${ctx.runId} grade (plans-dim-correctness) [rw-5b3]: verdicts/v.json`);
    writeFileSync(join(artifacts, "verdicts", "w.json"), "{}");
    await l.onUnitEnd!(
      { kind: "skill", name: "implement", stageNumber: 9, skill: "implement" },
      { role: "produce", index: 1, label: "phase 2/3", skill: "implement" },
      { kind: "artifacts", artifacts: [] },
      ctx,
    );
    assert.equal(await gitOut(s.root, "log", "-1", "--format=%s"), `${ctx.runId} implement (phase 2/3) [rw-5b3]`);

    writeFileSync(join(checkout, ".rpiv", "workflows", "runs", `${ctx.runId}.jsonl`), '{"row":1}\n');
    await l.onWorkflowEnd!({ runId: ctx.runId, stagesCompleted: 2, success: true }, ctx);
    assert.equal(await gitOut(s.root, "log", "-1", "--format=%s"), `${ctx.runId} end [rw-5b3] ship succeeded (2 stage runs)`);
    assert.match(await gitOut(s.root, "show", "--name-only", "--format=", "HEAD"), /runs\/2026-10-03_10-00-00-abcd\.jsonl/);
    assert.deepEqual(notes, []);
  } finally {
    s.done();
  }
});

test("listeners ignore runs outside registered projects and never throw", async () => {
  const s = await tempStore();
  try {
    const notes: string[] = [];
    const l = createListeners({
      store: openStore(join(s.dir, "nope")), // broken store: would throw if used
      resolve: async (cwd) => (cwd === "/registered" ? { key: "k", root: "/x", artifacts: "/x" } : undefined),
      pushOnEnd: () => false,
      notify: (m) => notes.push(m),
    });
    const ctx = { cwd: "/elsewhere", runId: "r", workflow: "w", totalStages: 1, trigger: { kind: "command" as const, name: "wf" } };
    await l.onStageEnd!({ kind: "skill", name: "s", stageNumber: 1 }, { kind: "x", artifacts: [] }, ctx);
    assert.deepEqual(notes, []);
    await l.onStageEnd!({ kind: "skill", name: "s", stageNumber: 1 }, { kind: "x", artifacts: [] }, { ...ctx, cwd: "/registered" });
    assert.equal(notes.length, 1, "store failure surfaces as a warning, not a throw");
  } finally {
    s.done();
  }
});

test("listeners never throw into rpiv, even when notify itself throws (stale session ctx)", async () => {
  const s = await tempStore();
  try {
    const l = createListeners({
      store: { root: s.root, commit: async () => null, push: async () => ({ ok: false, detail: "git push failed: offline" }), showHead: async () => undefined },
      resolve: async () => ({ key: "k", root: s.root, artifacts: join(s.root, "projects", "k", "artifacts") }),
      pushOnEnd: () => true,
      notify: () => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    });
    const ctx = { cwd: "/co", runId: "r", workflow: "ship", totalStages: 1, trigger: { kind: "command" as const, name: "wf" } };
    await l.onWorkflowEnd!({ runId: "r", stagesCompleted: 1, success: true }, ctx); // push fails → report → notify throws
    await l.onStageError!({ kind: "skill", name: "x", stageNumber: 1 }, new Error("boom"), ctx);
  } finally {
    s.done();
  }
});

test("firstError picks the line that explains a failure", async () => {
  const { firstError } = await import("../src/store.ts");
  assert.equal(
    firstError("fatal: 'C:/x/nope.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n"),
    "fatal: 'C:/x/nope.git' does not appear to be a git repository",
  );
  assert.equal(firstError("Error: no Dolt remote is configured\n  hint"), "Error: no Dolt remote is configured");
  assert.equal(firstError("\n  just text\n"), "just text");
  assert.equal(firstError(""), "(no output)");
});
