// `/work new | next | start | status <bead>`: the beads side of the command, kept
// free of Pi types so it can be tested with a fake Beads.

import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { type Bead, type Beads, projectLabel, rpivMeta, titleFromBrief, type Approval } from "./beads.ts";
import {
  approveHint,
  baseName,
  DEVIATION_LABEL,
  deviationHint,
  gateBlocks,
  gatePlan,
  isRpivwGate,
  REIMPLEMENT_LABEL,
  TRACKED_BASES,
  trackedName,
} from "./gates.ts";
import { nextRunName } from "./runs.ts";

export interface WorkCtx {
  beads: Beads;
  /** Current project; undefined when cwd is not a registered checkout. */
  project?: { key: string; name: string };
  /** name per key, for labeling cross-project lists. */
  projectNames: Record<string, string>;
  /** Checkout root, so gate notices can print an absolute link. */
  root?: string;
  /** Base workflows /work start runs as <name>-rpivw (default TRACKED_BASES). */
  tracked?: string[];
}

/** Split `--flag value` / `--flag` options out of a free-text argument string. */
export function parseArgs(args: string, valued: string[] = []): { flags: Record<string, string | true>; rest: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--") && t.length > 2) {
      const name = t.slice(2);
      if (valued.includes(name) && i + 1 < tokens.length) flags[name] = tokens[++i];
      else flags[name] = true;
    } else rest.push(t);
  }
  return { flags, rest: rest.join(" ") };
}

export const beadProject = (b: Bead) => b.labels?.find((l) => l.startsWith("project:"))?.slice("project:".length);

const needProject = (ctx: WorkCtx) => {
  if (!ctx.project) throw new Error("this checkout isn't registered. Run /work init first.");
  return ctx.project;
};

const TYPES = ["feature", "bug", "task", "chore", "epic"];

/** /work new <brief> [--type feature|bug|task|chore|epic] [--parent <bead>] */
export async function workNew(ctx: WorkCtx, args: string): Promise<string> {
  const project = needProject(ctx);
  const { flags, rest } = parseArgs(args, ["type", "parent"]);
  const brief = rest.trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  if (!brief) throw new Error('usage: /work new "<brief>" [--type feature|bug|task|chore|epic] [--parent <bead>]');
  const type = typeof flags.type === "string" ? flags.type : "feature";
  if (!TYPES.includes(type)) throw new Error(`unknown type "${type}" (use ${TYPES.join(", ")})`);
  const parent = typeof flags.parent === "string" ? flags.parent : undefined;
  const bead = await ctx.beads.create({
    title: titleFromBrief(brief),
    description: brief,
    type,
    parent,
    labels: [projectLabel(project.key)],
  });
  return [
    `created ${bead.id} (${type}${parent ? `, child of ${parent}` : ""}): ${bead.title}`,
    type === "epic" ? `add work under it: /work new "<brief>" --parent ${bead.id}` : `start it: /work start ${bead.id} [ship|build]`,
  ].join("\n");
}

function line(b: Bead, ctx: WorkCtx, showProject: boolean): string {
  const m = rpivMeta(b);
  const proj = showProject ? `${ctx.projectNames[beadProject(b) ?? ""] ?? beadProject(b) ?? "?"}  ` : "";
  const phase = m.phase && m.phase !== "done" ? ` [${m.phase}]` : "";
  const type = b.issue_type === "epic" ? "EPIC" : b.issue_type;
  return `${proj}${b.id}  ${type}${phase}  ${b.title}`;
}

