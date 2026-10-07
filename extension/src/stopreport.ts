// What stopped a run, and what to do about it.
//
// rpiv-workflow's halt toast names the gate and its route note ("correctness failed
// (medium), …") and says "see the stage's verdict for findings", but not which
// verdict files, what they found, or which artifact to edit. Everything needed is
// in the run's JSONL trail (.rpiv/workflows/runs/<run-id>.jsonl): the routing row
// that chose "stop", the gate's unit rows (one per graded dimension, with the
// verdict inline in output.data), and the final failed row. This reads the trail
// and turns it into a list of blockers plus exact next steps.
//
// Row shapes checked against rpiv-workflow 2.12.0 run trails (v3 header).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { runsDir } from "./runs.ts";

interface Finding {
  detail?: string;
  where?: string;
  advisory?: boolean;
}
interface Verdict {
  dimension?: string;
  pass?: boolean;
  score?: number;
  severity?: string;
  artifact?: string;
  findings?: Finding[];
  feedback?: string;
}
interface Row {
  type?: string;
  stage?: string;
  status?: string;
  errMsg?: string;
  parent?: string;
  unitId?: string;
  unitLabel?: string;
  decision?: string;
  fromStage?: string;
  note?: string;
  output?: { artifacts?: { handle: { kind: string; path?: string }; role?: string }[]; data?: unknown };
  session?: { file?: string } | null;
}

export interface Blocker {
  /** The dimension or stage that failed ("correctness", "plan-cite-check", "implement"). */
  name: string;
  /** "medium, score 90", or "no verdict" for a unit that produced nothing. */
  rating: string;
  findings: { where?: string; detail: string }[];
  /** The verdict's own fix advice. */
  fix?: string;
  /** Verdict file, relative to the checkout. */
  verdict?: string;
  /** The artifact the verdict graded, relative to the checkout. */
  artifact?: string;
  /** Child session to read when the stage itself failed. */
  session?: string;
  error?: string;
}

export interface StopReport {
  runId: string;
  workflow?: string;
  stage: string;
  /** "gate" when a routing gate chose stop; "error" when the stage itself failed. */
  kind: "gate" | "error";
  /** rpiv's route note or error message. */
  reason: string;
  blockers: Blocker[];
  next: string[];
}

const slash = (p: string) => p.replace(/\\/g, "/");

function readRows(root: string, runId: string): Row[] | undefined {
  const file = join(runsDir(root), `${runId}.jsonl`);
  if (!existsSync(file)) return undefined;
  const rows: Row[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // a torn last line while rpiv is still writing: ignore it
    }
  }
  return rows;
}

/** Path relative to the checkout, forward slashes. */
const rel = (root: string, p: string | undefined) => {
  if (!p) return undefined;
  const r = isAbsolute(p) ? relative(root, p) : p;
  return slash(r.startsWith("..") ? p : r);
};

const primaryPath = (row: Row) => {
  const arts = (row.output?.artifacts ?? []).filter((a) => a.handle.kind === "fs" && a.handle.path);
  return (arts.find((a) => a.role === "primary") ?? arts[0])?.handle.path;
};

const asVerdict = (data: unknown): Verdict | undefined =>
  data && typeof data === "object" && "pass" in data ? (data as Verdict) : undefined;

const firstLine = (s: string | undefined) => s?.split("\n")[0].trim();

function verdictBlocker(root: string, row: Row, v: Verdict): Blocker {
  const findings = (v.findings ?? [])
    .filter((f) => f.advisory !== true && f.detail)
    .map((f) => ({ where: f.where, detail: f.detail!.trim() }));
  return {
    name: v.dimension ?? row.unitLabel ?? row.stage ?? "gate",
    rating: [v.severity, v.score !== undefined ? `score ${v.score}` : undefined].filter(Boolean).join(", ") || "failed",
    findings,
    fix: v.feedback?.trim() || undefined,
    verdict: rel(root, primaryPath(row)),
    artifact: rel(root, v.artifact),
  };
}

/**
 * The report for a run that stopped, or undefined when the run didn't stop on a
 * failure (still running, completed, or no trail).
 */
