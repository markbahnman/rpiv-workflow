// registry.json: which projects the store knows about and where they are checked out.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { samePath } from "./paths.ts";

export interface ProjectEntry {
  name: string;
  paths: string[];
  registered: string;
}

export interface Registry {
  version: 1;
  projects: Record<string, ProjectEntry>;
}

const file = (store: string) => join(store, "registry.json");

export function readRegistry(store: string): Registry {
  try {
    const r = JSON.parse(readFileSync(file(store), "utf8")) as Registry;
    return { version: 1, projects: r.projects ?? {} };
  } catch {
    return { version: 1, projects: {} };
  }
}

export function writeRegistry(store: string, reg: Registry): void {
  writeFileSync(file(store), `${JSON.stringify(reg, null, 2)}\n`);
}


/** Add or update a project. Returns true if the registry changed. */
export function register(
  reg: Registry,
  key: string,
  name: string,
  path: string,
  opts: { now?: Date; rename?: boolean } = {},
): boolean {
  const now = opts.now ?? new Date();
  const existing = reg.projects[key];
  if (!existing) {
    reg.projects[key] = { name, paths: [resolve(path)], registered: now.toISOString() };
    return true;
  }
  let changed = false;
  if (opts.rename && existing.name !== name) {
    existing.name = name;
    changed = true;
  }
  if (!existing.paths.some((p) => samePath(p, path))) {
    existing.paths.push(resolve(path));
    changed = true;
  }
  return changed;
}

/**
 * Default short name: last segment of a remote-derived key ("github.com__me__dashboard" → "dashboard").
 * Remote-less keys ("local__<sha>") use the checkout folder name instead of the hash.
 */
export function defaultName(key: string, checkoutRoot?: string): string {
  if (key.startsWith("local__") && checkoutRoot) {
    const folder = checkoutRoot.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    if (folder) return folder;
  }
  return key.split("__").pop() || key;
}
