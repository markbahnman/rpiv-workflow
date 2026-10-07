// Ways to review a plan waiting at a plan-approval gate.
//
// - plannotator (Pi extension): opens the plan in its review-gate UI over Pi's event
//   bus. Approve resolves our gate; annotations become a revise request.
// - hunk (TUI diff viewer): /skill:revise edits plans in place, so the store's git
//   history shows what changed. Uncommitted edits diff against HEAD; otherwise the
//   last two committed versions are compared.
// - the file itself, as a file:// link.

import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fallbackBinDirs, findBin, miseDataDir } from "./bin.ts";
import { piAgentDir } from "./config.ts";
import { git } from "./exec.ts";

export interface ReviewTools {
  /** The plannotator Pi extension is in Pi's settings packages. */
  plannotator: boolean;
  /** hunk is on PATH or installed by mise. */
  hunk: boolean;
}

export function detectReviewTools(env: NodeJS.ProcessEnv = process.env, agentDir = piAgentDir(env), dirs = fallbackBinDirs()): ReviewTools {
  let plannotator = false;
  try {
    const s = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    plannotator = (s.packages ?? []).some((p: unknown) => {
      const src = typeof p === "string" ? p : (p as { source?: string })?.source;
      return typeof src === "string" && /plannotator/i.test(src);
    });
  } catch {}
  let hunk = !!findBin(process.platform === "win32" ? ["hunk.exe", "hunk"] : ["hunk"], env, dirs);
  if (!hunk) {
    try {
      hunk = readdirSync(join(miseDataDir(env), "installs", "hunk")).length > 0;
    } catch {}
  }
  return { plannotator, hunk };
}

/** A plan path as the gate recorded it (often `.rpiv/artifacts/plans/x.md`), made absolute. */
export const absPlan = (projectRoot: string, plan: string) => (isAbsolute(plan) ? plan : resolve(projectRoot, plan));

/** Where the plan lives inside the store (`projects/<key>/artifacts/plans/x.md`), or undefined. */
export function storePlanPath(storeArtifacts: string, storeRoot: string, plan: string): string | undefined {
  const m = plan.replace(/\\/g, "/").match(/(?:^|\/)\.rpiv\/artifacts\/(.+)$/);
  if (!m) return undefined;
  return relative(storeRoot, join(storeArtifacts, m[1])).replace(/\\/g, "/");
}

export interface PlanDiff {
  /** Run from the store root. */
  command: string;
  what: string;
}

/**
 * How to see what changed in the plan: uncommitted edits (a /skill:revise in progress)
 * against HEAD, else the first committed draft against the latest version (what the
 * pipeline's review and fix stages changed).
 */
export async function planDiffCommand(storeRoot: string, storePath: string): Promise<PlanDiff | undefined> {
  const dirty = await git(storeRoot, "status", "--porcelain", "--", storePath);
  if (dirty.code === 0 && dirty.stdout.trim() && !dirty.stdout.startsWith("??")) {
    return { command: `hunk diff -- ${storePath}`, what: "uncommitted edits" };
  }
  const log = await git(storeRoot, "log", "--format=%h", "--", storePath);
  const shas = log.code === 0 ? log.stdout.trim().split(/\s+/).filter(Boolean) : [];
  if (shas.length < 2) return undefined;
  return { command: `hunk diff ${shas.at(-1)} ${shas[0]} -- ${storePath}`, what: `first draft → now, ${shas.length} versions` };
}

export interface ReviewInput {
  gateId: string;
  /** Absolute plan path. */
  plan: string;
  tools: ReviewTools;
  storeRoot: string;
  /** From planDiffCommand, when the plan has changed since an earlier version. */
  diff?: PlanDiff;
}

// plannotator's cross-extension API (pi-extension 0.27, plannotator-events.ts): emit a
// request on Pi's event bus with a `respond` callback. An `annotate` request with
// `gate: true` shows Approve / Annotate / Close and responds once the reviewer decides.
export const PLANNOTATOR_REQUEST = "plannotator:request";

export type PlannotatorResponse<R> = { status: "handled"; result: R } | { status: "unavailable" | "error"; error?: string };
export interface PlannotatorAnnotation {
  feedback: string;
  exit?: boolean;
  approved?: boolean;
}

/**
 * Whether plannotator is listening on the event bus. Being in settings.json isn't enough
 * (it can be disabled or fail to load), and an `annotate` request only answers once the
 * reviewer decides, so with no listener it would wait forever. A `review-status` request
 * is answered right away by a loaded plannotator, before it awaits anything; any answer
 * (even "error") means it's there.
 */
export function plannotatorListening(events: { emit(channel: string, data: unknown): void }, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    events.emit(PLANNOTATOR_REQUEST, {
      requestId: `rpivw-probe-${Date.now().toString(36)}`,
      action: "review-status",
      payload: { reviewId: "rpivw-probe" },
      respond: () => {
        clearTimeout(timer);
        resolve(true);
      },
    });
  });
}

/** Open `filePath` in plannotator's review-gate UI. Resolves when the reviewer decides (or plannotator refuses). */
export function requestPlanGateReview(
  events: { emit(channel: string, data: unknown): void },
  filePath: string,
  markdown: string,
): Promise<PlannotatorResponse<PlannotatorAnnotation>> {
  return new Promise((resolve) => {
    events.emit(PLANNOTATOR_REQUEST, {
      requestId: `rpivw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      action: "annotate",
      payload: { filePath, markdown, mode: "annotate", gate: true },
      respond: resolve,
    });
  });
}

/** The "how to review" lines shown with a plan gate. */
export function reviewLines(p: ReviewInput): string[] {
  const lines: string[] = [];
  if (p.tools.plannotator) lines.push(`review: /work review ${p.gateId}  (plannotator: Approve resolves this gate; annotations send the plan back for revision)`);
  lines.push(`open: ${pathToFileURL(p.plan).href}`);
  const store = p.storeRoot.replace(/\\/g, "/");
  const cd = /[\s'"$`]/.test(store) ? `'${store.replace(/'/g, `'\\''`)}'` : store; // POSIX-quoted for zsh/bash
  if (p.diff && p.tools.hunk) lines.push(`changes (${p.diff.what}): cd ${cd} && ${p.diff.command}`);
  return lines;
}