/** /work next [--all] — ready beads for this project (or every project). */
export async function workNext(ctx: WorkCtx, args: string): Promise<string> {
  const { flags } = parseArgs(args);
  const all = flags.all === true || !ctx.project;
  const labels = all ? undefined : [projectLabel(ctx.project!.key)];
  const ready = (await ctx.beads.ready({ labels })).filter((b) => b.issue_type !== "gate");
  const doing = (await ctx.beads.list({ labels, status: "in_progress" })).filter((b) => b.issue_type !== "gate");
  const scope = all ? "all projects" : ctx.project!.name;
  const out: string[] = [];
  const waiting = await openGates(ctx, all);
  if (waiting.length) {
    out.push(
      `awaiting you (${scope}):`,
      ...waiting.map((g) => [`  ${g.id}  ${g.title}  →  ${gateHint(g)}`, ...gatePlanLines(g, ctx)].join("\n")),
    );
  }
  if (doing.length) out.push(`in progress (${scope}):`, ...doing.map((b) => `  ${line(b, ctx, all)}`));
  const epics = ready.filter((b) => b.issue_type === "epic");
  const work = ready.filter((b) => b.issue_type !== "epic");
  out.push(work.length ? `ready (${scope}):` : `nothing ready (${scope}).`, ...work.map((b) => `  ${line(b, ctx, all)}`));
  if (epics.length) out.push("open epics:", ...epics.map((b) => `  ${line(b, ctx, all)}`));
  if (!all && ctx.project) out.push("(/work next --all for every project)");
  return out.join("\n");
}

export interface StartPlan {
  bead: Bead;
  workflow: string;
  runName: string;
  /** The exact command to send: `/wf <workflow> <input> --name <runName>` */
  command: string;
}

/**
 * /work start <bead> [workflow] [--force] — claim the bead and build the /wf command.
 * The caller sends `command`; the lifecycle bridge links the run back via its name.
 */
export async function workStart(ctx: WorkCtx, args: string, takenRunNames: Record<string, string>): Promise<StartPlan> {
  const project = needProject(ctx);
  const { flags, rest } = parseArgs(args);
  const [id, workflowArg] = rest.split(/\s+/);
  if (!id) throw new Error("usage: /work start <bead> [ship|build|<workflow>] [--force]");
  const bead = await ctx.beads.show(id);
  const force = flags.force === true;
  const owner = beadProject(bead);
  if (owner !== project.key && !force) {
    throw new Error(`${id} belongs to ${ctx.projectNames[owner ?? ""] ?? owner ?? "no project"}, not ${project.name}. Start it from that checkout (or --force).`);
  }
  if (bead.status === "closed") throw new Error(`${id} is closed.`);
  if (bead.status === "in_progress" && !force) {
    const last = rpivMeta(bead).runs?.at(-1);
    throw new Error(
      `${id} is already in progress${last ? `. Resume its run with /wf @${last}` : ""}, or start a new run anyway with --force.`,
    );
  }
  if (bead.issue_type === "epic" && !force) throw new Error(`${id} is an epic. Start one of its children (/work next), or --force.`);

  const base = baseName(workflowArg ?? rpivMeta(bead).workflow ?? "ship");
  const workflow = (ctx.tracked ?? TRACKED_BASES).includes(base) ? trackedName(base) : base;
  let input = (bead.description || bead.title).replace(/\s+/g, " ").trim();
  if (input.startsWith("@")) input = `Task: ${input}`; // "@..." would mean "resume" to /wf
  const runName = nextRunName(bead.id, takenRunNames);
  await ctx.beads.claim(bead.id);
  return { bead, workflow, runName, command: `/wf ${workflow} ${input} --name ${runName}` };
}

/** /work status <bead> — phase, runs, artifacts, recent comments. */
export async function workBeadStatus(ctx: WorkCtx, id: string): Promise<string> {
  const b = await ctx.beads.show(id);
  const m = rpivMeta(b);
  const out = [
    `${b.id}  ${b.issue_type}  ${b.status}  ${b.title}`,
    `project: ${ctx.projectNames[beadProject(b) ?? ""] ?? beadProject(b) ?? "-"}`,
  ];
  if (m.workflow || m.phase) out.push(`workflow: ${m.workflow ?? "-"}   phase: ${m.phase ?? "-"}`);
  if (m.runs?.length) out.push(`runs: ${m.runs.slice(-3).join(", ")}${m.runs.length > 3 ? ` (+${m.runs.length - 3} earlier)` : ""}`);
  const arts = Object.entries(m.artifacts ?? {});
  if (arts.length) out.push("artifacts:", ...arts.map(([k, v]) => `  ${k.padEnd(12)} ${v}`));
  const comments = await ctx.beads.comments(b.id);
  if (comments.length) out.push("recent notes:", ...comments.slice(-5).map((c) => `  ${c.created_at?.slice(0, 16).replace("T", " ") ?? ""}  ${c.text}`));
  return out.join("\n");
}

