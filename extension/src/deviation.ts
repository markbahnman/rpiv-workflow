// The work_deviation tool's logic (M3). The Pi tool wrapper lives in index.ts
// (it needs typebox, which only Pi's loader provides); this module is plain TS.
//
// Called by the model inside an rpiv stage child session (usually implement) when
// the plan doesn't match reality. Minor deviations are logged on the bead (and
// notify the driver while config deviations.minor = "notify"). Major deviations
// also open a `human` gate for the run; the deviation-check stage after implement
// halts the run until the driver decides.

import { type Beads, projectLabel } from "./beads.ts";
import { DEVIATION_LABEL, deviationHint } from "./gates.ts";

export interface DeviationInput {
  severity: "minor" | "major";
  found: string;
  impact: string;
  proposal: "continue" | "revise";
  phase?: string;
}

export interface DeviationDeps {
  beads?: Beads;
  /** Run this session belongs to (rpiv child sessions know it from their session dir). */
  runId?: string;
  /** Bead and project for the run. */
  link(runId: string): Promise<{ bead?: string; projectKey?: string }>;
  minorPolicy: "notify" | "log";
  notify(msg: string, level?: "info" | "warning" | "error"): void;
}

export interface DeviationResult {
  /** Text returned to the model. */
  text: string;
  gateId?: string;
}

export async function recordDeviation(input: DeviationInput, deps: DeviationDeps): Promise<DeviationResult> {
  if (!deps.runId || !deps.beads) {
    return { text: "No tracked rpiv run in this session, so nothing was recorded. Tell the user about the deviation directly." };
  }
  const { bead, projectKey } = await deps.link(deps.runId);
  if (!bead) {
    return { text: `Run ${deps.runId} isn't linked to a bead, so nothing was recorded. Tell the user about the deviation directly.` };
  }
  const where = input.phase ? ` [phase ${input.phase}]` : "";
  const line = `deviation(${input.severity})${where}, run ${deps.runId}: found: ${input.found} | impact: ${input.impact} | proposal: ${input.proposal}`;
  await deps.beads.comment(bead, line);

  if (input.severity === "minor") {
    if (deps.minorPolicy === "notify") deps.notify(`rpivw: minor deviation on ${bead}${where}: ${input.found}`, "info");
    return { text: "Recorded as a minor deviation. Continue implementing; note the change in your summary." };
  }

  const title = (await deps.beads.show(bead)).title;
  const gate = await deps.beads.createGate({
    blocks: bead,
    title: `Deviation: ${title}`,
    reason: `${input.found.replace(/\s+/g, " ").slice(0, 200)} (run ${deps.runId})`,
    awaitId: deps.runId,
    labels: [DEVIATION_LABEL, ...(projectKey ? [projectLabel(projectKey)] : [])],
  });
  deps.notify(`rpivw: major deviation on ${bead}${where}: ${input.found}\n${deviationHint(gate.id)}`, "warning");
  return {
    gateId: gate.id,
    text: [
      `Major deviation recorded (gate ${gate.id}). Stop implementing now: do not make further changes for the remaining plan.`,
      "End your turn with a short summary of what you found, what you already changed, and what you'd change in the plan.",
      "The run will pause after this stage until the user decides whether to continue or revise the plan and re-implement.",
    ].join(" "),
  };
}
