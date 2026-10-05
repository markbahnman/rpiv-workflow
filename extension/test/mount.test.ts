import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureLocalExclude, ensureMount, linkPath, migrateAndMount } from "../src/mount.ts";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  const checkout = join(dir, "checkout");
  const target = join(dir, "store", "projects", "k", "artifacts");
  mkdirSync(checkout, { recursive: true });
  return { dir, checkout, target, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("ensureMount creates a link, then reports ok; writes land in the store", () => {
  const s = sandbox();
  try {
    assert.deepEqual(ensureMount(s.checkout, s.target), { state: "created" });
    assert.ok(lstatSync(linkPath(s.checkout)).isSymbolicLink());
    assert.deepEqual(ensureMount(s.checkout, s.target), { state: "ok" });
    mkdirSync(join(linkPath(s.checkout), "plans"));
    writeFileSync(join(linkPath(s.checkout), "plans", "p.md"), "plan");
    assert.equal(readFileSync(join(s.target, "plans", "p.md"), "utf8"), "plan");
  } finally {
    s.done();
  }
});

test("ensureMount replaces an empty real folder but never a non-empty one", () => {
  const s = sandbox();
  try {
    mkdirSync(linkPath(s.checkout), { recursive: true });
    assert.deepEqual(ensureMount(s.checkout, s.target), { state: "created" });

    const t = sandbox();
    mkdirSync(join(linkPath(t.checkout), "research"), { recursive: true });
    writeFileSync(join(linkPath(t.checkout), "research", "r.md"), "r");
    assert.deepEqual(ensureMount(t.checkout, t.target), { state: "conflict", entries: 1 });
    assert.ok(existsSync(join(linkPath(t.checkout), "research", "r.md")), "content untouched");
    t.done();
  } finally {
    s.done();
  }
});

test("ensureMount reports a link that points elsewhere", () => {
  const s = sandbox();
  try {
    const other = join(s.dir, "other");
    mkdirSync(other);
    mkdirSync(join(s.checkout, ".rpiv"));
    symlinkSync(other, linkPath(s.checkout), process.platform === "win32" ? "junction" : "dir");
    assert.equal(ensureMount(s.checkout, s.target).state, "mismatch");
  } finally {
    s.done();
  }
});

test("migrateAndMount moves existing artifacts into the store", () => {
  const s = sandbox();
  try {
    mkdirSync(join(linkPath(s.checkout), "plans"), { recursive: true });
    writeFileSync(join(linkPath(s.checkout), "plans", "p.md"), "plan");
    assert.deepEqual(migrateAndMount(s.checkout, s.target), { moved: 1 });
    assert.ok(lstatSync(linkPath(s.checkout)).isSymbolicLink());
    assert.equal(readFileSync(join(s.target, "plans", "p.md"), "utf8"), "plan");
  } finally {
    s.done();
  }
});

test("migrateAndMount refuses to overwrite store files", () => {
  const s = sandbox();
  try {
    mkdirSync(join(linkPath(s.checkout), "plans"), { recursive: true });
    writeFileSync(join(linkPath(s.checkout), "plans", "p.md"), "local");
    mkdirSync(join(s.target, "plans"), { recursive: true });
    writeFileSync(join(s.target, "plans", "p.md"), "store");
    assert.throws(() => migrateAndMount(s.checkout, s.target), /refusing to migrate/);
    assert.equal(readFileSync(join(s.target, "plans", "p.md"), "utf8"), "store");
    assert.equal(readFileSync(join(linkPath(s.checkout), "plans", "p.md"), "utf8"), "local");
  } finally {
    s.done();
  }
});

test("removing the link (as git clean would) leaves store content intact", () => {
  const s = sandbox();
  try {
    ensureMount(s.checkout, s.target);
    writeFileSync(join(linkPath(s.checkout), "keep.md"), "x");
    rmSync(join(s.checkout, ".rpiv"), { recursive: true, force: true });
    assert.equal(readFileSync(join(s.target, "keep.md"), "utf8"), "x");
    assert.deepEqual(ensureMount(s.checkout, s.target), { state: "created" });
  } finally {
    s.done();
  }
});

test("ensureLocalExclude appends once", () => {
  const s = sandbox();
  try {
    const common = join(s.dir, ".git");
    assert.equal(ensureLocalExclude(common), true);
    assert.equal(ensureLocalExclude(common), false);
    assert.match(readFileSync(join(common, "info", "exclude"), "utf8"), /^\.rpiv\/$/m);
  } finally {
    s.done();
  }
});
