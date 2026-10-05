// Wrapper around the `bd` CLI for the store's single beads database.
//
// Rules from the M0 smoke test (research/06):
//  - parse stdout only; bd prints warnings on stderr that would corrupt JSON
//  - every bead and gate we create gets the project:<key> label explicitly
//    (children and gates do not inherit labels)
//  - one writer at a time: embedded Dolt is single-writer, so calls are queued

import { join } from "node:path";
import { bdPath } from "./bin.ts";
import { type ExecResult, run as defaultRun } from "./exec.ts";

export interface Bead {
  id: string;
  title: string;
  description?: string;
  status: string;
  issue_type: string;
  priority?: number;
  labels?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  /** Gates only: what the gate waits on; rpivw stores the run id here. */
  await_id?: string;
}

export interface BeadComment {
  author?: string;
  text: string;
  created_at?: string;
}

/** What rpivw keeps under metadata.rpiv on a bead. */
export interface RpivMeta {
  phase?: string;
  workflow?: string;
  runs?: string[];
  /** Latest artifact per bucket, store-relative: { plans: "plans/x.md" } */
  artifacts?: Record<string, string>;
  origin?: { artifact: string; section?: string };
}

export const projectLabel = (key: string) => `project:${key}`;

export const rpivMeta = (b: Bead): RpivMeta => ((b.metadata?.rpiv as RpivMeta | undefined) ?? {});

type Runner = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<ExecResult>;

export interface Beads {
  create(p: { title: string; description?: string; type?: string; labels: string[]; parent?: string }): Promise<Bead>;
  show(id: string): Promise<Bead>;
  ready(p?: { labels?: string[] }): Promise<Bead[]>;
  list(p?: { labels?: string[]; status?: string }): Promise<Bead[]>;
  claim(id: string): Promise<void>;
  /** Read-modify-write metadata.rpiv (bd merges only top-level metadata keys). */
  patchRpiv(id: string, patch: (m: RpivMeta) => RpivMeta): Promise<RpivMeta>;
  comment(id: string, text: string): Promise<void>;
  comments(id: string): Promise<BeadComment[]>;
  close(id: string, reason: string): Promise<void>;
  /** A `human` gate blocking `blocks`; labels are added after creation (bd gate create has no -l). */
  createGate(p: { blocks: string; title: string; reason: string; awaitId?: string; labels: string[] }): Promise<Bead>;
  /** All gates, open and closed (`bd list` hides gates). */
  gates(): Promise<Bead[]>;
  resolveGate(id: string): Promise<void>;
  updateLabels(id: string, add: string[], remove: string[]): Promise<void>;
}

/** `bin` defaults to the resolved bd path (src/bin.ts), looked up on first use. */
export function openBeads(storeRoot: string, runner: Runner = defaultRun, bin?: string): Beads {
  const env = { ...process.env, BEADS_DIR: join(storeRoot, ".beads") };
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => undefined);
    return p;
  };

  const raw = (args: string[]) =>
    enqueue(async () => {
      const r = await runner(bin ?? bdPath(), args, { cwd: storeRoot, env, timeoutMs: 120_000 });
      if (r.code !== 0) {
        const msg = (r.stderr || r.stdout).trim().split("\n").filter((l) => !/beads\.role|Fix:|Or:/.test(l)).pop();
        throw new Error(`bd ${args[0]} failed: ${msg ?? `exit ${r.code}`}`);
      }
      return r.stdout;
    });

  const json = async <T>(args: string[]): Promise<T> => {
    const out = await raw([...args, "--json"]);
    try {
      return JSON.parse(out) as T;
    } catch {
      throw new Error(`bd ${args[0]}: unexpected output: ${out.slice(0, 200)}`);
    }
  };
  /** bd prints `null` instead of `[]` for some empty lists (`gate list` with no gates). */
  const many = async <T>(args: string[]): Promise<T[]> => (await json<T[] | null>(args)) ?? [];
  const one = (v: Bead | Bead[]) => (Array.isArray(v) ? v[0] : v);
  const labelArgs = (labels?: string[]) => (labels ?? []).flatMap((l) => ["-l", l]);

  const show = async (id: string) => {
    const b = one(await json<Bead | Bead[]>(["show", id]));
    if (!b) throw new Error(`bead ${id} not found`);
    return b;
  };

  return {
    create: async (p) =>
      one(
        await json<Bead | Bead[]>([
          "create",
          p.title,
          "-t",
          p.type ?? "feature",
          ...(p.description ? ["-d", p.description] : []),
          ...(p.parent ? ["--parent", p.parent] : []),
          ...labelArgs(p.labels),
        ]),
      ),
    show,
    ready: async (p = {}) => many<Bead>(["ready", ...labelArgs(p.labels)]),
    list: async (p = {}) => many<Bead>(["list", ...labelArgs(p.labels), ...(p.status ? ["--status", p.status] : [])]),
    claim: async (id) => {
      await json(["update", id, "--claim"]);
    },
    patchRpiv: async (id, patch) => {
      const current = await show(id);
      const next = patch({ ...rpivMeta(current) });
      await json(["update", id, "--metadata", JSON.stringify({ rpiv: next })]);
      return next;
    },
    comment: async (id, text) => {
      await raw(["comments", "add", id, text]);
    },
    comments: async (id) => many<BeadComment>(["comments", id]),
    close: async (id, reason) => {
      await json(["close", id, "--reason", reason]);
    },
    createGate: async (p) => {
      const g = one(
        await json<Bead | Bead[]>([
          "gate",
          "create",
          "--blocks",
          p.blocks,
          "--type",
          "human",
          "--title",
          p.title,
          "--reason",
          p.reason,
          ...(p.awaitId ? ["--await-id", p.awaitId] : []),
        ]),
      );
      if (p.labels.length) await json(["update", g.id, ...p.labels.flatMap((l) => ["--add-label", l])]);
      return { ...g, labels: [...(g.labels ?? []), ...p.labels] };
    },
    gates: async () => many<Bead>(["gate", "list", "--all", "--limit", "0"]),
    resolveGate: async (id) => {
      await raw(["gate", "resolve", id]);
    },
    updateLabels: async (id, add, remove) => {
      if (!add.length && !remove.length) return;
      await json(["update", id, ...add.flatMap((l) => ["--add-label", l]), ...remove.flatMap((l) => ["--remove-label", l])]);
    },
  };
}

/** A short, single-line title from a brief: first line, cut at a word boundary. */
export function titleFromBrief(brief: string, max = 80): string {
  const first = brief.trim().split(/\r?\n/)[0].trim();
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}
