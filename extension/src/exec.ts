// Thin promise wrapper around execFile. No shell: arguments are passed as-is,
// which avoids Windows quoting problems with JSON and paths.

import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          timeout: opts.timeoutMs ?? 120_000,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : "")) });
        },
      );
    } catch (e) {
      // execFile throws SYNCHRONOUSLY when the child never gets spawned: an over-long
      // command line (Windows caps CreateProcess at 32,767 chars → ENAMETOOLONG), or an
      // invalid argument. Fail here, in the same `{code, stderr}` shape as an exit, so
      // callers still add their `bd <verb> failed:` / `git …` prefix instead of leaking
      // a bare `spawn ENAMETOOLONG` that names no tool.
      resolve({ code: 1, stdout: "", stderr: String((e as Error).message) });
    }
  });
}

export async function git(cwd: string, ...args: string[]): Promise<ExecResult> {
  return run("git", args, { cwd });
}

/** Run git and return trimmed stdout, or throw with stderr on failure. */
export async function gitOut(cwd: string, ...args: string[]): Promise<string> {
  const r = await git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