/** /work status (no bead) — the beads part of the overview. */
export async function workInProgress(ctx: WorkCtx): Promise<string> {
  if (!ctx.project) return "";
  const doing = await ctx.beads.list({ labels: [projectLabel(ctx.project.key)], status: "in_progress" });
  return doing.length ? ["in progress:", ...doing.map((b) => `  ${line(b, ctx, false)}`)].join("\n") : "in progress: none";
}

// ---------------------------------------------------------------- gates (M3)

/** Open rpivw gates (plan approvals and major deviations) for this project (or all). */
export async function openGates(ctx: WorkCtx, all = false): Promise<Bead[]> {
  const label = ctx.project ? projectLabel(ctx.project.key) : undefined;
  return (await ctx.beads.gates()).filter(
    (g) => g.status !== "closed" && isRpivwGate(g) && (all || !label || !!g.labels?.includes(label)),
  );
}

export const isDeviationGate = (g: Bead) => !!g.labels?.includes(DEVIATION_LABEL);
export const gateHint = (g: Bead) => (isDeviationGate(g) ? deviationHint(g.id) : approveHint(g.id));

/**
 * The plan a gate recorded, as lines under its "awaiting you" entry: the path (clickable
 * in most terminals) and a file:// link. M5 adds a link to the rendered plan.
 */
function gatePlanLines(g: Bead, ctx: WorkCtx): string[] {
  const plan = gatePlan(g.description);
  if (!plan || plan === "the") return [];
  const abs = isAbsolute(plan) ? plan : ctx.root ? resolve(ctx.root, plan) : undefined;
  return [`      plan: ${plan}`, ...(abs ? [`      open: ${pathToFileURL(abs).href}`] : [])];
}

/** Record a decision in metadata.rpiv.approvals so the gate stage can find it on resume. */
async function recordApproval(beads: Beads, bead: string | undefined, gateId: string, notes: string, via: Approval["via"]): Promise<void> {
  if (!bead) return;
  await beads.patchRpiv(bead, (m) => ({
    ...m,
    approvals: { ...m.approvals, [gateId]: { ...(notes.trim() ? { notes: notes.trim() } : {}), at: new Date().toISOString(), via } },
  }));
}

async function openGate(ctx: WorkCtx, id: string | undefined, usage: string): Promise<Bead> {
  if (!id) throw new Error(usage);
  const g = await ctx.beads.show(id);
  if (!isRpivwGate(g)) throw new Error(`${id} isn't an rpivw gate.`);
  if (g.status === "closed") throw new Error(`${id} is already resolved.`);
  return g;
}

export interface ApproveResult {
  message: string;
  /** Run to resume with /wf @<runId>. */
  runId?: string;
}

/**
 * /work approve <gate> [notes] [--reimplement] — record the decision on the bead and
 * resolve the gate. The caller resumes the run. For a deviation gate, --reimplement
 * sends the run back to implement once (after you've revised the plan).
 */
export async function workApprove(ctx: WorkCtx, args: string): Promise<ApproveResult> {
  const { flags, rest } = parseArgs(args);
  const [id, ...words] = rest.split(/\s+/).filter(Boolean);
  const g = await openGate(ctx, id, "usage: /work approve <gate> [notes] [--reimplement]");
  const notes = words.join(" ").trim();
  const bead = gateBlocks(g.description);
  const reimplement = flags.reimplement === true;
  let what: string;
  if (isDeviationGate(g)) {
    if (reimplement) await ctx.beads.updateLabels(g.id, [REIMPLEMENT_LABEL], []);
    what = reimplement ? "deviation: re-implement with the revised plan" : "deviation: continue as planned";
  } else {
    if (reimplement) throw new Error("--reimplement applies to deviation gates. For a plan gate, just /work approve it.");
    what = "plan approved";
  }
  if (bead) await ctx.beads.comment(bead, `${what}${notes ? `: ${notes}` : ""} (gate ${g.id})`);
  await recordApproval(ctx.beads, bead, g.id, notes, "approve");
  await ctx.beads.resolveGate(g.id);
  return { message: `${what} (${g.id}${bead ? ` for ${bead}` : ""})`, runId: g.await_id };
}

