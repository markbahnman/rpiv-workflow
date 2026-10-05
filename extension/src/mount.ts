// Mount the store into a checkout: <checkout>/.rpiv/artifacts → store/projects/<key>/artifacts.
// A directory junction on Windows (no admin needed), a dir symlink elsewhere.

import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import { samePath } from "./paths.ts";

export type MountState =
  | { state: "created" }
  | { state: "ok" }
  | { state: "mismatch"; actual: string }
  | { state: "conflict"; entries: number };

export const linkPath = (checkoutRoot: string) => join(checkoutRoot, ".rpiv", "artifacts");


function makeLink(target: string, link: string): void {
  mkdirSync(join(link, ".."), { recursive: true });
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

/**
 * Ensure the mount exists. Never deletes or overwrites real content: a non-empty
 * real directory is reported as a conflict (use `migrateAndMount`), and a link
 * pointing somewhere else is reported as a mismatch.
 */
export function ensureMount(checkoutRoot: string, target: string): MountState {
  mkdirSync(target, { recursive: true });
  const link = linkPath(checkoutRoot);
  let st;
  try {
    st = lstatSync(link);
  } catch {
    makeLink(target, link);
    return { state: "created" };
  }
  if (st.isSymbolicLink()) {
    const actual = readlinkSync(link);
    return samePath(actual, target) ? { state: "ok" } : { state: "mismatch", actual };
  }
  if (st.isDirectory()) {
    const entries = readdirSync(link).length;
    if (entries > 0) return { state: "conflict", entries };
    rmdirSync(link);
    makeLink(target, link);
    return { state: "created" };
  }
  return { state: "conflict", entries: 1 };
}

/** List files under `dir` relative to it (used to detect collisions before migrating). */
function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
}

/**
 * Move an existing local `.rpiv/artifacts/` into the store, then mount.
 * Refuses (throws) if any file would overwrite one already in the store.
 */
export function migrateAndMount(checkoutRoot: string, target: string): { moved: number } {
  const link = linkPath(checkoutRoot);
  const st = lstatSync(link);
  if (st.isSymbolicLink()) throw new Error(`${link} is already a link; nothing to migrate`);
  mkdirSync(target, { recursive: true });
  const files = walk(link);
  const collisions = files.filter((f) => existsSync(join(target, f)));
  if (collisions.length) {
    throw new Error(`refusing to migrate: ${collisions.length} file(s) already exist in the store, e.g. ${collisions[0]}`);
  }
  // Collisions were rejected above; force:false is a second guard against overwriting.
  cpSync(link, target, { recursive: true, force: false });
  rmSync(link, { recursive: true, force: true });
  makeLink(target, link);
  return { moved: files.length };
}

/**
 * Make sure git ignores `.rpiv/` in this checkout. Uses the repo-local
 * `info/exclude` (never committed), so nothing in the project changes.
 * Returns true if an entry was added.
 */
export function ensureLocalExclude(commonDir: string): boolean {
  const file = join(commonDir, "info", "exclude");
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  if (/^\/?\.rpiv\/?\s*$/m.test(text)) return false;
  mkdirSync(join(commonDir, "info"), { recursive: true });
  appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}# rpivw: local workflow artifacts (store junction)\n.rpiv/\n`);
  return true;
}
