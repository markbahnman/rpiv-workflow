import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bead, BeadComment, Beads, RpivMeta } from "../src/beads.ts";
import { parseArgs, type WorkCtx, workBeadStatus, workNew, workNext, workStart } from "../src/work.ts";

function world(initial: Bead[] = []) {
  const beads = new Map(initial.map((b) => [b.id, { ...b }]));
  const calls: string[] = [];
  let n = 0;
  const api: Beads = {
    create: async (p) => {
      const b: Bead = {
        id: p.parent ? `${p.parent}.${++n}` : `rw-n${++n}`,
        title: p.title,
        description: p.description,
        status: "open",
        issue_type: p.type ?? "feature",
        labels: p.labels,
      };
      beads.set(b.id, b);
      calls.push(`create ${b.id} ${JSON.stringify(p)}`);
      return b;
    },
    show: async (id) => {
      const b = beads.get(id);
      if (!b) throw new Error(`bd show failed: no issue found matching "${id}"`);
      return b;
    },
    ready: async (p) => [...beads.values()].filter((b) => b.status === "open" && (p?.labels ?? []).every((l) => b.labels?.includes(l))),
    list: async (p) =>
      [...beads.values()].filter((b) => (!p?.status || b.status === p.status) && (p?.labels ?? []).every((l) => b.labels?.includes(l))),
    claim: async (id) => {
      calls.push(`claim ${id}`);
      beads.get(id)!.status = "in_progress";
    },
    patchRpiv: async (id, f) => {
      const b = beads.get(id)!;
      const next = f({ ...((b.metadata?.rpiv as RpivMeta) ?? {}) });
      b.metadata = { ...b.metadata, rpiv: next };
      return next;
    },
    comment: async (id, text) => void calls.push(`comment ${id} ${text}`),
    comments: async (): Promise<BeadComment[]> => [{ text: "run r1 (ship) stopped: excess", created_at: "2026-10-03T19:08:14Z" }],
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
      calls.push(`gate ${g.id} blocks ${p.blocks}`);
      return g;
    },
    gates: async () => [...beads.values()].filter((b) => b.issue_type === "gate"),
    resolveGate: async (id) => {
      calls.push(`resolve ${id}`);
      beads.get(id)!.status = "closed";
    },
  };
  return { api, beads, calls };
}

const P = "project:local__56a3cecaed79";
const ctxFor = (api: Beads): WorkCtx => ({
  beads: api,
  project: { key: "local__56a3cecaed79", name: "dashboard" },
  projectNames: { local__56a3cecaed79: "dashboard", "github.com__me__site": "site" },
});

test("parseArgs separates flags from free text", () => {
  assert.deepEqual(parseArgs('"Fix it" --type bug --parent rw-1', ["type", "parent"]), {
    flags: { type: "bug", parent: "rw-1" },
    rest: '"Fix it"',
  });
  assert.deepEqual(parseArgs("rw-1 build --force"), { flags: { force: true }, rest: "rw-1 build" });
});

