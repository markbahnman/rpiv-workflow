import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bead } from "../src/beads.ts";
import { completeWork, matchBeads } from "../src/complete.ts";

const B = (id: string, title: string, issue_type = "feature", status = "open", phase?: string): Bead => ({
  id,
  title,
  issue_type,
  status,
  ...(phase ? { metadata: { rpiv: { phase } } } : {}),
});

const beads = [
  B("rw-5b3", "Repin iced to master tip", "chore", "in_progress", "plan"),
  B("rw-5b9", "Dark mode toggle"),
  B("rw-a1c", "Offline sync", "epic"),
  B("rw-z00", "Old work", "task", "closed"),
  B("rw-g01", "Plan approval: x", "gate"),
];
const values = (items: { value: string }[]) => items.map((i) => i.value);

test("subcommands complete from an empty or partial first word, with a trailing space", () => {
  assert.deepEqual(values(completeWork("", undefined)), ["new ", "next ", "start ", "status ", "review ", "approve ", "reject ", "init ", "mount ", "sync ", "setup "]);
  assert.deepEqual(values(completeWork("st", undefined)), ["start ", "status "]);
  assert.deepEqual(values(completeWork("n", undefined)), ["new ", "next "]);
  assert.match(completeWork("sy", undefined)[0].description!, /push the store/);
});

test("status <Tab> lists every bead except gates; a partial id narrows it", () => {
  assert.deepEqual(values(completeWork("status ", beads)), ["status rw-5b3", "status rw-5b9", "status rw-a1c", "status rw-z00"]);
  assert.deepEqual(values(completeWork("status rw-5", beads)), ["status rw-5b3", "status rw-5b9"]);
  assert.deepEqual(values(completeWork("status RW-5B3", beads)), ["status rw-5b3"], "case-insensitive");
  const item = completeWork("status rw-5b3", beads)[0];
  assert.equal(item.label, "rw-5b3");
  assert.equal(item.description, "chore · in_progress · plan · Repin iced to master tip");
});

test("a partial that isn't an id prefix matches titles", () => {
  assert.deepEqual(values(completeWork("status dark", beads)), ["status rw-5b9"]);
  assert.deepEqual(matchBeads(beads, "sync").map((b) => b.id), ["rw-a1c"]);
});

test("start offers only startable beads, then workflows, then --force", () => {
  assert.deepEqual(values(completeWork("start ", beads)), ["start rw-5b9 "], "no in-progress, epics, closed, or gates");
  assert.deepEqual(values(completeWork("status ", beads)).length, 4, "status still lists in-progress beads");
  assert.deepEqual(values(completeWork("start rw-5b9 ", beads)), ["start rw-5b9 ship ", "start rw-5b9 build ", "start rw-5b9 vet ", "start rw-5b9 polish "]);
  assert.deepEqual(values(completeWork("start rw-5b9 b", beads)), ["start rw-5b9 build "]);
  assert.deepEqual(values(completeWork("start rw-5b9 build --f", beads)), ["start rw-5b9 build --force"]);
});

test("new completes --type values and --parent beads (epics first)", () => {
  assert.deepEqual(values(completeWork('new "Fix it" --', beads)), ['new "Fix it" --type ', 'new "Fix it" --parent ']);
  assert.deepEqual(values(completeWork('new "Fix it" --type b', beads)), ['new "Fix it" --type bug ']);
  assert.deepEqual(values(completeWork('new "Fix it" --parent ', beads)).slice(0, 2), ['new "Fix it" --parent rw-a1c ', 'new "Fix it" --parent rw-5b3 ']);
  assert.deepEqual(values(completeWork('new "Fix it"', beads)), [], "no suggestions inside the brief");
});

test("next and init complete their flags; unknown input yields nothing", () => {
  assert.deepEqual(values(completeWork("next ", undefined)), ["next --all"]);
  assert.deepEqual(values(completeWork("init --", undefined)), ["init --git ", "init --migrate "]);
  assert.deepEqual(values(completeWork("init my-name", undefined)), []);
  assert.deepEqual(values(completeWork("status ", undefined)), [], "no beads available → no bead items");
  assert.deepEqual(values(completeWork("bogus x", beads)), []);
});

test("approve/reject complete open gate ids", () => {
  const gates = [
    { id: "rw-g1", title: "Plan approval: CSV export", status: "open", issue_type: "gate" },
    { id: "rw-g2", title: "Plan approval: old", status: "closed", issue_type: "gate" },
  ];
  assert.deepEqual(values(completeWork("approve ", beads, gates)), ["approve rw-g1 "]);
  assert.deepEqual(values(completeWork("rej", beads, gates)), ["reject "]);
  assert.deepEqual(values(completeWork("review ", beads, gates)), ["review rw-g1 "]);
  assert.deepEqual(values(completeWork("reject rw-g", beads, gates)), ["reject rw-g1 "]);
  assert.deepEqual(values(completeWork("approve rw-g1 looks", beads, gates)), [], "no completion inside notes");
});
