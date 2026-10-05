// Project identity: a stable "repo-key", so every clone and worktree of the same
// project maps to the same store folder.
//
// Resolution order:
//   1. `rpivw.key` in the repo's local git config: the pin written by /work init.
//      Shared by all worktrees (git config lives in the common dir), and it keeps
//      the key stable when a local project later gets a remote or one is renamed.
//   2. the normalized origin URL (fresh clones of a remote project agree on it)
//   3. the root commit (a local project registered before pinning existed)
// An empty repo with no remote has none of these until /work init pins a generated key.

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { git, gitOut } from "./exec.ts";
import { pathKey } from "./paths.ts";

export const KEY_CONFIG = "rpivw.key";

export interface RepoInfo {
  /** Checkout (or worktree) root. */
  root: string;
  /** Shared .git dir; differs from root/.git inside a worktree. */
  commonDir: string;
  key: string;
  keySource: "pin" | "origin" | "root-commit";
  origin?: string;
}

export type RepoState =
  | { kind: "none" }
  | { kind: "unkeyed"; root: string; commonDir: string; origin?: string }
  | { kind: "ok"; info: RepoInfo };

/**
 * Normalize a git remote URL to a filesystem-safe key:
 *   git@github.com:Owner/Repo.git      → github.com__owner__repo
 *   https://github.com/owner/repo      → github.com__owner__repo
 *   ssh://git@host:2222/group/sub/repo → host__group__sub__repo
 */
export function keyFromRemote(url: string): string | undefined {
  let u = url.trim();
  if (!u) return undefined;
  if (/^[a-z]:[\\/]/i.test(u)) return undefined; // Windows drive path, not scp-style host:path
  let host: string;
  let path: string;
  const scp = u.match(/^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/);
  if (/^[a-z+]+:\/\//i.test(u)) {
    const m = u.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
    if (!m) return undefined;
    [, host, path] = m;
  } else if (scp) {
    [, host, path] = scp;
  } else {
    return undefined;
  }
  path = path.replace(/\.git\/?$/, "").replace(/\/+$/, "");
  const parts = [host, ...path.split("/")].filter(Boolean);
  return parts.map(sanitize).join("__");
}

function sanitize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

const VALID_KEY = /^[a-z0-9._-]+(__[a-z0-9._-]+)*$/;

/** Inspect `cwd`: not a repo, a repo with no key yet, or a keyed repo. */
export async function repoState(cwd: string): Promise<RepoState> {
  const top = await git(cwd, "rev-parse", "--show-toplevel");
  if (top.code !== 0) return { kind: "none" };
  const root = top.stdout.trim();
  const commonDir = await gitOut(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const originRes = await git(root, "config", "--get", "remote.origin.url");
  const origin = originRes.code === 0 ? originRes.stdout.trim() : undefined;

  const pinned = (await git(root, "config", "--local", "--get", KEY_CONFIG)).stdout.trim();
  if (pinned && VALID_KEY.test(pinned)) return { kind: "ok", info: { root, commonDir, key: pinned, keySource: "pin", origin } };

  const fromOrigin = origin ? keyFromRemote(origin) : undefined;
  if (fromOrigin) return { kind: "ok", info: { root, commonDir, key: fromOrigin, keySource: "origin", origin } };

  const rootCommit = await git(root, "rev-list", "--max-parents=0", "HEAD");
  const sha = rootCommit.stdout.trim().split(/\s+/)[0];
  if (sha) return { kind: "ok", info: { root, commonDir, key: `local__${sha.slice(0, 12)}`, keySource: "root-commit", origin } };
  return { kind: "unkeyed", root, commonDir, origin };
}

/** Resolve the keyed repo containing `cwd`, or undefined (not a repo, or no key yet). */
export async function repoInfo(cwd: string): Promise<RepoInfo | undefined> {
  const s = await repoState(cwd);
  return s.kind === "ok" ? s.info : undefined;
}

/** A key for a project with no remote and no commits: `local__<12 hex>`. */
export function generateKey(): string {
  return `local__${randomBytes(6).toString("hex")}`;
}

/** Write the key pin into the repo's local config (not committed; shared by worktrees). */
export async function pinKey(root: string, key: string): Promise<void> {
  await gitOut(root, "config", "--local", KEY_CONFIG, key);
}

/** Why `dir` is a bad place for `git init`, or undefined if it's fine. */
export function unsafeRepoDir(dir: string, store: string, home = homedir()): string | undefined {
  const d = pathKey(dir);
  if (d === pathKey(home)) return "it's your home directory";
  if (dirname(resolve(dir)) === resolve(dir)) return "it's a filesystem root";
  const rel = relative(pathKey(store), d);
  if (!rel.startsWith("..") && !isAbsolute(rel)) return "it's inside the rpivw store";
  return undefined;
}

/** `git init -b main` in `dir`. */
export async function gitInit(dir: string): Promise<void> {
  await gitOut(dir, "init", "-q", "-b", "main");
}
