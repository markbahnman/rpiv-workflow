import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatStopReport, latestStoppedRun, stopReport } from "../src/stopreport.ts";

const PLAN = ".rpiv/artifacts/plans/p.md";

// Row shapes from a real rpiv-workflow 2.12.0 ship run that stopped at grade.
const unit = (dim: string, extra: Record<string, unknown>) => ({
  stage: `grade (plans-dim-${dim})`,
  skill: "grade",
  parent: "grade",
  role: "produce",
  unitId: `plans-dim-${dim}`,
  ...extra,
});
const verdict = (dim: string, pass: boolean, extra: Record<string, unknown> = {}) =>
  unit(dim, {
    status: "completed",
    output: {
      kind: "json",
      artifacts: [{ handle: { kind: "fs", path: `.rpiv\\artifacts\\verdicts\\p__${dim}.json` }, role: "primary" }],
      data: { dimension: dim, pass, score: pass ? 100 : 60, severity: pass ? "none" : "medium", artifact: PLAN, findings: [], feedback: "", ...extra },
    },
  });

const GATE_STOP = [
  { runId: "2026-10-06_22-34-07-c86b", workflow: "ship-rpivw", input: "brief", v: 3 },
  { stage: "plan", status: "completed" },
  { type: "routing", fromStage: "plan-cite-check", decision: "grade" },
  unit("correctness", { status: "failed", unitLabel: "correctness", errMsg: "grade: no verdict collected", session: { file: "C:\\x\\s1.jsonl" } }),
  verdict("completeness", true),
  verdict("architecture-fit", false, {
    findings: [
      { detail: "prettier claims the .rpiv tree", where: "## Phase 2" },
      { detail: "advisory only", advisory: true },
    ],
    feedback: "Add .rpiv to .prettierignore.",
  }),
  verdict("correctness", false, { score: 90, findings: [{ detail: "open.test.js still expects cmd" }], feedback: "Update open.test.js." }),
  { type: "routing", fromStage: "grade", decision: "stop", note: "correctness failed (medium), architecture-fit failed (medium)" },
  { stage: "grade", status: "failed", errMsg: 'Routing gate after "grade" matched no branch: correctness failed (medium)' },
];

function checkout(runs: Record<string, unknown[]>) {
  const root = mkdtempSync(join(tmpdir(), "rpivw-stop-"));
  const dir = join(root, ".rpiv", "workflows", "runs");
  mkdirSync(dir, { recursive: true });
  for (const [id, rows] of Object.entries(runs)) writeFileSync(join(dir, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return root;
}

test("a gate stop lists each failing dimension's latest verdict, the file to edit, and the resume command", (t) => {
  const root = checkout({ "2026-10-06_22-34-07-c86b": GATE_STOP });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = stopReport(root, "2026-10-06_22-34-07-c86b")!;
  assert.equal(r.kind, "gate");
  assert.equal(r.stage, "grade");
  assert.equal(r.workflow, "ship-rpivw");
  // In the order the graders ran; correctness's dead first attempt is superseded by its re-dispatch; completeness passed.
  assert.deepEqual(r.blockers.map((b) => b.name), ["correctness", "architecture-fit"]);
  const arch = r.blockers.find((b) => b.name === "architecture-fit")!;
  assert.equal(arch.rating, "medium, score 60");
  assert.deepEqual(arch.findings, [{ where: "## Phase 2", detail: "prettier claims the .rpiv tree" }], "advisory findings don't block");
  assert.equal(arch.verdict, ".rpiv/artifacts/verdicts/p__architecture-fit.json");
  assert.equal(arch.fix, "Add .rpiv to .prettierignore.");
  assert.match(r.next[0], /^Edit \.rpiv\/artifacts\/plans\/p\.md /);
  assert.match(r.next.at(-1)!, /\/wf @2026-10-06_22-34-07-c86b.*re-runs "grade"/);

  const text = formatStopReport(r);
  assert.match(text, /^✗ ship-rpivw stopped at "grade": 2 checks failed/);
  assert.match(text, /2\. architecture-fit \(medium, score 60\)\n {3}- \[## Phase 2\] prettier claims/);
  assert.match(text, /verdict: \.rpiv\/artifacts\/verdicts\/p__correctness\.json/);
  assert.match(text, /\/work why 2026-10-06_22-34-07-c86b/);
  assert.doesNotMatch(formatStopReport(r, { full: true }), /\/work why/);
});

test("a grader that never produced a verdict is reported with its session", (t) => {
  const rows = [...GATE_STOP];
  rows.splice(6, 1); // drop correctness's re-dispatch: its failed attempt is the latest
  const root = checkout({ r1: rows });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dead = stopReport(root, "r1")!.blockers.find((b) => b.name === "correctness")!;
  assert.equal(dead.rating, "no verdict");
  assert.equal(dead.session, "C:/x/s1.jsonl");
  assert.match(stopReport(root, "r1")!.next.join("\n"), /produced no verdict/);
});

test("a stage that threw reports its error and session, and long text is clipped unless full", (t) => {
  const long = `plan approval: ${"x".repeat(400)}`;
  const root = checkout({
    r2: [{ runId: "r2", workflow: "build-rpivw" }, { stage: "plan-approval", status: "failed", errMsg: long, session: { file: ".rpiv/workflows/runs/r2/sessions/s.jsonl" } }],
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = stopReport(root, "r2")!;
  assert.equal(r.kind, "error");
  assert.equal(r.stage, "plan-approval");
  assert.match(r.next[0], /Read what the stage did: \.rpiv\/workflows\/runs\/r2\/sessions\/s\.jsonl/);
  assert.match(r.next[1], /\/wf @r2 \(re-runs "plan-approval"/);
  assert.ok(formatStopReport(r).includes("…"));
  assert.ok(formatStopReport(r, { full: true }).includes(long));
});

test("completed, running, and missing runs have no report; latestStoppedRun picks the newest stopped one", (t) => {
  const root = checkout({
    "2026-10-01_00-00-00-aaaa": GATE_STOP,
    "2026-10-02_00-00-00-bbbb": [{ runId: "b" }, { stage: "commit", status: "completed" }],
    "2026-10-03_00-00-00-cccc": [{ runId: "c" }, { type: "routing", fromStage: "plan", decision: "grade" }],
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(stopReport(root, "2026-10-02_00-00-00-bbbb"), undefined);
  assert.equal(stopReport(root, "2026-10-03_00-00-00-cccc"), undefined);
  assert.equal(stopReport(root, "nope"), undefined);
  assert.equal(latestStoppedRun(root), "2026-10-01_00-00-00-aaaa");
  assert.equal(latestStoppedRun(join(root, "elsewhere")), undefined);
});
