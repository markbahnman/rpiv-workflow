// Bridge to rpiv-workflow's lifecycle events.
//
// rpiv-workflow keeps its listener registry in a globalThis slot keyed by
// Symbol.for("@juicesharp/rpiv-workflow:lifecycle") so that duplicate module
// loads share it (rpiv-workflow/events.ts, internal-utils.ts `globalSlot`).
// Pushing a listener bundle into that array is exactly what its exported
// `registerLifecycle` does, and it lets this extension live outside Pi's
// npm tree without importing rpiv-workflow. Checked against rpiv-workflow 2.11.0 and
// 2.12.0 (registry key, listener signatures, handle and result shapes unchanged).

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Beads } from "./beads.ts";
import { piAgentDir } from "./config.ts";
import { artifactBucket, beadFromRunName, readRunHeader } from "./runs.ts";
import { readStampId, stampFile } from "./stamp.ts";
import { formatStopReport, stopReport } from "./stopreport.ts";
import type { StoreRepo } from "./store.ts";
import { commitMessage } from "./store.ts";

export const LIFECYCLE_KEY = Symbol.for("@juicesharp/rpiv-workflow:lifecycle");
/** rpiv-workflow major.minor lines whose lifecycle surface this bridge was checked against. */
export const SUPPORTED_RPIV = ["2.11", "2.12"];

export const isSupportedRpiv = (version: string) => SUPPORTED_RPIV.some((mm) => version.startsWith(`${mm}.`));

// Minimal structural copies of the rpiv-workflow 2.11 types we read.
export type RunTrigger =
  | { kind: "command"; name: string }
  | { kind: "programmatic"; source?: string }
  | { kind: "external"; source: string; ref?: string };
export interface LifecycleContext {
  cwd: string;
  runId: string;
  workflow: string;
  totalStages: number;
  trigger: RunTrigger;
}
export interface StageRef {
  kind: "skill" | "script";
  name: string;
  stageNumber: number;
  skill?: string;
}
export interface StageOutput {
  kind: string;
  artifacts: readonly { handle: { kind: string; path?: string }; role?: string }[];
}
export interface UnitEvent {
  role: string;
  index: number;
  unitId?: string;
  label: string;
  skill: string;
}
export interface RunResult {
  runId?: string;
  stagesCompleted: number;
  success: boolean;
  error?: string;
  /** rpiv-workflow types.ts RunTermination. */
  termination?: { status: string; error?: string };
}
export interface LifecycleListeners {
  onWorkflowStart?(ctx: LifecycleContext): void | Promise<void>;
  /** Fires after preflight, before a skill stage's session opens or a script stage's run() is called. */
  onStageStart?(stage: StageRef, ctx: LifecycleContext): void | Promise<void>;
  onStageEnd?(stage: StageRef, output: StageOutput, ctx: LifecycleContext): void | Promise<void>;
  onStageError?(stage: StageRef, error: unknown, ctx: LifecycleContext): void | Promise<void>;
  /** Loop units (fan-out phases, grade panel members) fire this instead of onStageEnd. */
  onUnitEnd?(stage: StageRef, unit: UnitEvent, output: StageOutput, ctx: LifecycleContext): void | Promise<void>;
  onWorkflowEnd?(result: RunResult, ctx: LifecycleContext): void | Promise<void>;
}

/** Same semantics as rpiv-workflow's `registerLifecycle`. Returns a disposer. */
export function registerLifecycle(listeners: LifecycleListeners, g: Record<symbol, unknown> = globalThis as never): () => void {
  let reg = g[LIFECYCLE_KEY] as LifecycleListeners[] | undefined;
  if (!reg) {
    reg = [];
    g[LIFECYCLE_KEY] = reg;
  }
  reg.push(listeners);
  return () => {
    const i = reg!.indexOf(listeners);
    if (i >= 0) reg!.splice(i, 1);
  };
}

/** Installed rpiv-workflow version, if found in Pi's npm tree. */
export function installedRpivVersion(agentDir = piAgentDir()): string | undefined {
  try {
    const p = join(agentDir, "npm", "node_modules", "@juicesharp", "rpiv-workflow", "package.json");
    return JSON.parse(readFileSync(p, "utf8")).version;
  } catch {
    return undefined;
  }
}