/** A plannotator decision on a plan opened in review-gate mode (Approve / Annotate / Close). */
export interface PlanReviewDecision {
  approved?: boolean;
  feedback?: string;
  exit?: boolean;
}

export interface PlanReviewOutcome {
  message: string;
  /** Approved: the run to resume with /wf @<runId>. */
  runId?: string;
  /** Changes requested: the revise command to run. */
  revise?: string;
}

const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Apply a plannotator review to a plan gate. Approve resolves the gate (notes go on the
 * bead); annotations record the requested changes and ask for a revise, leaving the gate
 * open; closing without a decision changes nothing.
 */
export async function applyPlanReview(ctx: WorkCtx, gateId: string, d: PlanReviewDecision): Promise<PlanReviewOutcome> {
  const g = await openGate(ctx, gateId, "usage: /work review <gate>");
  if (isDeviationGate(g)) throw new Error(`${g.id} is a deviation. Decide it with ${deviationHint(g.id)}`);
  const notes = (d.feedback ?? "").trim();
  const bead = gateBlocks(g.description);
  if (d.approved) {
    if (bead) await ctx.beads.comment(bead, `plan approved in plannotator${notes ? `: ${clip(notes)}` : ""} (gate ${g.id})`);
    await recordApproval(ctx.beads, bead, g.id, notes, "plannotator");
    await ctx.beads.resolveGate(g.id);
    return { message: `plan approved in plannotator (${g.id}${bead ? ` for ${bead}` : ""})`, runId: g.await_id };
  }
  if (d.exit || !notes) {
    return { message: `plannotator closed without a decision; ${g.id} stays open. Reopen with /work review ${g.id}, or /work approve ${g.id}.` };
  }
  if (bead) await ctx.beads.comment(bead, `plan changes requested in plannotator (gate ${g.id}):\n${clip(notes)}`);
  const plan = gatePlan(g.description);
  return {
    message: `changes requested; ${g.id} stays open.${plan ? " Revising the plan; then /work review it again." : ""}`,
    revise: plan ? `/skill:revise ${plan} ${notes}` : undefined,
  };
}

/**
 * /work reject <gate> <notes> — record requested changes and start the revise. The gate
 * stays open until the revised plan is approved.
 */
export async function workReject(ctx: WorkCtx, args: string): Promise<RejectResult> {
  const [id, ...rest] = args.trim().split(/\s+/);
  const g = await openGate(ctx, id, "usage: /work reject <gate> <notes>");
  if (isDeviationGate(g)) throw new Error(`${g.id} is a deviation. Decide it with ${deviationHint(g.id)}`);
  const notes = rest.join(" ").trim();
  if (!notes) throw new Error("say what should change: /work reject <gate> <notes>");
  const bead = gateBlocks(g.description);
  if (bead) await ctx.beads.comment(bead, `plan changes requested (gate ${g.id}): ${notes}`);
  const plan = gatePlan(g.description);
  return {
    message: [
      `recorded on ${bead ?? g.id}; ${g.id} stays open.`,
      plan ? `revising ${plan} now — approve it again with /work approve ${g.id} when it reads right.` : `revise the plan, then /work approve ${g.id}.`,
    ].join("\n"),
    revise: plan ? `/skill:revise ${plan} ${notes}` : undefined,
  };
}

/** What /work reject reports back, plus the revise to start. */
export interface RejectResult {
  message: string;
  /** `/skill:revise <plan> <notes>`, when the gate recorded a plan. */
  revise?: string;
}