test("/work new labels the bead with the project and strips quotes", async () => {
  const w = world();
  const out = await workNew(ctxFor(w.api), '"Repin iced to master tip" --type chore');
  const b = [...w.beads.values()][0];
  assert.equal(b.title, "Repin iced to master tip");
  assert.equal(b.description, "Repin iced to master tip");
  assert.equal(b.issue_type, "chore");
  assert.deepEqual(b.labels, [P]);
  assert.match(out, /^created rw-n1 \(chore\): Repin iced/);
  assert.match(out, /\/work start rw-n1/);
  await assert.rejects(workNew(ctxFor(w.api), "x --type nope"), /unknown type/);
  await assert.rejects(workNew(ctxFor(w.api), "  "), /usage/);
  await assert.rejects(workNew({ ...ctxFor(w.api), project: undefined }, "x"), /isn't registered/);
});

test("/work next shows this project's work, with --all across projects", async () => {
  const w = world([
    { id: "rw-a", title: "Dash thing", status: "open", issue_type: "feature", labels: [P] },
    { id: "rw-b", title: "Site thing", status: "open", issue_type: "bug", labels: ["project:github.com__me__site"] },
    { id: "rw-c", title: "Dash epic", status: "open", issue_type: "epic", labels: [P] },
    { id: "rw-d", title: "Doing", status: "in_progress", issue_type: "task", labels: [P], metadata: { rpiv: { phase: "plan" } } },
  ]);
  const mine = await workNext(ctxFor(w.api), "");
  assert.match(mine, /in progress \(dashboard\):\n {2}rw-d {2}task \[plan\] {2}Doing/);
  assert.match(mine, /ready \(dashboard\):\n {2}rw-a {2}feature {2}Dash thing/);
  assert.match(mine, /open epics:\n {2}rw-c {2}EPIC {2}Dash epic/);
  assert.doesNotMatch(mine, /Site thing/);
  const all = await workNext(ctxFor(w.api), "--all");
  assert.match(all, /site {2}rw-b {2}bug {2}Site thing/);
});

test("/work start claims the bead and builds a named /wf command", async () => {
  const w = world([
    { id: "rw-5b3.1", title: "Repin iced", description: "Repin iced\n  to the master tip", status: "open", issue_type: "chore", labels: [P] },
  ]);
  const plan = await workStart(ctxFor(w.api), "rw-5b3.1", { "rw-5b3_1--r1": "old-run" });
  assert.equal(plan.runName, "rw-5b3_1--r2");
  assert.equal(plan.workflow, "ship-rpivw");
  assert.equal(plan.command, "/wf ship-rpivw Repin iced to the master tip --name rw-5b3_1--r2");
  assert.deepEqual(w.calls, ["claim rw-5b3.1"]);
  // The first start claimed it; a second plain start is refused with a resume hint.
  w.beads.get("rw-5b3.1")!.metadata = { rpiv: { runs: ["2026-10-04_09-00-00-aaaa"] } };
  await assert.rejects(workStart(ctxFor(w.api), "rw-5b3.1 build", {}), /already in progress\. Resume its run with \/wf @2026-10-04_09-00-00-aaaa/);
  const build = await workStart(ctxFor(w.api), "rw-5b3.1 build --force", {});
  assert.equal(build.command.startsWith("/wf build-rpivw "), true);
});

test("/work start refuses other projects, epics, and closed beads unless forced", async () => {
  const w = world([
    { id: "rw-x", title: "Site", status: "open", issue_type: "bug", labels: ["project:github.com__me__site"] },
    { id: "rw-e", title: "Epic", status: "open", issue_type: "epic", labels: [P] },
    { id: "rw-z", title: "Done", status: "closed", issue_type: "task", labels: [P] },
    { id: "rw-at", title: "@x", description: "@2026 looks like a resume ref", status: "open", issue_type: "task", labels: [P] },
  ]);
  const c = ctxFor(w.api);
  await assert.rejects(workStart(c, "rw-x", {}), /belongs to site, not dashboard/);
  await assert.rejects(workStart(c, "rw-e", {}), /is an epic/);
  await assert.rejects(workStart(c, "rw-z", {}), /is closed/);
  await assert.rejects(workStart(c, "", {}), /usage/);
  assert.equal(w.calls.length, 0, "nothing claimed on refusal");
  assert.ok((await workStart(c, "rw-x --force", {})).command.includes("--name rw-x--r1"));
  assert.match((await workStart(c, "rw-at", {})).command, /^\/wf ship-rpivw Task: @2026/);
});

test("/work status <bead> shows phase, runs, artifacts, and notes", async () => {
  const w = world([
    {
      id: "rw-5b3",
      title: "Repin iced",
      status: "in_progress",
      issue_type: "chore",
      labels: [P],
      metadata: { rpiv: { workflow: "ship", phase: "validate", runs: ["r1", "r2"], artifacts: { plans: "plans/p.md" } } },
    },
  ]);
  const out = await workBeadStatus(ctxFor(w.api), "rw-5b3");
  assert.match(out, /^rw-5b3 {2}chore {2}in_progress {2}Repin iced/);
  assert.match(out, /project: dashboard/);
  assert.match(out, /workflow: ship {3}phase: validate/);
  assert.match(out, /runs: r1, r2/);
  assert.match(out, /plans {8}plans\/p\.md/);
  assert.match(out, /2026-10-03 19:08 {2}run r1 \(ship\) stopped: excess/);
});
