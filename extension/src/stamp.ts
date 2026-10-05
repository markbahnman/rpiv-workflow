// Envelope stamping (M3): after each stage, add an `rpivw:` block to the front
// matter of the markdown artifacts it produced:
//
//   rpivw:
//     id: art_01K9Z3X5W2…      stable identity, written once
//     work: rw-5b3              bead
//     run: 2026-10-04_…         run that last wrote it
//     workflow: build-gated     rpiv workflow
//
// One namespaced block, so rpiv's own keys are never touched and a future rpiv
// key can't collide. rpiv's contract schemas are open (no skill sets
// additionalProperties: false), so the extra key passes validation.
// `revise`/`amend` may rewrite a plan and drop the block; the stamper then
// recovers the id from the store's last committed version of the file.

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export interface Stamp {
  work?: string;
  run: string;
  workflow: string;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `art_` + a ULID: 10 time chars + 16 random chars, Crockford base32 (sortable by creation time). */
export function newArtifactId(now = Date.now()): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return `art_${time}${rand}`;
}

interface Split {
  eol: string;
  fm: string[];
  body: string;
}

function split(text: string): Split | undefined {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end < 0) return undefined;
  return { eol, fm: lines.slice(1, end), body: lines.slice(end + 1).join(eol) };
}

/** The `rpivw.id` in a document's front matter, if any. */
export function readStampId(text: string): string | undefined {
  const s = split(text);
  if (!s) return undefined;
  const i = s.fm.indexOf("rpivw:");
  if (i < 0) return undefined;
  for (let j = i + 1; j < s.fm.length && /^\s+\S/.test(s.fm[j]); j++) {
    const m = s.fm[j].match(/^\s+id:\s*(\S+)\s*$/);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Replace (or add) the `rpivw:` block. Returns undefined when the text has no
 * front matter; rpivw never invents front matter for a document.
 */
export function applyStamp(text: string, stamp: Stamp & { id: string }): string | undefined {
  const s = split(text);
  if (!s) return undefined;
  const fm: string[] = [];
  for (let i = 0; i < s.fm.length; i++) {
    if (s.fm[i] === "rpivw:") {
      while (i + 1 < s.fm.length && /^\s+\S/.test(s.fm[i + 1])) i++;
      continue;
    }
    fm.push(s.fm[i]);
  }
  fm.push("rpivw:", `  id: ${stamp.id}`);
  if (stamp.work) fm.push(`  work: ${stamp.work}`);
  fm.push(`  run: ${stamp.run}`, `  workflow: ${stamp.workflow}`);
  return ["---", ...fm, "---", s.body].join(s.eol);
}

/**
 * Stamp one file in place. `previousId` recovers a dropped id (e.g. from the
 * store's last commit). Returns the id, or undefined if the file was skipped.
 */
export function stampFile(path: string, stamp: Stamp, previousId?: () => string | undefined): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const id = readStampId(text) ?? previousId?.() ?? newArtifactId();
  const next = applyStamp(text, { ...stamp, id });
  if (next === undefined) return undefined;
  if (next !== text) writeFileSync(path, next);
  return id;
}
