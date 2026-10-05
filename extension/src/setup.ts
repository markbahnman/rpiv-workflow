// `/work setup`: create (or join) the store on a new machine.
//
// New store:      git init -b main, skeleton files, `bd init --stealth`, first commit.
// With --remote:  an empty remote becomes origin (and the beads Dolt remote) and gets the
//                 first push; a remote that already holds a store is cloned, and beads is
//                 restored from its refs/dolt/data with `bd bootstrap`.
// Re-running is safe: it fills in whatever is missing and leaves the rest alone.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG } from "./config.ts";
import { type ExecResult, git, run } from "./exec.ts";
import { firstError, openStore } from "./store.ts";

export const STORE_GITIGNORE = ["# beads database: synced separately via `bd dolt push` (refs/dolt/data)", ".beads/", ".beads.gate.lock"];

export const STORE_README = `# rpivw store

Artifact store for the **rpivw** Pi extension. Mostly written by the extension; safe to
read, diff, and grep by hand.

| Path | What |
| --- | --- |
| \`registry.json\` | repo-key → project name and known checkout paths |
| \`config.json\` | Global settings: gates, deviation handling, push policy |
| \`projects/<repo-key>/artifacts/\` | rpiv artifacts, mounted into each checkout as \`.rpiv/artifacts\` |
| \`projects/<repo-key>/project.md\` | One-page project brief |
| \`.beads/\` | One beads database for all projects (label \`project:<key>\`). Not in git; synced to \`refs/dolt/data\` on the same remote with \`bd dolt push\`. |

Another machine: install the extension, then run \`/work setup --remote <this repo's URL>\`
in Pi. It clones the store and restores the beads database.
`;

