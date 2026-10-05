import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { piAgentDir } from "../src/config.ts";
import { gitOut } from "../src/exec.ts";
import { absPlan, detectReviewTools, planDiffCommand, requestPlanGateReview, reviewLines, storePlanPath } from "../src/review.ts";

test("storePlanPath maps a gate's plan path into the store", () => {
  const store = join("C:", "Users", "me", "rpivw");
  const artifacts = join(store, "projects", "k", "artifacts");
  assert.equal(storePlanPath(artifacts, store, ".rpiv/artifacts/plans/p.md"), "projects/k/artifacts/plans/p.md");
  assert.equal(storePlanPath(artifacts, store, "C:\\co\\.rpiv\\artifacts\\plans\\p.md"), "projects/k/artifacts/plans/p.md");
  assert.equal(storePlanPath(artifacts, store, "the plan"), undefined);
});

test("reviewLines: plannotator first, a file link always, hunk only with a diff", () => {
  const plan = absPlan(join(tmpdir(), "co"), ".rpiv/artifacts/plans/p.md");
  const base = { gateId: "rw-g1", plan, storeRoot: "/s" };
  const diff = { command: "hunk diff -- x.md", what: "uncommitted edits" };
  const all = reviewLines({ ...base, tools: { plannotator: true, hunk: true }, diff });
  assert.match(all[0], /^review: \/work review rw-g1 .*Approve resolves this gate/);
  assert.match(all[1], /^open: file:\/\/\/.*\/\.rpiv\/artifacts\/plans\/p\.md$/);
  assert.equal(all[2], "changes (uncommitted edits): cd /s && hunk diff -- x.md");
  assert.deepEqual(
    reviewLines({ ...base, tools: { plannotator: false, hunk: true } }).map((l) => l.split(":")[0]),
    ["open"],
  );
  assert.equal(reviewLines({ ...base, tools: { plannotator: false, hunk: false }, diff }).length, 1);
  const spaced = reviewLines({ ...base, storeRoot: "/Users/me/My Store", tools: { plannotator: false, hunk: true }, diff });
  assert.equal(spaced[1], "changes (uncommitted edits): cd '/Users/me/My Store' && hunk diff -- x.md");
});

test("planDiffCommand: nothing for one version, working-tree edits, then first draft → latest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    await gitOut(dir, "init", "-q");
    await gitOut(dir, "config", "user.email", "t@t");
    await gitOut(dir, "config", "user.name", "t");
    const rel = "projects/k/artifacts/plans/p.md";
    mkdirSync(join(dir, "projects", "k", "artifacts", "plans"), { recursive: true });
    writeFileSync(join(dir, rel), "v1\n");
    assert.equal(await planDiffCommand(dir, rel), undefined, "untracked");
    await gitOut(dir, "add", "-A");
    await gitOut(dir, "commit", "-qm", "v1");
    assert.equal(await planDiffCommand(dir, rel), undefined, "one version");
    const first = (await gitOut(dir, "rev-parse", "--short", "HEAD")).trim();
    writeFileSync(join(dir, rel), "v2\n");
    assert.deepEqual(await planDiffCommand(dir, rel), { command: `hunk diff -- ${rel}`, what: "uncommitted edits" });
    await gitOut(dir, "commit", "-qam", "v2");
    writeFileSync(join(dir, rel), "v3\n");
    await gitOut(dir, "commit", "-qam", "v3");
    const last = (await gitOut(dir, "rev-parse", "--short", "HEAD")).trim();
    assert.deepEqual(await planDiffCommand(dir, rel), { command: `hunk diff ${first} ${last} -- ${rel}`, what: "first draft → now, 3 versions" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requestPlanGateReview sends plannotator an annotate request in review-gate mode", async () => {
  const sent: { channel: string; data: any }[] = [];
  const events = { emit: (channel: string, data: unknown) => void sent.push({ channel, data }) };
  const pending = requestPlanGateReview(events, "C:/co/plan.md", "# Plan");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "plannotator:request");
  assert.equal(sent[0].data.action, "annotate");
  assert.deepEqual(sent[0].data.payload, { filePath: "C:/co/plan.md", markdown: "# Plan", mode: "annotate", gate: true });
  assert.match(sent[0].data.requestId, /^rpivw-/);
  sent[0].data.respond({ status: "handled", result: { feedback: "", approved: true } });
  assert.deepEqual(await pending, { status: "handled", result: { feedback: "", approved: true } });
});

test("piAgentDir follows PI_CODING_AGENT_DIR like Pi, else ~/.pi/agent", () => {
  assert.equal(piAgentDir({}), join(homedir(), ".pi", "agent"));
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "~/work-pi" }), join(homedir(), "work-pi"));
  const abs = join(tmpdir(), "pi-agent");
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: abs }), abs);
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "  " }), join(homedir(), ".pi", "agent"));
});

test("detectReviewTools reads Pi's packages and finds hunk on PATH or in mise", () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    const agent = join(dir, "agent");
    mkdirSync(agent);
    const env = { PATH: "", MISE_DATA_DIR: join(dir, "mise") };
    assert.deepEqual(detectReviewTools(env, agent, []), { plannotator: false, hunk: false });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: ["npm:x", { source: "npm:@plannotator/pi-extension" }] }));
    mkdirSync(join(dir, "mise", "installs", "hunk", "0.22.0"), { recursive: true });
    assert.deepEqual(detectReviewTools(env, agent, []), { plannotator: true, hunk: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