export interface ResolvedProject {
  key: string;
  /** Checkout root the run's cwd belongs to. */
  root: string;
  /** store/projects/<key>/artifacts */
  artifacts: string;
}

export interface BridgeDeps {
  store: StoreRepo;
  /** Map a run's cwd to a registered, mounted project; undefined → ignore the run. */
  resolve(cwd: string): Promise<ResolvedProject | undefined>;
  pushOnEnd(key: string): boolean;
  notify(msg: string, level?: "info" | "warning" | "error"): void;
  /** Work graph. When absent, runs are only committed to the store. */
  beads?: Beads;
}

const refOf = (t: RunTrigger) => (t.kind === "external" ? t.ref : undefined);

/**
 * The listener bundle. Store side: commit after each stage or loop unit, archive
 * the run trail and push at the end. Beads side (runs linked to a bead by
 * `--name <bead>--r<n>` or an external trigger ref): claim on start, track phase
 * and latest artifacts in metadata.rpiv, comment on failures, close on success.
 */
export function createListeners(deps: BridgeDeps): LifecycleListeners {
  const projectSpec = (p: ResolvedProject) => relative(deps.store.root, join(p.artifacts, "..")).replace(/\\/g, "/");

  // Listeners run long after the session that registered them may be gone (a run can
  // end hours later, after /new). Reporting must never throw back into rpiv.
  const report = (msg: string) => {
    try {
      deps.notify(msg, "warning");
    } catch {
      // nothing left to report to; deps.notify implementations also log to disk
    }
  };
  const warn = (e: unknown) => report(`rpivw: ${(e as Error).message}`);
  const safe =
    <A extends unknown[]>(fn: (...a: A) => Promise<void>) =>
    async (...a: A) => {
      try {
        await fn(...a);
      } catch (e) {
        warn(e);
      }
    };
  /** Bead updates never block the store commit, and never throw into rpiv. */
  const onBead = async (bead: string | undefined, fn: (b: Beads, id: string) => Promise<unknown>) => {
    if (!bead || !deps.beads) return;
    try {
      await fn(deps.beads, bead);
    } catch (e) {
      warn(e);
    }
  };

  const beadCache = new Map<string, string | undefined>();
  const beadOf = (ctx: LifecycleContext, p: ResolvedProject): string | undefined => {
    if (!beadCache.has(ctx.runId)) {
      beadCache.set(ctx.runId, refOf(ctx.trigger) ?? beadFromRunName(readRunHeader(p.root, ctx.runId)?.name));
    }
    return beadCache.get(ctx.runId);
  };

  const fsPaths = (output: StageOutput) =>
    output.artifacts.filter((a) => a.handle.kind === "fs" && a.handle.path).map((a) => a.handle.path as string);

  /** Stamp the rpivw block onto each markdown artifact before it's committed. */
  const stampAll = async (p: ResolvedProject, ctx: LifecycleContext, bead: string | undefined, paths: string[]) => {
    for (const path of paths) {
      const hit = artifactBucket(path);
      if (!hit || !hit[1].endsWith(".md")) continue;
      const abs = join(p.artifacts, hit[1]);
      let previous: string | undefined;
      try {
        if (!readStampId(readFileSync(abs, "utf8"))) {
          previous = readStampId((await deps.store.showHead(`${projectSpec(p)}/artifacts/${hit[1]}`)) ?? "");
        }
      } catch {
        continue; // unreadable: leave it alone
      }
      stampFile(abs, { work: bead, run: ctx.runId, workflow: ctx.workflow }, () => previous);
    }
  };

  const recordStage = (bead: string | undefined, stageName: string, paths: string[]) =>
    onBead(bead, (b, id) =>
      b.patchRpiv(id, (m) => {
        const artifacts = { ...m.artifacts };
        for (const path of paths) {
          const hit = artifactBucket(path);
          if (hit) artifacts[hit[0]] = hit[1];
        }
        return { ...m, phase: stageName, artifacts };
      }),
    );

  return {
    onWorkflowStart: safe(async (ctx) => {
      const p = await deps.resolve(ctx.cwd);
      if (!p) return;
      await onBead(beadOf(ctx, p), async (b, id) => {
        await b.claim(id);
        await b.patchRpiv(id, (m) => ({
          ...m,
          workflow: ctx.workflow,
          phase: "started",
          runs: [...(m.runs ?? []).filter((r) => r !== ctx.runId), ctx.runId],
        }));
      });
    }),

    onStageEnd: safe(async (stage, output, ctx) => {
      const p = await deps.resolve(ctx.cwd);
      if (!p) return;
      const bead = beadOf(ctx, p);
      const paths = fsPaths(output);
      await stampAll(p, ctx, bead, paths);
      await deps.store.commit([projectSpec(p)], commitMessage({ runId: ctx.runId, stage: stage.name, ref: bead, paths }));
      await recordStage(bead, stage.name, paths);
    }),

    onUnitEnd: safe(async (stage, unit, output, ctx) => {
      const p = await deps.resolve(ctx.cwd);
      if (!p) return;
      const bead = beadOf(ctx, p);
      const label = unit.unitId ?? unit.label;
      // Panel members already carry the unit in the stage name ("grade (plans-dim-correctness)").
      const name = stage.name.includes(label) ? stage.name : `${stage.name} (${label})`;
      const paths = fsPaths(output);
      await stampAll(p, ctx, bead, paths);
      await deps.store.commit([projectSpec(p)], commitMessage({ runId: ctx.runId, stage: name, ref: bead, paths }));
      await recordStage(bead, name, paths);
    }),

    onStageError: safe(async (stage, err, ctx) => {
      const p = await deps.resolve(ctx.cwd);
      if (!p) return;
      const bead = beadOf(ctx, p);
      await deps.store.commit([projectSpec(p)], commitMessage({ runId: ctx.runId, stage: stage.name, ref: bead, suffix: "(failed)" }));
      const detail = String((err as Error)?.message ?? err).split("\n")[0].slice(0, 300);
      await onBead(bead, (b, id) => b.comment(id, `run ${ctx.runId}: stage "${stage.name}" failed: ${detail}`));
    }),

    onWorkflowEnd: safe(async (result, ctx) => {
      const p = await deps.resolve(ctx.cwd);
      if (!p) return;
      const runId = result.runId ?? ctx.runId;
      const bead = beadOf(ctx, p);
      const trail = join(p.root, ".rpiv", "workflows", "runs", `${runId}.jsonl`);
      if (existsSync(trail)) {
        mkdirSync(join(p.artifacts, "runs"), { recursive: true });
        copyFileSync(trail, join(p.artifacts, "runs", `${runId}.jsonl`));
      }
      // stagesCompleted counts re-executed stages after a resume, so it can exceed totalStages.
      const outcome = `${ctx.workflow} ${result.success ? "succeeded" : "stopped"} (${result.stagesCompleted} stage runs)`;
      await deps.store.commit([projectSpec(p)], commitMessage({ runId, stage: "end", ref: bead, suffix: outcome }));
      await onBead(bead, async (b, id) => {
        if (result.success) {
          await b.patchRpiv(id, (m) => ({ ...m, phase: "done" }));
          await b.close(id, `${ctx.workflow} run ${runId} succeeded`);
        } else {
          // The trail names the failing checks, their findings, and the file to edit.
          const report = stopReport(p.root, runId);
          if (report) await b.comment(id, formatStopReport(report, { full: true }));
          else {
            const why = (result.error ?? result.termination?.error ?? "stopped").split("\n")[0].slice(0, 300);
            await b.comment(id, `run ${runId} (${ctx.workflow}) stopped: ${why}. Fix, then resume with /wf @${runId}`);
          }
        }
      });
      if (deps.pushOnEnd(p.key)) {
        const r = await deps.store.push({ beads: !!bead && !!deps.beads });
        if (!r.ok) report(`rpivw: store push failed (artifacts are committed locally; /work sync retries): ${r.detail}`);
      }
    }),
  };
}
