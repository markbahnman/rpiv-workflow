// Locate the `bd` binary without relying on the PATH Pi was started with.
//
// Order: $RPIVW_BD, PATH, the usual package-manager folders (Homebrew, ~/.local/bin),
// then mise's install folder. A Pi started where mise isn't activated has no mise shims
// on PATH, and a shim refuses to run without `mise` on PATH ("mise-shim: failed to
// execute mise"); the installed binary under mise/installs runs standalone.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const isWin = process.platform === "win32";
const EXE = isWin ? ["bd.exe", "bd"] : ["bd"];
const MISE_TOOL_DIR = "github-gastownhall-beads";

/** mise's data dir: $MISE_DATA_DIR, else %LOCALAPPDATA%\mise (Windows) or ~/.local/share/mise. */
export function miseDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MISE_DATA_DIR) return env.MISE_DATA_DIR;
  if (isWin) return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "mise");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "mise");
}

/** The beads version pinned in the global mise config, e.g. `"github:gastownhall/beads" = "1.3.1"`. */
export function pinnedBeadsVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const cfg = join(env.MISE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "mise"), "config.toml");
  try {
    const m = readFileSync(cfg, "utf8").match(/["']?github:gastownhall\/beads["']?\s*=\s*["']([^"']+)["']/);
    return m?.[1];
  } catch {
    return undefined;
  }
}

const semverKey = (v: string) => v.split(/[.-]/).map((p) => p.padStart(6, "0")).join(".");

export function onPath(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const d of dirs) for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  return undefined;
}

/**
 * Where package managers put binaries when PATH doesn't include them (a Pi started outside
 * a login shell): Homebrew on Apple Silicon and Intel, then ~/.local/bin.
 */
export const fallbackBinDirs = (home = homedir()) => (isWin ? [] : ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin")]);

/** `names` on PATH, else in the fallback dirs. */
export function findBin(names: string[], env: NodeJS.ProcessEnv = process.env, dirs = fallbackBinDirs()): string | undefined {
  const hit = onPath(env, names);
  if (hit) return hit;
  for (const d of dirs) for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  return undefined;
}

export interface ResolvedBin {
  path: string;
  source: "env" | "path" | "known-dir" | "mise-install";
}

export function resolveBd(env: NodeJS.ProcessEnv = process.env, dirs: string[] = fallbackBinDirs()): ResolvedBin | undefined {
  if (env.RPIVW_BD && existsSync(env.RPIVW_BD)) return { path: env.RPIVW_BD, source: "env" };

  const hit = onPath(env, EXE);
  const norm = (p: string) => (isWin ? p.toLowerCase() : p);
  const isShim =
    hit && (norm(dirname(hit)) === norm(join(miseDataDir(env), "shims")) || /[\\/]mise[\\/]shims[\\/]/i.test(hit));
  if (hit && (!isShim || onPath(env, isWin ? ["mise.exe", "mise"] : ["mise"]))) return { path: hit, source: "path" };
  const known = findBin(EXE, { PATH: "" }, dirs);
  if (known) return { path: known, source: "known-dir" };

  const installs = join(miseDataDir(env), "installs", MISE_TOOL_DIR);
  let versions: string[] = [];
  try {
    versions = readdirSync(installs).filter((v) => /^\d/.test(v));
  } catch {}
  const pinned = pinnedBeadsVersion(env);
  const ordered = [...(pinned && versions.includes(pinned) ? [pinned] : []), ...versions.sort((a, b) => (semverKey(b) > semverKey(a) ? 1 : -1))];
  for (const v of ordered) {
    for (const n of EXE) {
      const p = join(installs, v, n);
      if (existsSync(p)) return { path: p, source: "mise-install" };
    }
  }
  return undefined;
}

let cached: ResolvedBin | undefined | null = null;

/** Resolved once per process. Throws a readable error when bd can't be found. */
export function bdPath(): string {
  if (cached === null) cached = resolveBd();
  if (!cached) throw new Error("can't find bd. Install it with mise (research/06), or set RPIVW_BD to the bd executable.");
  return cached.path;
}

export function bdInfo(): ResolvedBin | undefined {
  if (cached === null) cached = resolveBd();
  return cached;
}
