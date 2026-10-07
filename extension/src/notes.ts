// What the driver said at a gate, carried into the artifact the next stage reads.
//
// `/work approve <gate> [notes]` and plannotator's Approve record the notes on the bead
// (metadata.rpiv.approvals). On the resume, the stage that took the decision appends them
// once to the plan the gate recorded, so the implement lane picks them up as part of its
// input. A marker comment (`<!-- rpivw:notes <gate> -->`) is the record that a gate's
// notes are already in the file: rpiv resume re-runs the halted stage, so this has to be
// idempotent.
//
// The "why" of a revision stays in the store's commit message and the bead comments
// (research 05, M3). What lands in the plan body is only the instruction to implement.

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface GateNotes {
  gate: string;
  kind: "approval" | "deviation";
  notes: string;
  /** ISO timestamp of the decision. */
  at: string;
  /** Where the decision came from: "approve" (the command) or "plannotator". */
  via?: string;
}

export const notesMarker = (gate: string) => `<!-- rpivw:notes ${gate} -->`;

/** The section appended to a plan: marked, dated, and addressed to the implementer. */
export function notesSection(n: GateNotes): string {
  const what = n.kind === "approval" ? "plan gate" : "deviation gate";
  const when = n.at.slice(0, 16).replace("T", " ");
  return [
    notesMarker(n.gate),
    `## Reviewer notes (${what} ${n.gate}, ${when}${n.via ? ` via ${n.via}` : ""})`,
    "",
    "Honor these notes when implementing. Where they conflict with the plan above, they win.",
    "",
    n.notes.trim(),
    "",
  ].join("\n");
}

/**
 * Append a gate's notes to a plan once. `path` is the plan as the gate recorded it
 * (often `.rpiv/artifacts/plans/x.md`), resolved against `cwd` when relative.
 */
export function appendGateNotes(path: string, cwd: string, n: GateNotes): "appended" | "present" | "missing" | "empty" {
  if (!n.notes.trim()) return "empty";
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  let body: string;
  try {
    body = readFileSync(abs, "utf8");
  } catch {
    return "missing";
  }
  if (body.includes(notesMarker(n.gate))) return "present";
  const sep = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(abs, `${body}${sep}${notesSection(n)}`);
  return "appended";
}
