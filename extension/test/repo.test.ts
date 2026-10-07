import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitOut } from "../src/exec.ts";
import { defaultName, readRegistry, type Registry, register, writeRegistry } from "../src/registry.ts";
import { generateKey, gitInit, keyFromRemote, pinKey, repoInfo, repoState, unsafeRepoDir } from "../src/repo.ts";

test("keyFromRemote normalizes common URL shapes", () => {
  const cases: [string, string | undefined][] = [
    ["git@github.com:example-user/rpivw-store.git", "github.com__example-user__rpivw-store"],
    ["git@github.com:Example-User/Dashboard", "github.com__example-user__dashboard"],
    ["https://github.com/owner/repo.git", "github.com__owner__repo"],
    ["https://user:tok@github.com/owner/repo/", "github.com__owner__repo"],
    ["ssh://git@gitlab.example.com:2222/group/sub/repo.git", "gitlab.example.com__group__sub__repo"],
    ["git+ssh://git@github.com/owner/repo.git", "github.com__owner__repo"],
    ["C:/local/path/repo.git", undefined],
    ["C:\\local\\repo", undefined],
    ["", undefined],
  ];
  for (const [url, want] of cases) assert.equal(keyFromRemote(url), want, url);
});

test("defaultName takes the last key segment, or the folder for local keys", () => {
  assert.equal(defaultName("github.com__me__dashboard"), "dashboard");
  assert.equal(defaultName("local__56a3cecaed79", "C:\\Users\\me\\dashboard"), "dashboard");
  assert.equal(defaultName("local__56a3cecaed79", "/home/me/ws/"), "ws");
  assert.equal(defaultName("local__56a3cecaed79"), "56a3cecaed79");
});

test("register adds projects and new checkout paths idempotently", () => {
  const reg: Registry = { version: 1, projects: {} };
  assert.equal(register(reg, "k", "dash", "/a"), true);
  assert.equal(register(reg, "k", "dash", "/a"), false);
  assert.equal(register(reg, "k", "dash", "/b"), true);
  assert.equal(reg.projects["k"].paths.length, 2);
  assert.equal(register(reg, "k", "renamed", "/a"), false, "no rename unless asked");
  assert.equal(register(reg, "k", "renamed", "/a", { rename: true }), true);
  assert.equal(reg.projects["k"].name, "renamed");
});

test("registry round-trips through registry.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    assert.deepEqual(readRegistry(dir).projects, {});
    const reg = readRegistry(dir);
    register(reg, "k", "n", dir);
    writeRegistry(dir, reg);
    assert.equal(readRegistry(dir).projects["k"].name, "n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repoInfo keys by origin, falls back to the root commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    await gitOut(dir, "init", "-q", "-b", "main");
    assert.equal(await repoInfo(dir), undefined, "no commits yet → no key");
    writeFileSync(join(dir, "a.txt"), "a");
    await gitOut(dir, "add", ".");
    await gitOut(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    const local = await repoInfo(dir);
    assert.match(local!.key, /^local__[0-9a-f]{12}$/);
    await gitOut(dir, "remote", "add", "origin", "git@github.com:me/dash.git");
    assert.equal((await repoInfo(dir))!.key, "github.com__me__dash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repoState: none → unkeyed → pinned; the pin beats a later origin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    assert.equal((await repoState(dir)).kind, "none");
    await gitInit(dir);
    const s = await repoState(dir);
    assert.equal(s.kind, "unkeyed");
    const key = generateKey();
    assert.match(key, /^local__[0-9a-f]{12}$/);
    await pinKey(dir, key);
    assert.deepEqual(
      { key: (await repoInfo(dir))!.key, source: (await repoInfo(dir))!.keySource },
      { key, source: "pin" },
    );
    await gitOut(dir, "remote", "add", "origin", "git@github.com:me/new-site.git");
    assert.equal((await repoInfo(dir))!.key, key, "adding a remote later doesn't move the project");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsafeRepoDir refuses home, filesystem roots, and the store", () => {
  const home = join(tmpdir(), "home-x");
  const store = join(tmpdir(), "store-x");
  assert.match(unsafeRepoDir(home, store, home)!, /home directory/);
  assert.match(unsafeRepoDir(process.platform === "win32" ? "C:\\" : "/", store, home)!, /filesystem root/);
  assert.match(unsafeRepoDir(store, store, home)!, /inside the rpivw store/);
  assert.match(unsafeRepoDir(join(store, "projects", "x"), store, home)!, /inside the rpivw store/);
  assert.equal(unsafeRepoDir(join(home, "Projects", "site"), store, home), undefined);
});