export function stopReport(root: string, runId: string): StopReport | undefined {
  const rows = readRows(root, runId);
  if (!rows?.length) return undefined;
  const header = rows[0] as { workflow?: string };
  const last = rows.at(-1)!;
  if (last.type || last.status !== "failed") return undefined;

  const stopAt = rows.findLastIndex((r) => r.type === "routing" && r.decision === "stop");
  const gateStop = stopAt >= 0 && stopAt === rows.length - 2 && !!rows[stopAt].fromStage;
  const resume = `/wf @${runId}`;

  if (!gateStop) {
    const stage = last.parent ?? last.stage ?? "?";
    const session = rel(root, last.session?.file ?? undefined);
    return {
      runId,
      workflow: header.workflow,
      stage,
      kind: "error",
      reason: firstLine(last.errMsg) ?? "stage failed",
      blockers: [{ name: last.unitLabel ?? last.stage ?? stage, rating: "failed", findings: [], error: last.errMsg?.trim(), session }],
      next: [
        ...(session ? [`Read what the stage did: ${session}`] : []),
        `Fix the cause, then resume with ${resume} (re-runs "${stage}"; earlier stages are reused).`,
      ],
    };
  }

  // A gate stopped the run. Its rows since the run last routed into it, latest per unit.
  const gate = rows[stopAt].fromStage!;
  const enteredAt = rows.findLastIndex((r, i) => i < stopAt && r.type === "routing" && r.decision === gate);
  const latest = new Map<string, Row>();
  for (const r of rows.slice(enteredAt + 1, stopAt)) {
    if (r.type || (r.parent !== gate && r.stage !== gate)) continue;
    latest.set(r.unitId ?? r.stage ?? gate, r);
  }

  const blockers: Blocker[] = [];
  for (const r of latest.values()) {
    const v = asVerdict(r.output?.data);
    if (r.status === "completed" && v?.pass === false) blockers.push(verdictBlocker(root, r, v));
    else if (r.status === "failed") {
      blockers.push({
        name: r.unitLabel ?? r.stage ?? gate,
        rating: "no verdict",
        findings: [],
        error: firstLine(r.errMsg),
        session: rel(root, r.session?.file ?? undefined),
      });
    }
  }

  const artifacts = [...new Set(blockers.map((b) => b.artifact).filter((a): a is string => !!a))];
  const next: string[] = [];
  if (artifacts.length) {
    next.push(`Edit ${artifacts.join(", ")} to address the finding${blockers.reduce((n, b) => n + b.findings.length, 0) === 1 ? "" : "s"} above (each "fix" is the grader's own advice).`);
  } else if (blockers.some((b) => b.verdict)) {
    next.push("Fix what the verdicts above describe.");
  }
  if (blockers.some((b) => b.rating === "no verdict")) {
    next.push("A grader produced no verdict; read its session above. Resuming dispatches it again.");
  }
  if (!blockers.length) {
    next.push(`No failing verdict found in the trail; rpiv's reason was: ${rows[stopAt].note ?? last.errMsg ?? "gate failed"}.`);
  }
  next.push(`Resume with ${resume}: it re-runs "${gate}" against your edits and reuses every earlier stage.`);

  return {
    runId,
    workflow: header.workflow,
    stage: gate,
    kind: "gate",
    reason: rows[stopAt].note ?? firstLine(last.errMsg) ?? "gate failed",
    blockers,
    next,
  };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * Plain text for a notification or a bead comment. `full` keeps every finding's
 * whole text; otherwise each is clipped (a finding's first sentence is often just
 * "Two sections contradict each other.") and the verdict file holds the rest.
 */
export function formatStopReport(r: StopReport, opts: { full?: boolean } = {}): string {
  const short = (s: string, n: number) => (opts.full ? s : clip(s.replace(/\s+/g, " "), n));
  const n = r.blockers.length;
  const head =
    r.kind === "gate"
      ? `✗ ${r.workflow ?? "run"} stopped at "${r.stage}": ${n} check${n === 1 ? "" : "s"} failed`
      : `✗ ${r.workflow ?? "run"} stopped: stage "${r.stage}" failed`;
  const lines = [head, `run: ${r.runId}`];
  r.blockers.forEach((b, i) => {
    lines.push("", `${i + 1}. ${b.name} (${b.rating})`);
    for (const f of b.findings) lines.push(`   - ${f.where ? `[${f.where}] ` : ""}${short(f.detail, 240)}`);
    if (b.error) lines.push(`   error: ${short(b.error, 240)}`);
    if (b.fix) lines.push(`   fix: ${short(b.fix, 240)}`);
    if (b.verdict) lines.push(`   verdict: ${b.verdict}`);
    if (b.session) lines.push(`   session: ${b.session}`);
  });
  lines.push("", "Next:");
  r.next.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  if (!opts.full) lines.push(`  Full findings: /work why ${r.runId}`);
  return lines.join("\n");
}

/** The newest run in this checkout that stopped on a failure. */
export function latestStoppedRun(root: string): string | undefined {
  const dir = runsDir(root);
  if (!existsSync(dir)) return undefined;
  // Run ids start with their start time (2026-10-06_22-34-07-c86b), so name order is age order.
  const ids = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .sort()
    .reverse();
  return ids.find((id) => stopReport(root, id));
}
