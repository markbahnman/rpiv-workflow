import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { findBin, pinnedBeadsVersion, resolveBd } from "../src/bin.ts";
import { canonicalPath, pathKey, samePath } from "../src/paths.ts";

const exe = process.platform === "win32" ? "bd.exe" : "bd";
const miseExe = process.platform === "win32" ? "mise.exe" : "mise";

function layout() {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  const data = join(dir, "mise-data");
  const cfg = join(dir, "mise-cfg");
  const shims = join(data, "shims");
  const touch = (p: string) => {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "");
  };
  touch(join(shims, exe));
  touch(join(data, "installs", "github-gastownhall-beads", "1.3.1", exe));
  touch(join(data, "installs", "github-gastownhall-beads", "1.10.0", exe));
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "config.toml"), '[tools]\n"github:gastownhall/beads" = "1.3.1"\n"github:dolthub/dolt" = "2.2.0"\n');
  const env = { PATH: shims, MISE_DATA_DIR: data, MISE_CONFIG_DIR: cfg } as NodeJS.ProcessEnv;
  return { dir, data, shims, env, touch, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("pinnedBeadsVersion reads the mise config pin", () => {
  const l = layout();
  try {
    assert.equal(pinnedBeadsVersion(l.env), "1.3.1");
  } finally {
    l.done();
  }
});

test("a mise shim without mise on PATH is skipped for the pinned install", () => {
  const l = layout();
  try {
    const r = resolveBd(l.env, []);
    assert.equal(r?.source, "mise-install");
    assert.equal(r?.path, join(l.data, "installs", "github-gastownhall-beads", "1.3.1", exe), "pin wins over newer 1.10.0");
  } finally {
    l.done();
  }
});

test("the shim is used when mise itself is on PATH", () => {
  const l = layout();
  try {
    const bin = join(l.dir, "mise-bin");
    l.touch(join(bin, miseExe));
    const r = resolveBd({ ...l.env, PATH: [l.shims, bin].join(delimiter) }, []);
    assert.deepEqual(r, { path: join(l.shims, exe), source: "path" });
  } finally {
    l.done();
  }
});

test("RPIVW_BD overrides everything; nothing found returns undefined", () => {
  const l = layout();
  try {
    const custom = join(l.dir, "custom", exe);
    l.touch(custom);
    assert.deepEqual(resolveBd({ ...l.env, RPIVW_BD: custom }, []), { path: custom, source: "env" });
    assert.equal(resolveBd({ PATH: "", MISE_DATA_DIR: join(l.dir, "none"), MISE_CONFIG_DIR: join(l.dir, "none") }, []), undefined);
  } finally {
    l.done();
  }
});

test("findBin falls back to package-manager folders when PATH lacks the tool (Homebrew on macOS)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    const brew = join(dir, "opt", "homebrew", "bin");
    mkdirSync(brew, { recursive: true });
    writeFileSync(join(brew, exe), "");
    assert.equal(findBin([exe], { PATH: "" }, []), undefined);
    assert.equal(findBin([exe], { PATH: "" }, [join(dir, "nope"), brew]), join(brew, exe));
    assert.deepEqual(resolveBd({ PATH: "", MISE_DATA_DIR: join(dir, "none"), MISE_CONFIG_DIR: join(dir, "none") }, [brew]), {
      path: join(brew, exe),
      source: "known-dir",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("path identity: symlinks resolve, case folds on case-insensitive platforms", () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  try {
    const real = join(dir, "Real");
    mkdirSync(real);
    const link = join(dir, "link");
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    assert.ok(samePath(link, real), "a link and its target are the same path");
    assert.equal(canonicalPath(link), canonicalPath(real));
    assert.ok(samePath(join(dir, "nope", ".."), dir), "non-existent segments still resolve");
    assert.equal(pathKey(real, true), canonicalPath(real).toLowerCase());
    assert.equal(pathKey(real, false), canonicalPath(real));
    if (process.platform === "win32" || process.platform === "darwin") assert.ok(samePath(join(dir, "real"), real), "case-insensitive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
