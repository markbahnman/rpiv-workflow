// rpivw — Pi extension entry point.
//
// M1: the artifact store. Mounts ~/rpivw/projects/<key>/artifacts into each
// registered checkout as .rpiv/artifacts, commits after every rpiv-workflow stage,
// archives the run trail and pushes the store when a run ends.
// M2: the beads bridge. /work new|next|start|status <bead>; runs started with
// /work start (named <bead>--r<n>) claim, track, and close their bead.
//
// Dev: pi --extension ./extension/index.ts

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type Bead, openBeads, projectLabel } from "./src/beads.ts";
import { bdInfo, resolveBd } from "./src/bin.ts";
import { completeWork } from "./src/complete.ts";
import { artifactsDir, loadConfig, projectDir, storeRoot } from "./src/config.ts";
import { git } from "./src/exec.ts";
import {
  createListeners,
  installedRpivVersion,
  registerLifecycle,
  type ResolvedProject,
  isSupportedRpiv,
  SUPPORTED_RPIV,
} from "./src/lifecycle.ts";
import { ensureLocalExclude, ensureMount, linkPath, migrateAndMount, type MountState } from "./src/mount.ts";
import { defaultName, readRegistry, type Registry, register, writeRegistry } from "./src/registry.ts";
import { generateKey, gitInit, KEY_CONFIG, pinKey, type RepoInfo, repoInfo, repoState, unsafeRepoDir } from "./src/repo.ts";
import { beadFromRunName, childRunId, readRunHeader, readRunNames, runsDir } from "./src/runs.ts";
import {
  DEVIATION_CHECK,
  type GateDeps,
  gatePlan,
  installTrackedWorkflows,
  makeDeviationCheck,
  makePlanGate,
  PLAN_GATE,
  scriptStage,
  TRACKED_BASES,
} from "./src/gates.ts";
import { recordDeviation } from "./src/deviation.ts";
import { Type } from "typebox";
import { absPlan, detectReviewTools, planDiffCommand, requestPlanGateReview, reviewLines, storePlanPath } from "./src/review.ts";
import { setupStore } from "./src/setup.ts";
import { openStore } from "./src/store.ts";
import { applyPlanReview, isDeviationGate, openGates, parseArgs, type WorkCtx, workApprove, workBeadStatus, workInProgress, workNew, workNext, workReject, workStart } from "./src/work.ts";

type Notify = (msg: string, level?: "info" | "warning" | "error") => void;

// Survives /reload: the previous runtime's listener bundle is disposed before a new one is added.
const DISPOSE_KEY = Symbol.for("rpivw:lifecycle-dispose");
// The launcher's notify, for tools running in rpiv stage child sessions.
const NOTIFY_KEY = Symbol.for("rpivw:launcher-notify");

const USAGE = [
  '/work new "<brief>" [--type feature|bug|task|chore|epic] [--parent <bead>]   create a bead for this project',
  "/work next [--all]                 in-progress and ready beads (this project, or all)",
  "/work start <bead> [ship|build]    claim the bead and run /wf for it (run named <bead>--r<n>)",
  "/work status [<bead>]              store/project state, or one bead's phase, runs, artifacts, notes",
  "/work review [<gate>]              open a plan waiting for approval (plannotator if installed, file link, hunk diff of changes)",
  "/work approve <gate> [notes] [--reimplement]  approve a plan (or decide a deviation) and resume the run",
  "/work reject <gate> <notes>        request plan changes and start /skill:revise (the gate stays open until you approve it)",
  "/work init [name] [--migrate] [--git]  register this repo (or rename it) and mount its store folder;\n                                   creates the git repo if missing (asks, or --git)",
  "/work mount                        (re)create the .rpiv/artifacts junction",
  "/work sync                         push the store (git + beads) to its remote",
  "/work setup [--remote <git-url>] [--prefix rw]  create the store (or join an existing one) on this machine",
].join("\n");


