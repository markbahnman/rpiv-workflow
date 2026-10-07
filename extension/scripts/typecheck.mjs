// `npm run typecheck`: tsc --noEmit over the extension, its sources, and its tests.
//
// The extension imports Pi's API and typebox, which live in Pi's install, not here
// (no dependencies). This script finds that install, writes a throwaway tsconfig that
// maps those two imports to their type entry points, and runs tsc on it.
//
// Pi's node_modules: $PI_NODE_MODULES, else the managed install
// (<agent dir>/install/releases/<current-version>/node_modules), else the folder that
// holds the `pi` on PATH. tsc: the one on PATH, else `npx -y -p typescript tsc`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ext = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI_PKG = join("@earendil-works", "pi-coding-agent");
const isWin = process.platform === "win32";

function agentDir() {
  const d = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!d) return join(homedir(), ".pi", "agent");
  return d === "~" ? homedir() : /^~[\\/]/.test(d) ? join(homedir(), d.slice(2)) : d;
}

function onPath(names) {
  for (const d of (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  }
  return undefined;
}

/** The node_modules folder that holds Pi's package. */
function piNodeModules() {
  const candidates = [];
  if (process.env.PI_NODE_MODULES) candidates.push(process.env.PI_NODE_MODULES);
  try {
    const v = readFileSync(join(agentDir(), "install", "current-version"), "utf8").trim();
    candidates.push(join(agentDir(), "install", "releases", v, "node_modules"));
  } catch {}
  const pi = onPath(isWin ? ["pi.cmd", "pi.exe", "pi"] : ["pi"]);
  if (pi) {
    // Walk up from the launcher (resolved through symlinks) to a node_modules with Pi in it.
    for (let d = dirname(realpathSync(pi)); d !== dirname(d); d = dirname(d)) {
      candidates.push(join(d, "node_modules"), d.endsWith("node_modules") ? d : join(d, "lib", "node_modules"));
    }
  }
  return candidates.find((c) => existsSync(join(c, PI_PKG, "package.json")));
}

/** A package's type entry point, from its package.json. */
function typesOf(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const dot = pkg.exports?.["."];
  const rel = pkg.types ?? pkg.typings ?? (typeof dot === "object" ? (dot.types ?? dot.import?.types) : undefined);
  if (!rel) throw new Error(`no type entry point in ${dir}/package.json`);
  return join(dir, rel);
}

const nm = piNodeModules();
if (!nm) {
  console.error("typecheck: can't find Pi's node_modules. Set PI_NODE_MODULES to the folder that holds @earendil-works/pi-coding-agent.");
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), "rpivw-typecheck-"));
const config = join(tmp, "tsconfig.json");
writeFileSync(
  config,
  JSON.stringify(
    {
      compilerOptions: {
        target: "esnext",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        // Node runs these files by type stripping: no enums, namespaces, or parameter properties.
        erasableSyntaxOnly: true,
        skipLibCheck: true,
        types: ["node"],
        typeRoots: [join(nm, "@types")],
        paths: {
          "@earendil-works/pi-coding-agent": [typesOf(join(nm, PI_PKG))],
          typebox: [typesOf(join(nm, "typebox"))],
        },
      },
      include: [join(ext, "index.ts"), join(ext, "src", "**", "*.ts"), join(ext, "test", "**", "*.ts")],
    },
    null,
    2,
  ),
);

const tsc = onPath(isWin ? ["tsc.cmd", "tsc.exe", "tsc"] : ["tsc"]);
const [cmd, args] = tsc ? [tsc, ["-p", config]] : ["npx", ["-y", "-p", "typescript", "tsc", "-p", config]];
console.log(`typecheck: Pi types from ${nm}`);
// .cmd shims need a shell on Windows; the arguments are paths we built, not user input.
const r = spawnSync(cmd, args, { stdio: "inherit", shell: isWin });
rmSync(tmp, { recursive: true, force: true });
process.exit(r.status ?? 1);
