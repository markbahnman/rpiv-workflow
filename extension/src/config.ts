// Store location and settings.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StoreConfig {
  version: number;
  gates: { planApproval: string[]; beforeCommit: string[] };
  deviations: { minor: "notify" | "log"; major: "gate" | "notify" | "log" };
  /** remote: the store remote to push to (default origin). A store without it is local-only and never pushes. */
  push: { onWorkflowEnd: boolean; remote: string };
}

export const DEFAULT_CONFIG: StoreConfig = {
  version: 1,
  gates: { planApproval: ["build"], beforeCommit: [] },
  deviations: { minor: "notify", major: "gate" },
  push: { onWorkflowEnd: true, remote: "origin" },
};

/** `$RPIVW_STORE` if set, else `~/rpivw`. Kept short on purpose: Dolt/git fail on deep Windows paths. */
export function storeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.RPIVW_STORE?.trim() || join(homedir(), "rpivw");
}

/** Pi's agent dir, resolved like Pi's own getAgentDir: `$PI_CODING_AGENT_DIR` (a leading `~` expands), else `~/.pi/agent`. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR?.trim();
  if (!dir) return join(homedir(), ".pi", "agent");
  return dir === "~" ? homedir() : dir.startsWith("~/") || dir.startsWith("~\\") ? join(homedir(), dir.slice(2)) : dir;
}

export function projectDir(store: string, key: string): string {
  return join(store, "projects", key);
}

export function artifactsDir(store: string, key: string): string {
  return join(projectDir(store, key), "artifacts");
}

/** Global config merged over defaults, then per-project overrides on top. */
export function loadConfig(store: string, key?: string): StoreConfig {
  const read = (p: string): Partial<StoreConfig> => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return {};
    }
  };
  const merge = (a: StoreConfig, b: Partial<StoreConfig>): StoreConfig => ({
    version: b.version ?? a.version,
    gates: { ...a.gates, ...b.gates },
    deviations: { ...a.deviations, ...b.deviations },
    push: { ...a.push, ...b.push },
  });
  let cfg = merge(DEFAULT_CONFIG, read(join(store, "config.json")));
  if (key) cfg = merge(cfg, read(join(projectDir(store, key), "config.json")));
  return cfg;
}
