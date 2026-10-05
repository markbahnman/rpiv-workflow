import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyStamp, newArtifactId, readStampId, stampFile } from "../src/stamp.ts";

const PLAN = `---
date: 2026-10-04T10:00:00-0800
status: ready
phases:
  - { n: 1, title: "A", files: [a.ts], depends_on: [] }
---

# Plan

Body with --- inside a line, and
---
a horizontal rule.
`;

test("newArtifactId is a sortable ULID with the art_ prefix", () => {
  const a = newArtifactId(1_700_000_000_000);
  const b = newArtifactId(1_700_000_000_001);
  assert.match(a, /^art_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(a.slice(0, 14) < b.slice(0, 14), "time prefix sorts");
});

test("applyStamp adds one rpivw block and leaves rpiv's keys and the body alone", () => {
  const out = applyStamp(PLAN, { id: "art_X", work: "rw-5b3", run: "r1", workflow: "build-gated" })!;
  assert.match(out, /^---\ndate: 2026-10-04T10:00:00-0800\nstatus: ready\nphases:\n {2}- \{ n: 1/);
  assert.match(out, /\nrpivw:\n {2}id: art_X\n {2}work: rw-5b3\n {2}run: r1\n {2}workflow: build-gated\n---\n\n# Plan/);
  assert.ok(out.endsWith("Body with --- inside a line, and\n---\na horizontal rule.\n"), "body untouched, including later --- lines");
  assert.equal(readStampId(out), "art_X");

  const again = applyStamp(out, { id: "art_X", work: "rw-5b3", run: "r2", workflow: "build-gated" })!;
  assert.equal((again.match(/^rpivw:$/gm) ?? []).length, 1, "re-stamping replaces the block");
  assert.match(again, / {2}run: r2/);
  assert.equal(applyStamp("# no front matter\n", { id: "x", run: "r", workflow: "w" }), undefined);
});

test("CRLF documents keep CRLF", () => {
  const crlf = PLAN.replace(/\n/g, "\r\n");
  const out = applyStamp(crlf, { id: "art_X", run: "r1", workflow: "ship" })!;
  assert.ok(!/[^\r]\n/.test(out), "no bare LF introduced");
  assert.equal(readStampId(out), "art_X");
});

test("stampFile keeps an existing id, recovers a dropped one, and skips non-front-matter files", () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    const f = join(dir, "p.md");
    writeFileSync(f, PLAN);
    const id1 = stampFile(f, { work: "rw-1", run: "r1", workflow: "ship" })!;
    assert.equal(stampFile(f, { work: "rw-1", run: "r2", workflow: "ship" }), id1, "id is stable across stages");

    writeFileSync(f, PLAN); // revise rewrote the plan and dropped the block
    assert.equal(stampFile(f, { run: "r3", workflow: "ship" }, () => id1), id1, "recovered from history");
    assert.match(readFileSync(f, "utf8"), / {2}run: r3/);

    const j = join(dir, "v.md");
    writeFileSync(j, "no front matter");
    assert.equal(stampFile(j, { run: "r", workflow: "w" }), undefined);
    assert.equal(readFileSync(j, "utf8"), "no front matter");
    assert.equal(stampFile(join(dir, "missing.md"), { run: "r", workflow: "w" }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the bridge stamps markdown artifacts before committing, and recovers a dropped id from the store", async () => {
  const { gitOut } = await import("../src/exec.ts");
  const { createListeners } = await import("../src/lifecycle.ts");
  const { openStore } = await import("../src/store.ts");
  const { mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    const store = join(dir, "store");
    const artifacts = join(store, "projects", "k", "artifacts");
    mkdirSync(join(artifacts, "plans"), { recursive: true });
    await gitOut(store, "init", "-q", "-b", "main");
    await gitOut(store, "config", "user.name", "t");
    await gitOut(store, "config", "user.email", "t@t");
    const l = createListeners({
      store: openStore(store),
      resolve: async () => ({ key: "k", root: join(dir, "co"), artifacts }),
      pushOnEnd: () => false,
      notify: (m) => assert.fail(m),
    });
    const plan = join(artifacts, "plans", "p.md");
    const out = { kind: "artifact-md", artifacts: [{ handle: { kind: "fs", path: ".rpiv/artifacts/plans/p.md" } }] };
    const ctx = (runId: string) => ({ cwd: "/co", runId, workflow: "build-gated", totalStages: 9, trigger: { kind: "external" as const, source: "t", ref: "rw-5b3" } });

    writeFileSync(plan, PLAN);
    await l.onStageEnd!({ kind: "skill", name: "plan", stageNumber: 4 }, out, ctx("r1"));
    const committed = await gitOut(store, "show", "HEAD:projects/k/artifacts/plans/p.md");
    const id = readStampId(committed)!;
    assert.match(id, /^art_/);
    assert.match(committed, / {2}work: rw-5b3\n {2}run: r1\n {2}workflow: build-gated/);

    writeFileSync(plan, PLAN.replace("status: ready", "status: in-review")); // revise dropped the block
    await l.onStageEnd!({ kind: "skill", name: "revise", stageNumber: 5 }, out, ctx("r2"));
    const after = await gitOut(store, "show", "HEAD:projects/k/artifacts/plans/p.md");
    assert.equal(readStampId(after), id, "same id after the rewrite");
    assert.match(after, /status: in-review/);
    assert.match(after, / {2}run: r2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