function describeMount(m: MountState, link: string): string {
  switch (m.state) {
    case "created":
      return `mounted ${link}`;
    case "ok":
      return "mount ok";
    case "mismatch":
      return `${link} points to ${m.actual}, not the store. Remove it and run /work mount.`;
    case "conflict":
      return `${link} is a real folder with ${m.entries} item(s). Run /work init --migrate to move them into the store.`;
  }
}

const PROJECT_MD = (name: string, key: string) => `# ${name}

Store key: \`${key}\`

## Purpose

<!-- What this project is and who uses it. -->

## Stack and conventions

<!-- Languages, frameworks, how to run tests, conventions agents must follow. -->
`;

export default function rpivw(pi: ExtensionAPI) {
  const root = storeRoot();
  const store = openStore(root, { remote: () => loadConfig(root).push.remote });
  // No process starts here: openBeads only builds a wrapper; bd runs on first use.
  const beads = existsSync(join(root, ".beads")) ? openBeads(root) : undefined;

  // Warnings and errors also go to a log inside the store's .git dir (never committed),
  // so failures in listeners that outlive their session leave a trace.
  const logFile = join(root, ".git", "rpivw.log");
  const logLine = (m: string, l: string) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${l} ${m.replace(/\n/g, " | ")}\n`);
    } catch {
      // no store yet
    }
  };
  /**
   * A notifier that never throws. If `ui` belongs to a replaced session (Pi throws
   * "ctx is stale after session replacement"), fall back to the newest launcher
   * session's notifier, and failing that, the log only.
   */
  const uiNotify = (ui: { notify(m: string, l?: "info" | "warning" | "error"): void }): Notify => {
    const self: Notify = (m, l = "info") => {
      if (l !== "info") logLine(m, l);
      try {
        ui.notify(m, l);
        return;
      } catch {
        // stale ctx
      }
      const latest = (globalThis as Record<symbol, unknown>)[NOTIFY_KEY] as Notify | undefined;
      if (latest && latest !== self) {
        try {
          latest(m, l);
        } catch {
          // the log line is all we have
        }
      }
    };
    return self;
  };
  let notify: Notify = (m, l = "info") => {
    if (l !== "info") logLine(m, l);
  };

  // ---- tab completion: the completion hook gets no ctx, so remember the session cwd.
  // Bead lists come from a short-lived cache; a stale cache is served immediately and
  // refreshed in the background, so typing never waits on bd after the first lookup.
  let currentCwd = process.cwd();
  type CompletionData = { beads: Bead[]; gates: Bead[] };
  let completionCache: { key: string; at: number; data: CompletionData } | undefined;
  let refreshing: Promise<CompletionData | undefined> | undefined;
  const CACHE_MS = 15_000;

  const loadProjectBeads = async (): Promise<CompletionData | undefined> => {
    if (!beads) return undefined;
    const info = await repoInfo(currentCwd);
    if (!info || !readRegistry(root).projects[info.key]) return undefined;
    const label = projectLabel(info.key);
    const [list, gates] = await Promise.all([beads.list({ labels: [label] }), beads.gates()]);
    const data = { beads: list, gates: gates.filter((g) => g.labels?.includes(label)) };
    completionCache = { key: info.key, at: Date.now(), data };
    return data;
  };

  const beadsForCompletion = async (): Promise<CompletionData | undefined> => {
    const fresh = completionCache && Date.now() - completionCache.at < CACHE_MS;
    if (!fresh && !refreshing) {
      refreshing = loadProjectBeads()
        .catch(() => undefined)
        .finally(() => {
          refreshing = undefined;
        });
    }
    if (completionCache) return completionCache.data;
    // First lookup: wait briefly, but never hang the editor.
    return Promise.race([refreshing, new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000))]);
  };

  const resolveProject = async (cwd: string): Promise<ResolvedProject | undefined> => {
    const info = await repoInfo(cwd);
    if (!info) return undefined;
    if (!readRegistry(root).projects[info.key]) return undefined;
    if (!existsSync(linkPath(info.root))) return undefined;
    return { key: info.key, root: info.root, artifacts: artifactsDir(root, info.key) };
  };

  /**
   * /work init [name] [--migrate] [--git]
   * Creates the git repo if there is none (asks first; --git skips the question),
   * keys an empty repo, pins the key in local git config, registers, and mounts.
   */
  const initProject = async (ctx: ExtensionCommandContext, rest: string[], reg: Registry, say: Notify) => {
    const lines: string[] = [];
    let state = await repoState(ctx.cwd);

    if (state.kind === "none") {
      const dir = resolve(ctx.cwd);
      const unsafe = unsafeRepoDir(dir, root);
      if (unsafe) {
        say(`rpivw: ${dir} isn't a git repository, and I won't create one here: ${unsafe}.`, "warning");
        return;
      }
      const ok =
        rest.includes("--git") ||
        (ctx.hasUI &&
          (await ctx.ui.confirm(
            "Create a git repository?",
            `${dir} isn't a git repository. rpivw needs one (store link, worktrees, rpiv's checks). Run "git init -b main" here?`,
          )));
      if (!ok) {
        say("rpivw: not a git repository. Run /work init --git to create one here.", "warning");
        return;
      }
      await gitInit(dir);
      lines.push(`created a git repository in ${dir} (branch main, no commits)`);
      state = await repoState(dir);
    }
    if (state.kind === "none") {
      say("rpivw: git init didn't produce a repository.", "error");
      return;
    }

    const info: RepoInfo =
      state.kind === "ok"
        ? state.info
        : { root: state.root, commonDir: state.commonDir, key: generateKey(), keySource: "pin", origin: state.origin };
    if (state.kind === "unkeyed") lines.push(`no remote or commits yet: generated key ${info.key}`);
    if (info.keySource !== "pin" || state.kind === "unkeyed") {
      await pinKey(info.root, info.key);
      lines.push(`pinned the key in .git/config (${KEY_CONFIG}), so it stays stable if you add a remote later`);
    }

    const migrate = rest.includes("--migrate");
    const explicit = rest.find((r) => !r.startsWith("--"));
    const name = explicit ?? reg.projects[info.key]?.name ?? defaultName(info.key, info.root);
    const changed = register(reg, info.key, name, info.root, { rename: explicit !== undefined });
    if (changed) writeRegistry(root, reg);

    const target = artifactsDir(root, info.key);
    let mountMsg: string;
    if (migrate && existsSync(linkPath(info.root))) {
      try {
        const { moved } = migrateAndMount(info.root, target);
        mountMsg = `migrated ${moved} file(s) into the store and mounted`;
      } catch (e) {
        mountMsg = (e as Error).message;
      }
    } else mountMsg = describeMount(ensureMount(info.root, target), linkPath(info.root));

    const excluded = ensureLocalExclude(info.commonDir);
    const brief = join(projectDir(root, info.key), "project.md");
    if (!existsSync(brief)) writeFileSync(brief, PROJECT_MD(name, info.key));

    const sha = await store.commit(["registry.json", `projects/${info.key}`], `register ${info.key} (${name}) from ${basename(info.root)}`);
    say(
      [
        `rpivw: ${info.key} → ${name}`,
        ...lines,
        mountMsg,
        excluded ? "added .rpiv/ to this repo's .git/info/exclude" : ".rpiv/ already ignored locally",
        sha ? `store commit ${sha} (run /work sync to push)` : "store unchanged",
      ].join("\n"),
    );
  };

  // ---- plan review: plannotator, a file link, and a hunk diff of revisions
  const planReview = async (projectRoot: string, key: string, plan: string, gateId: string) => {
    const abs = absPlan(projectRoot, plan);
    const tools = detectReviewTools();
    const inStore = storePlanPath(artifactsDir(root, key), root, plan);
    const diff = inStore && tools.hunk ? await planDiffCommand(root, inStore).catch(() => undefined) : undefined;
    return { abs, tools, lines: reviewLines({ gateId, plan: abs, tools, storeRoot: root, diff }) };
  };

  // ---- plan-approval gate (M3)
  const gateRuns = new Map<string, string>();
  const gateDeps: GateDeps = {
    beads,
    takeRunId: (cwd) => {
      const id = gateRuns.get(cwd);
      gateRuns.delete(cwd);
      return id;
    },
    linkFor: async (cwd, runId) => {
      const p = await resolveProject(cwd);
      if (!p) return {};
      return { bead: beadFromRunName(readRunHeader(p.root, runId)?.name), projectKey: p.key };
    },
    notify: (m, l) => notify(m, l),
    reviewLines: async (cwd, plan, gateId) => {
      const p = await resolveProject(cwd);
      return p ? (await planReview(p.root, p.key, plan, gateId)).lines : [];
    },
  };

  // Set when this runtime owns the process-wide lifecycle registration.
  let ownsLifecycle = false;
  // Set inside an rpiv stage child session: the run it belongs to.
  let childRun: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    // rpiv stage children load this extension too (they share globalThis with the
    // launcher). They must not touch the launcher's lifecycle registration, mount,
    // or workflow registry; they only need to know which run they belong to.
    childRun = childRunId(ctx.sessionManager.getSessionDir());
    if (childRun) return;

    const g = globalThis as Record<symbol, unknown>;
    notify = uiNotify(ctx.ui);
    // The newest launcher session's notifier: the fallback for listeners and child
    // tools whose own ctx went stale (/new, /reload, a run ending hours later).
    g[NOTIFY_KEY] = notify;
    currentCwd = ctx.cwd;
    completionCache = undefined;

    (g[DISPOSE_KEY] as (() => void) | undefined)?.();
    ownsLifecycle = true;
    const disposeMain = registerLifecycle(
      createListeners({
        store,
        resolve: resolveProject,
        pushOnEnd: (key) => loadConfig(root, key).push.onWorkflowEnd,
        notify: (m, l) => notify(m, l),
        beads,
      }),
    );
    // Script stages don't receive the run id; onStageStart fires right before a
    // script stage's run(), so hand the id over for our gate stages.
    const disposeGate = registerLifecycle({
      onStageStart: (stage, lctx) => {
        if (stage.name === PLAN_GATE || stage.name === DEVIATION_CHECK) gateRuns.set(lctx.cwd, lctx.runId);
      },
    });
    g[DISPOSE_KEY] = () => {
      disposeMain();
      disposeGate();
    };

    const planApproval = loadConfig(root).gates.planApproval;
    installTrackedWorkflows(
      TRACKED_BASES,
      (base) => ({
        planGate: planApproval.includes(base) ? scriptStage(makePlanGate(gateDeps)) : undefined,
        deviationCheck: scriptStage(makeDeviationCheck(gateDeps)),
      }),
      {
        required: planApproval,
        onMissing: (name) => notify(`rpivw: can't track "${name}" (workflow not found, or it has no implement stage).`, "warning"),
      },
    );

    if (!existsSync(join(root, ".git"))) {
      notify(`rpivw: no store at ${root}. Run /work setup (or set RPIVW_STORE).`, "warning");
      return;
    }
    const v = installedRpivVersion();
    if (v && !isSupportedRpiv(v)) {
      notify(`rpivw: lifecycle bridge checked against rpiv-workflow ${SUPPORTED_RPIV.join(", ")}; found ${v}. Verify before relying on it.`, "warning");
    }

    const info = await repoInfo(ctx.cwd);
    if (!info || !readRegistry(root).projects[info.key]) return;
    // Projects registered before key pinning existed get pinned now, so adding a
    // remote later can't change their key. Local git config only.
    if (info.keySource !== "pin") await pinKey(info.root, info.key).catch(() => undefined);
    const m = ensureMount(info.root, artifactsDir(root, info.key));
    if (m.state !== "ok") notify(`rpivw: ${describeMount(m, linkPath(info.root))}`, m.state === "created" ? "info" : "warning");

    // A push that failed earlier (offline, auth, a run that ended after the session did)
    // leaves commits behind; say so instead of failing silently.
    const ahead = await git(root, "rev-list", "--count", "@{u}..HEAD");
    const n = ahead.code === 0 ? Number(ahead.stdout.trim()) : 0;
    if (n > 0) notify(`rpivw: ${n} store commit(s) not pushed. Run /work sync (details: ${logFile}).`, "warning");
  });

  pi.on("session_shutdown", () => {
    if (!ownsLifecycle) return; // a child shutting down must not unhook the launcher
    const g = globalThis as Record<symbol, unknown>;
    (g[DISPOSE_KEY] as (() => void) | undefined)?.();
    g[DISPOSE_KEY] = undefined;
    ownsLifecycle = false;
  });

  // ---- work_deviation (M3): the model reports that the plan doesn't match reality.
  // Active everywhere, but only records inside an rpiv stage child of a tracked run.
  pi.registerTool({
    name: "work_deviation",
    label: "Plan deviation",
    description:
      "Record that the implementation plan doesn't match reality. Use during an rpiv implement stage when a phase can't be done as planned. " +
      "minor: you can adapt within the plan's intent (it's logged; keep going). major: the plan's approach or later phases must change " +
      "(the run pauses after this stage for the user to decide; stop implementing after calling this).",
    promptSnippet: "Record a deviation from the implementation plan (minor: logged, continue; major: stop, the user decides)",
    promptGuidelines: [
      "During an rpiv implement stage, when reality contradicts the plan (missing API, wrong assumption, a phase that can't work as written), call work_deviation instead of silently improvising.",
      "Use severity minor when you can adapt within the plan's intent; use major when later phases or the approach must change. After a major deviation, stop and summarize.",
    ],
    parameters: Type.Object({
      severity: Type.Union([Type.Literal("minor"), Type.Literal("major")], { description: "minor: adapt and continue; major: stop for a decision" }),
      found: Type.String({ description: "What reality turned out to be, concretely (file, API, behavior)" }),
      impact: Type.String({ description: "Which plan phases or assumptions this changes" }),
      proposal: Type.Union([Type.Literal("continue"), Type.Literal("revise")], { description: "Continue as planned with a local fix, or revise the plan" }),
      phase: Type.Optional(Type.String({ description: "Plan phase number or name, if known" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const launcherNotify = (globalThis as Record<symbol, unknown>)[NOTIFY_KEY] as Notify | undefined;
      const result = await recordDeviation(params, {
        beads,
        runId: childRun,
        link: async (runId) => {
          const p = await resolveProject(ctx.cwd);
          if (!p) return {};
          return { bead: beadFromRunName(readRunHeader(p.root, runId)?.name), projectKey: p.key };
        },
        minorPolicy: loadConfig(root).deviations.minor,
        notify: (m, l) => (launcherNotify ?? uiNotify(ctx.ui))(m, l),
      });
      return { content: [{ type: "text", text: result.text }], details: { gateId: result.gateId } };
    },
  });

  pi.registerCommand("work", {
    description: "rpivw: work tracking (new, next, start, status, review, approve, reject) and the artifact store (init, mount, sync)",
    getArgumentCompletions: async (argText) => {
      const needsBeads = /^(status|start|review|approve|reject) |^new .*--parent /.test(argText);
      const data = needsBeads ? await beadsForCompletion() : undefined;
      return completeWork(argText, data?.beads, data?.gates);
    },
    handler: async (args, ctx) => {
      // Command output goes to this command's ctx. Long-lived listeners keep using the
      // session notifier, never a command ctx (it goes stale on /new or /reload).
      const say = uiNotify(ctx.ui);
      currentCwd = ctx.cwd;
      const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const restArgs = args.trim().slice(sub.length).trim();

      if (sub === "setup") {
        const { flags } = parseArgs(restArgs, ["remote", "prefix"]);
        if (flags.remote === true || flags.prefix === true) {
          say("usage: /work setup [--remote <git-url>] [--prefix rw]", "warning");
          return;
        }
        const r = await setupStore(root, { remote: flags.remote || undefined, prefix: flags.prefix || undefined }, resolveBd()?.path);
        say(`rpivw: ${r.lines.join("\n")}`, r.ok ? "info" : "warning");
        return;
      }

      if (sub === "sync") {
        const r = await store.push({ beads: true });
        say(`rpivw: ${r.detail}`, r.ok ? "info" : "warning");
        return;
      }

      const info = await repoInfo(ctx.cwd);
      const reg = readRegistry(root);

      if (["new", "next", "start", "review", "approve", "reject"].includes(sub) || (sub === "status" && rest.length > 0)) {
        if (!beads) {
          say(`rpivw: no beads database at ${join(root, ".beads")}. Run /work setup.`, "warning");
          return;
        }
        const entry = info ? reg.projects[info.key] : undefined;
        const wctx: WorkCtx = {
          beads,
          project: info && entry ? { key: info.key, name: entry.name } : undefined,
          projectNames: Object.fromEntries(Object.entries(reg.projects).map(([k, v]) => [k, v.name])),
          root: info?.root,
        };
        try {
          completionCache = undefined;
          if (sub === "new") say(await workNew(wctx, restArgs));
          else if (sub === "next") say(await workNext(wctx, restArgs));
          else if (sub === "status") say(await workBeadStatus(wctx, rest[0]));
          else if (sub === "reject") {
            // The command opens the revise itself: the driver asked for changes, so the plan
            // edit is the next thing they want, and /skill:revise keeps the gate's trail.
            const r = await workReject(wctx, restArgs);
            say(`rpivw: ${r.message}`);
            if (r.revise) pi.sendUserMessage(r.revise, { expandPromptTemplates: true });
          }
          else if (sub === "review") {
            if (!info) throw new Error("run /work review from the project's checkout.");
            let gate: Bead | undefined;
            if (rest[0]) gate = await beads.show(rest[0]);
            else {
              const waiting = (await openGates(wctx)).filter((g) => !isDeviationGate(g));
              if (waiting.length > 1) throw new Error(`several plans are waiting; pick one: ${waiting.map((g) => g.id).join(", ")}`);
              gate = waiting[0];
              if (!gate) throw new Error("no plan is waiting for approval in this project.");
            }
            const plan = gatePlan(gate.description);
            if (!plan || plan === "the") throw new Error(`${gate.id} doesn't record a plan path.`);
            const r = await planReview(info.root, info.key, plan, gate.id);
            if (!existsSync(r.abs)) throw new Error(`plan not found: ${r.abs}`);
            const others = r.lines.filter((l) => !l.startsWith("review:"));
            const decide = `/work approve ${gate.id} [notes]  ·  /work reject ${gate.id} <notes>`;
            if (!r.tools.plannotator) {
              say([`rpivw: plan for ${gate.id}: ${plan}`, ...others, `then: ${decide}`].join("\n"));
              return;
            }
            say(
              [
                `rpivw: opening ${plan} in plannotator.`,
                "Approve resolves the gate and resumes the run; annotations send the plan back for revision.",
                ...others,
                `or decide here: ${decide}`,
              ].join("\n"),
            );
            // Don't hold the command open while the browser is up: the decision is applied
            // whenever it arrives, through the session notifier (this command's ctx may be stale by then).
            const gateId = gate.id;
            const projectRoot = info.root;
            void requestPlanGateReview(pi.events, r.abs, readFileSync(r.abs, "utf8"))
              .then(async (res) => {
                if (res.status !== "handled") {
                  notify(`rpivw: plannotator couldn't open the plan (${res.error ?? res.status}). Decide with ${decide}`, "warning");
                  return;
                }
                completionCache = undefined;
                const out = await applyPlanReview(wctx, gateId, res.result);
                if (out.runId && existsSync(join(runsDir(projectRoot), `${out.runId}.jsonl`))) {
                  notify(`rpivw: ${out.message}; resuming run ${out.runId}`);
                  pi.sendUserMessage(`/wf @${out.runId}`, { expandPromptTemplates: true, deliverAs: "followUp" });
                } else if (out.runId) {
                  notify(`rpivw: ${out.message}. Resume the run from its checkout with /wf @${out.runId}.`);
                } else {
                  notify(`rpivw: ${out.message}`);
                  if (out.revise) pi.sendUserMessage(out.revise, { expandPromptTemplates: true, deliverAs: "followUp" });
                }
              })
              .catch((e) => notify(`rpivw: plan review: ${(e as Error).message}`, "warning"));
          }
          else if (sub === "approve") {
            const r = await workApprove(wctx, restArgs);
            const trail = r.runId && info ? join(runsDir(info.root), `${r.runId}.jsonl`) : undefined;
            if (r.runId && trail && existsSync(trail)) {
              say(`rpivw: ${r.message}; resuming run ${r.runId}`);
              pi.sendUserMessage(`/wf @${r.runId}`, { expandPromptTemplates: true });
            } else {
              say(`rpivw: ${r.message}. Resume the run from its checkout with /wf @${r.runId ?? "<run-id>"}.`);
            }
          } else {
            const plan = await workStart(wctx, restArgs, info ? readRunNames(info.root) : {});
            say(`rpivw: claimed ${plan.bead.id}; starting ${plan.workflow} as run "${plan.runName}"`);
            // Runs /wf through Pi's normal command path, so the run gets its usual detached lane.
            pi.sendUserMessage(plan.command, { expandPromptTemplates: true });
          }
        } catch (e) {
          say(`rpivw: ${(e as Error).message}`, "warning");
        }
        return;
      }

      if (sub === "status") {
        const lines = [`store: ${root}${existsSync(join(root, ".git")) ? "" : " (missing)"}`];
        const st = await git(root, "status", "--porcelain");
        lines.push(`store working tree: ${st.stdout.trim() ? `${st.stdout.trim().split("\n").length} uncommitted change(s)` : "clean"}`);
        const ahead = await git(root, "rev-list", "--count", "@{u}..HEAD");
        if (ahead.code === 0) lines.push(`unpushed store commits: ${ahead.stdout.trim()}`);
        lines.push(`rpiv-workflow: ${installedRpivVersion() ?? "not found"}`);
        const bd = bdInfo();
        lines.push(bd ? `bd: ${bd.path} (${bd.source})` : "bd: not found (install via mise, or set RPIVW_BD)");
        if (!info) {
          const s = await repoState(ctx.cwd);
          lines.push(
            s.kind === "none"
              ? "cwd: not a git repository (/work init --git creates one)"
              : "cwd: git repository with no remote or commits yet (/work init gives it a key)",
          );
        }
        else {
          const entry = reg.projects[info.key];
          lines.push(`project: ${info.key}${entry ? ` (${entry.name})` : " (not registered; run /work init)"}`);
          if (entry) lines.push(describeMount(ensureMount(info.root, artifactsDir(root, info.key)), linkPath(info.root)));
          if (entry && beads) {
            try {
              lines.push(await workInProgress({ beads, project: { key: info.key, name: entry.name }, projectNames: {} }));
            } catch (e) {
              lines.push(`beads: ${(e as Error).message}`);
            }
          }
        }
        say(lines.join("\n"));
        return;
      }

      if (sub === "init") {
        await initProject(ctx, rest, reg, say);
        return;
      }

      if (!info) {
        say("rpivw: not inside a keyed git checkout. Run /work init first.", "warning");
        return;
      }

      if (sub === "mount") {
        if (!reg.projects[info.key]) {
          say("rpivw: this repo isn't registered. Run /work init first.", "warning");
          return;
        }
        say(`rpivw: ${describeMount(ensureMount(info.root, artifactsDir(root, info.key)), linkPath(info.root))}`);
        return;
      }

      say(USAGE);
    },
  });
}
