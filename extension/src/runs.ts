// Linking rpiv-workflow runs to beads.
//
// `/work start` launches `/wf <workflow> <brief> --name <bead>--r<n>`. rpiv-workflow
// records that name in the run's JSONL header (WorkflowHeader.name) and in
// `.rpiv/workflows/runs/names.json`, so the link survives resumes. The listener
// reads the header back to find the bead. A run started by hand with a name in
// this format is linked the same way.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** rpiv-workflow's VALID_NAME (state/names.ts). */
export const VALID_RUN_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

/** `rw-5b3.1`, attempt 2 → `rw-5b3_1--r2`. Bead IDs never contain `_`, so the mapping is reversible. */
export function runNameFor(beadId: string, attempt: number): string {
  const name = `${beadId.replace(/\./g, "_")}--r${attempt}`;
  if (!VALID_RUN_NAME.test(name)) throw new Error(`bead id ${beadId} can't form a valid run name`);
  return name;
}

export function beadFromRunName(name: string | undefined): string | undefined {
  const m = name?.match(/^(.+)--r\d+$/);
  return m ? m[1].replace(/_/g, ".") : undefined;
}

export const runsDir = (checkoutRoot: string) => join(checkoutRoot, ".rpiv", "workflows", "runs");

/** names.json: run name → run id. Empty when absent. */
export function readRunNames(checkoutRoot: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(runsDir(checkoutRoot), "names.json"), "utf8"));
  } catch {
    return {};
  }
}

/** First free `<bead>--r<n>` name in this checkout. */
export function nextRunName(beadId: string, taken: Record<string, string>): string {
  for (let n = 1; ; n++) {
    const name = runNameFor(beadId, n);
    if (!(name in taken)) return name;
  }
}

export interface RunHeader {
  runId: string;
  workflow: string;
  input: string;
  name?: string;
}

/** The JSONL header row (line 1) of a run, if readable. */
export function readRunHeader(checkoutRoot: string, runId: string): RunHeader | undefined {
  const file = join(runsDir(checkoutRoot), `${runId}.jsonl`);
  if (!existsSync(file)) return undefined;
  try {
    const first = readFileSync(file, "utf8").split("\n", 1)[0];
    return JSON.parse(first) as RunHeader;
  } catch {
    return undefined;
  }
}

/**
 * rpiv-pi runs every stage in a child session whose directory is
 * `<cwd>/.rpiv/workflows/runs/<run-id>/sessions` (rpiv-workflow state/paths.ts
 * childSessionsDir). Children load extensions from disk, so rpivw runs inside
 * them too; this tells a child apart and gives it its run id.
 */
export function childRunId(sessionDir: string | undefined): string | undefined {
  return sessionDir?.match(/[\\/]\.rpiv[\\/]workflows[\\/]runs[\\/]([^\\/]+)[\\/]sessions[\\/]?$/)?.[1];
}

/** Store-relative artifact path and its bucket: `.rpiv/artifacts/plans/x.md` → ["plans", "plans/x.md"]. */
export function artifactBucket(path: string): [string, string] | undefined {
  const rel = path.replace(/\\/g, "/").replace(/^\.rpiv\/artifacts\//, "");
  const bucket = rel.split("/")[0];
  return rel.includes("/") ? [bucket, rel] : undefined;
}
