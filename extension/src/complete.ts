// Tab completion for `/work`.
//
// Pi's contract (pi-tui autocomplete.js): getArgumentCompletions receives the whole
// argument text after "/work " and each item's `value` REPLACES that whole text.
// Pi doesn't filter argument items itself, so filtering happens here. Values that
// expect another word end with a space so typing can continue.

import type { Bead } from "./beads.ts";
import { rpivMeta } from "./beads.ts";

export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

export const SUBCOMMANDS: { name: string; hint: string }[] = [
  { name: "new", hint: 'create a bead: "<brief>" [--type …] [--parent <bead>]' },
  { name: "next", hint: "in-progress and ready beads [--all]" },
  { name: "start", hint: "claim a bead and run /wf for it" },
  { name: "status", hint: "store/project state, or one bead" },
  { name: "review", hint: "open a waiting plan (plannotator, file link, changes)" },
  { name: "approve", hint: "approve a plan and resume its run" },
  { name: "reject", hint: "request plan changes" },
  { name: "why", hint: "why the last run stopped, and what to fix [<run-id>]" },
  { name: "init", hint: "register this repo [name] [--migrate] [--git]" },
  { name: "mount", hint: "re-create the .rpiv/artifacts link" },
  { name: "sync", hint: "push the store (git + beads)" },
  { name: "setup", hint: "create or join the store [--remote <url>] [--prefix rw]" },
];

export const WORKFLOWS = [
  { name: "ship", hint: "small task: one forward pass" },
  { name: "build", hint: "sliced feature: parallel design, plan gate" },
  { name: "vet", hint: "review existing changes, fix loop" },
  { name: "polish", hint: "architecture review driven" },
];

const TYPES = ["feature", "bug", "task", "chore", "epic"];
const MAX = 30;

const describe = (b: Bead) => {
  const phase = rpivMeta(b).phase;
  return `${b.issue_type} · ${b.status}${phase && phase !== "done" ? ` · ${phase}` : ""} · ${b.title}`;
};

/** IDs whose prefix matches first, then title matches; `partial` is case-insensitive. */
export function matchBeads(beads: Bead[], partial: string): Bead[] {
  const p = partial.toLowerCase();
  if (!p) return beads.slice(0, MAX);
  const byId = beads.filter((b) => b.id.toLowerCase().startsWith(p));
  const byTitle = beads.filter((b) => !byId.includes(b) && b.title.toLowerCase().includes(p));
  return [...byId, ...byTitle].slice(0, MAX);
}

const beadItems = (head: string, beads: Bead[], partial: string, trailing = ""): CompletionItem[] =>
  matchBeads(beads, partial).map((b) => ({ value: `${head}${b.id}${trailing}`, label: b.id, description: describe(b) }));

const wordItems = (head: string, words: { name: string; hint?: string }[], partial: string, trailing = " "): CompletionItem[] =>
  words
    .filter((w) => w.name.startsWith(partial.toLowerCase()))
    .map((w) => ({ value: `${head}${w.name}${trailing}`, label: w.name, ...(w.hint ? { description: w.hint } : {}) }));

/**
 * `beads`: this project's beads (any status except gates), or undefined when they
 * aren't available. Bead suggestions are then simply omitted.
 */
export function completeWork(argText: string, beads: Bead[] | undefined, gates: Bead[] = []): CompletionItem[] {
  // Split into finished words and the word being typed (empty after a trailing space).
  const parts = argText.split(" ");
  const partial = parts.pop() ?? "";
  const done = parts.filter(Boolean);
  const head = parts.length ? `${parts.join(" ")} ` : "";
  const sub = done[0];

  if (!sub) return wordItems("", SUBCOMMANDS.map((s) => ({ name: s.name, hint: s.hint })), partial);

  const workable = (beads ?? []).filter((b) => b.issue_type !== "gate");
  const prev = done[done.length - 1];

  switch (sub) {
    case "status":
      if (done.length === 1) return beadItems(head, workable, partial);
      return [];
    case "start": {
      // In-progress beads already have a run; resume it with /wf @<run> instead of starting another.
      const startable = workable.filter((b) => b.status !== "closed" && b.status !== "in_progress" && b.issue_type !== "epic");
      if (done.length === 1) return beadItems(head, startable, partial, " ");
      if (done.length === 2 && !partial.startsWith("-")) return wordItems(head, WORKFLOWS, partial);
      return wordItems(head, [{ name: "--force", hint: "start despite project/epic checks" }], partial, "");
    }
    case "new":
      if (prev === "--type") return wordItems(head, TYPES.map((t) => ({ name: t })), partial);
      if (prev === "--parent") {
        const open = workable.filter((b) => b.status !== "closed");
        const epicsFirst = [...open.filter((b) => b.issue_type === "epic"), ...open.filter((b) => b.issue_type !== "epic")];
        return beadItems(head, epicsFirst, partial, " ");
      }
      if (partial.startsWith("-")) {
        return wordItems(head, [{ name: "--type", hint: "feature|bug|task|chore|epic" }, { name: "--parent", hint: "child of an epic or bead" }], partial);
      }
      return [];
    case "review":
    case "approve":
    case "reject": {
      if (sub === "approve" && done.length >= 2 && partial.startsWith("-")) {
        return wordItems(head, [{ name: "--reimplement", hint: "deviation gates: re-run implement after revising the plan" }], partial);
      }
      if (done.length !== 1) return [];
      const open = gates.filter((g) => g.status !== "closed");
      return matchBeads(open, partial).map((g) => ({ value: `${head}${g.id} `, label: g.id, description: g.title }));
    }
    case "next":
      return wordItems(head, [{ name: "--all", hint: "every project" }], partial, "");
    case "setup":
      return partial.startsWith("-")
        ? wordItems(head, [{ name: "--remote", hint: "git URL: an empty repo, or an existing store to join" }, { name: "--prefix", hint: "bead id prefix (default rw)" }], partial, " ")
        : [];
    case "init":
      return partial.startsWith("-")
        ? wordItems(head, [{ name: "--git", hint: "create the git repo without asking" }, { name: "--migrate", hint: "move an existing .rpiv/artifacts into the store" }], partial, " ")
        : [];
    default:
      return [];
  }
}
