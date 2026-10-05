// The store repo: serialized commits and best-effort pushes.

import { bdPath } from "./bin.ts";
import { git, run } from "./exec.ts";
import { join } from "node:path";

export interface StoreRepo {
  root: string;
  /** Stage `pathspecs` (relative to the store root) and commit if anything changed. Returns the short sha or null. */
  commit(pathspecs: string[], message: string): Promise<string | null>;
  /**
   * `git push` the store, then `bd dolt push` the beads DB. Never throws. A store without
   * its configured remote is local-only: nothing is pushed and `skipped` is set.
   */
  push(opts?: { beads?: boolean }): Promise<{ ok: boolean; detail: string; skipped?: boolean }>;
  /** Content of a store-relative path at HEAD, or undefined if it was never committed. */
  showHead(path: string): Promise<string | undefined>;
}

export function openStore(root: string, opts: { remote?: () => string | undefined } = {}): StoreRepo {
  const remoteName = () => opts.remote?.() || "origin";
  // One queue per store so concurrent stage events never race on the git index.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => undefined);
    return p;
  };

  return {
    root,
    showHead: async (path) => {
      const r = await git(root, "show", `HEAD:${path.replace(/\\/g, "/")}`);
      return r.code === 0 ? r.stdout : undefined;
    },
    commit: (pathspecs, message) =>
      enqueue(async () => {
        const add = await git(root, "add", "-A", "--", ...pathspecs);
        if (add.code !== 0) throw new Error(`store: git add failed: ${add.stderr.trim()}`);
        const diff = await git(root, "diff", "--cached", "--quiet", "--", ...pathspecs);
        if (diff.code === 0) return null; // nothing staged
        const c = await git(root, "commit", "-q", "-m", message, "--", ...pathspecs);
        if (c.code !== 0) throw new Error(`store: git commit failed: ${c.stderr.trim()}`);
        const sha = await git(root, "rev-parse", "--short", "HEAD");
        return sha.stdout.trim();
      }),
    push: (opts = {}) =>
      enqueue(async () => {
        const remote = remoteName();
        if ((await git(root, "remote", "get-url", remote)).code !== 0) {
          return { ok: true, skipped: true, detail: `local-only store (no "${remote}" remote); add one with /work setup --remote <url>` };
        }
        const details: string[] = [];
        let ok = true;
        const g = await git(root, "push", "-q", remote, "HEAD");
        if (g.code !== 0) {
          ok = false;
          details.push(`git push failed: ${firstError(g.stderr)}`);
        } else details.push("git: pushed");
        if (opts.beads) {
          let bd: string;
          try {
            bd = bdPath();
          } catch (e) {
            return { ok: false, detail: [...details, `beads: ${(e as Error).message}`].join("; ") };
          }
          const b = await run(bd, ["dolt", "push"], {
            cwd: root,
            env: { ...process.env, BEADS_DIR: join(root, ".beads") },
            timeoutMs: 300_000,
          });
          if (b.code !== 0) {
            ok = false;
            details.push(`bd dolt push failed: ${firstError(b.stderr || b.stdout)}`);
          } else details.push("beads: pushed");
        }
        return { ok, detail: details.join("; ") };
      }),
  };
}

/** The most informative line of a tool's stderr: the first fatal/error line, else the first non-empty one. */
export function firstError(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error)\b/i.test(l)) ?? lines[0] ?? "(no output)";
}

/** `<run-id> <stage> [<ref>]: a.md, b.md` — one line, so `git log --oneline` reads as a timeline. */
export function commitMessage(p: {
  runId: string;
  stage: string;
  ref?: string;
  paths?: string[];
  suffix?: string;
}): string {
  const head = `${p.runId} ${p.stage}${p.ref ? ` [${p.ref}]` : ""}${p.suffix ? ` ${p.suffix}` : ""}`;
  const files = (p.paths ?? []).map((x) => x.replace(/\\/g, "/").replace(/^\.rpiv\/artifacts\//, ""));
  return files.length ? `${head}: ${files.join(", ")}` : head;
}
