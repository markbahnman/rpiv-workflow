import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/exec.ts";

test("run never throws when the child can't be spawned at all", async () => {
  // An over-long argv makes execFile throw SYNCHRONOUSLY (Windows ENAMETOOLONG; POSIX
  // reports E2BIG through the callback). Either way `run` must resolve in its {code,
  // stderr} shape so callers can add their tool prefix ("bd comments failed: …").
  const r = await run(process.execPath, ["--version", "x".repeat(40_000)]);

  assert.notEqual(r.code, 0, "an unspawnable child is a failure, not a success");
  assert.ok(r.stderr.length > 0, "the spawn error reaches the caller as stderr");
  assert.equal(r.stdout, "");
});

test("run reports a normal child's exit and output", async () => {
  const r = await run(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"]);

  assert.equal(r.code, 0);
  assert.equal(r.stdout, "out");
  assert.equal(r.stderr, "err");
});