/** The Dolt remote URL for a git remote: scp-style and URL forms get `git+`, local paths become `git+file://`. */
export function doltRemoteUrl(gitUrl: string, base = process.cwd()): string {
  if (gitUrl.startsWith("git+")) return gitUrl;
  const scp = gitUrl.match(/^([\w.-]+)@([^:/]+):(.+)$/);
  if (scp) return `git+ssh://${scp[1]}@${scp[2]}/${scp[3]}`;
  if (/^(ssh|https?|file):\/\//.test(gitUrl)) return `git+${gitUrl}`;
  const abs = isAbsolute(gitUrl) || /^[A-Za-z]:[\\/]/.test(gitUrl) ? gitUrl : resolve(base, gitUrl);
  return `git+${pathToFileURL(abs).href}`;
}

export interface SetupOptions {
  /** Git URL of the store's remote: empty (new store) or an existing store to join. */
  remote?: string;
  /** Bead id prefix for a new database. */
  prefix?: string;
}

export interface SetupResult {
  ok: boolean;
  lines: string[];
  /** Something new was created; the extension needs /reload to pick it up. */
  changed: boolean;
}

type Runner = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<ExecResult>;

export async function setupStore(root: string, opts: SetupOptions, bd: string | undefined, runner: Runner = run): Promise<SetupResult> {
  const lines: string[] = [];
  let changed = false;
  const fail = (msg: string): SetupResult => ({ ok: false, lines: [...lines, msg], changed });
  const prefix = opts.prefix ?? "rw";
  if (!/^[a-z][a-z0-9]{0,9}$/.test(prefix)) return fail(`prefix "${prefix}" should be 1-10 lowercase letters/digits, starting with a letter.`);

  // ---- 1. the git repo
  if (!existsSync(join(root, ".git"))) {
    if (existsSync(root) && readdirSync(root).length > 0) {
      return fail(`${root} exists, isn't empty, and isn't a git repo. Move it aside, or point RPIVW_STORE somewhere else.`);
    }
    if (opts.remote) {
      mkdirSync(dirname(root), { recursive: true });
      const c = await runner("git", ["clone", "-q", opts.remote, root], { cwd: dirname(root), timeoutMs: 300_000 });
      if (c.code !== 0) return fail(`git clone ${opts.remote} failed: ${firstError(c.stderr)}`);
      const head = await git(root, "rev-parse", "--verify", "-q", "HEAD");
      if (head.code !== 0) await git(root, "symbolic-ref", "HEAD", "refs/heads/main"); // empty remote: start on main
      lines.push(head.code === 0 ? `cloned the store from ${opts.remote}` : `cloned ${opts.remote} (empty): starting a new store`);
    } else {
      mkdirSync(root, { recursive: true });
      const i = await git(root, "init", "-q", "-b", "main");
      if (i.code !== 0) return fail(`git init failed: ${firstError(i.stderr)}`);
      lines.push(`created a store at ${root} (local only; add a remote later with /work setup --remote <url>)`);
    }
    changed = true;
  } else {
    lines.push(`store: ${root}`);
    if (opts.remote) {
      const cur = await git(root, "remote", "get-url", "origin");
      if (cur.code !== 0) {
        await git(root, "remote", "add", "origin", opts.remote);
        lines.push(`added remote origin → ${opts.remote}`);
        changed = true;
      } else if (cur.stdout.trim() !== opts.remote) {
        lines.push(`origin is already ${cur.stdout.trim()}; left it alone`);
      }
    }
  }
  // bd prints a role warning on every command without this (it's local git config, so clones lack it).
  await git(root, "config", "beads.role", "maintainer");

  // ---- 2. skeleton files
  const created: string[] = [];
  const ensure = (name: string, content: string) => {
    if (existsSync(join(root, name))) return;
    writeFileSync(join(root, name), content);
    created.push(name);
  };
  ensure("README.md", STORE_README);
  ensure("config.json", `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  ensure("registry.json", `${JSON.stringify({ version: 1, projects: {} }, null, 2)}\n`);
  const gi = join(root, ".gitignore");
  const have = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const missing = STORE_GITIGNORE.slice(1).filter((l) => !have.split(/\r?\n/).includes(l));
  if (missing.length) {
    appendFileSync(gi, `${have && !have.endsWith("\n") ? "\n" : ""}${have ? "" : `${STORE_GITIGNORE[0]}\n`}${missing.join("\n")}\n`);
    created.push(".gitignore");
  }
  if (created.length) {
    try {
      const sha = await openStore(root).commit(created, "Initialize rpivw store");
      lines.push(`added ${created.join(", ")}${sha ? ` (commit ${sha})` : ""}`);
      changed = true;
    } catch (e) {
      return fail(`${(e as Error).message}. If git has no identity yet: git config --global user.name/user.email, then rerun /work setup.`);
    }
  }

  // ---- 3. beads
  const beadsDir = join(root, ".beads");
  const origin = (await git(root, "remote", "get-url", "origin")).stdout.trim() || undefined;
  if (!bd) {
    lines.push("bd not found: work tracking (/work new|next|start, gates) stays off; artifacts still work. Install bd (or set RPIVW_BD), then rerun /work setup.");
  } else if (existsSync(join(beadsDir, "config.yaml"))) {
    lines.push("beads: database exists");
  } else {
    const env = { ...process.env, BEADS_DIR: beadsDir };
    const bdRun = (args: string[]) => runner(bd, args, { cwd: root, env, timeoutMs: 300_000 });
    const dolt = origin ? doltRemoteUrl(origin, root) : undefined;
    const hasData = origin ? (await git(root, "ls-remote", "origin", "refs/dolt/data")).stdout.trim() !== "" : false;
    if (dolt && hasData) {
      // bootstrap's own URL detection breaks on local paths ("git+C:/…"), so pin sync.remote first.
      mkdirSync(beadsDir, { recursive: true });
      writeFileSync(join(beadsDir, "config.yaml"), `sync:\n    remote: "${dolt}"\n`);
      const b = await bdRun(["bootstrap", "--yes"]);
      if (b.code !== 0) return fail(`bd bootstrap failed: ${firstError(b.stderr || b.stdout)}`);
      lines.push(`beads: restored the database from ${dolt}`);
    } else {
      const i = await bdRun(["init", "--quiet", "--stealth", "--prefix", prefix, "--skip-agents", "--skip-hooks"]);
      if (i.code !== 0) return fail(`bd init failed: ${firstError(i.stderr || i.stdout)}`);
      lines.push(`beads: created a database (bead ids ${prefix}-…)`);
      if (dolt) {
        await bdRun(["config", "set", "sync.remote", dolt]);
        const r = await bdRun(["dolt", "remote", "add", "origin", dolt, "--allow-git-origin"]);
        lines.push(r.code === 0 ? `beads: Dolt remote → ${dolt}` : `beads: couldn't add the Dolt remote: ${firstError(r.stderr || r.stdout)}`);
      }
      lines.push("note: bd shares anonymous usage metrics by default (command names, version, OS). Turn them off with `bd metrics off` (check with `bd metrics`).");
    }
    changed = true;
  }

  // ---- 4. first push, so the store has an upstream (/work sync and the unpushed-commit check rely on it)
  if (origin && changed) {
    const p = await git(root, "push", "-q", "-u", "origin", "HEAD");
    lines.push(p.code === 0 ? `pushed to ${origin}` : `push failed (run /work sync later): ${firstError(p.stderr)}`);
    if (p.code === 0 && bd && existsSync(join(beadsDir, "config.yaml"))) {
      const d = await runner(bd, ["dolt", "push"], { cwd: root, env: { ...process.env, BEADS_DIR: beadsDir }, timeoutMs: 300_000 });
      if (d.code !== 0) lines.push(`beads push failed (run /work sync later): ${firstError(d.stderr || d.stdout)}`);
    }
  }
  if (changed) lines.push("run /reload so the extension picks up the store.");
  return { ok: true, lines, changed };
}
