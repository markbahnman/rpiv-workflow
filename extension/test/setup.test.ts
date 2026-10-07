import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveBd } from "../src/bin.ts";
import { git, gitOut, run } from "../src/exec.ts";
import { doltRemoteUrl, setupStore } from "../src/setup.ts";

test("doltRemoteUrl maps git remotes to Dolt's git+ URLs", () => {
  assert.equal(doltRemoteUrl("git@github.com:me/store.git"), "git+ssh://git@github.com/me/store.git");
  assert.equal(doltRemoteUrl("ssh://git@host:22/me/store.git"), "git+ssh://git@host:22/me/store.git");
  assert.equal(doltRemoteUrl("https://github.com/me/store.git"), "git+https://github.com/me/store.git");
  assert.equal(doltRemoteUrl("git+ssh://git@github.com/me/store.git"), "git+ssh://git@github.com/me/store.git");
  assert.match(doltRemoteUrl(join(tmpdir(), "store.git")), /^git\+file:\/\/\/.*store\.git$/);
});

test("setup refuses a non-empty folder that isn't a git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    writeFileSync(join(dir, "notes.txt"), "mine");
    const r = await setupStore(dir, {}, undefined);
    assert.equal(r.ok, false);
    assert.match(r.lines.at(-1)!, /isn't empty, and isn't a git repo/);
    const bad = await setupStore(join(dir, "s"), { prefix: "Bad-Prefix" }, undefined);
    assert.match(bad.lines.at(-1)!, /prefix/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup without bd still creates a working store and says how to add beads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    const root = join(dir, "store");
    const r = await setupStore(root, {}, undefined);
    assert.ok(r.ok, r.lines.join("\n"));
    for (const f of ["README.md", "config.json", "registry.json", ".gitignore"]) assert.ok(existsSync(join(root, f)), f);
    assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\.beads\/$/m);
    assert.match(await gitOut(root, "log", "--oneline"), /Initialize rpivw store/);
    assert.ok(r.lines.some((l) => /bd not found/.test(l)));
    assert.equal(await gitOut(root, "config", "beads.role"), "maintainer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const bd = resolveBd()?.path;

test("setup with bd: new store, idempotent rerun, then a second machine joins over the remote", { skip: !bd && "bd not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  // bd and dolt keep per-user state under HOME; keep the test away from the real one.
  const home = join(dir, "home");
  mkdirSync(home);
  const isolated: typeof run = (cmd, args, o = {}) =>
    run(cmd, args, { ...o, env: { ...(o.env ?? process.env), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") } });
  try {
    const remote = join(dir, "r.git");
    await gitOut(dir, "init", "-q", "--bare", remote);

    const a = join(dir, "a");
    const first = await setupStore(a, { remote }, bd, isolated);
    assert.ok(first.ok, first.lines.join("\n"));
    assert.ok(first.lines.some((l) => /beads: created a database/.test(l)), first.lines.join("\n"));
    assert.ok(first.lines.some((l) => l.startsWith("pushed to")), first.lines.join("\n"));
    assert.ok(existsSync(join(a, ".beads", "config.yaml")));
    assert.match((await git(a, "rev-parse", "--abbrev-ref", "@{u}")).stdout, /origin\/main/, "upstream set");
    assert.notEqual((await git(a, "ls-remote", "origin", "refs/dolt/data")).stdout.trim(), "", "beads pushed");

    const again = await setupStore(a, {}, bd, isolated);
    assert.ok(again.ok);
    assert.equal(again.changed, false, again.lines.join("\n"));
    assert.ok(again.lines.includes("beads: database exists"));

    const env = { ...process.env, BEADS_DIR: join(a, ".beads"), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") };
    const created = await run(bd!, ["create", "carried over", "--json"], { cwd: a, env });
    assert.equal(created.code, 0, created.stderr);
    const pushed = await run(bd!, ["dolt", "push"], { cwd: a, env });
    assert.equal(pushed.code, 0, pushed.stderr);

    const b = join(dir, "b");
    const joined = await setupStore(b, { remote }, bd, isolated);
    assert.ok(joined.ok, joined.lines.join("\n"));
    assert.ok(joined.lines.some((l) => /^cloned the store/.test(l)), joined.lines.join("\n"));
    assert.ok(joined.lines.some((l) => /restored the database/.test(l)), joined.lines.join("\n"));
    const list = await run(bd!, ["list", "--json"], { cwd: b, env: { ...env, BEADS_DIR: join(b, ".beads") } });
    assert.deepEqual(JSON.parse(list.stdout).map((x: { title: string }) => x.title), ["carried over"]);
    assert.equal(await gitOut(b, "config", "beads.role"), "maintainer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
