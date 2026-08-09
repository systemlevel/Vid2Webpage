import assert from "node:assert/strict";
import test from "node:test";

import { commandExists, runCommand } from "../src/process.mjs";

test("runCommand preserves literal arguments without a shell", async () => {
  const result = await runCommand(process.execPath, [
    "-e",
    "process.stdout.write(process.argv[1])",
    "value with spaces;$(ignored)",
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "value with spaces;$(ignored)");
});

test("runCommand resolves non-zero exits and captures stderr", async () => {
  const result = await runCommand(process.execPath, [
    "-e",
    "process.stderr.write('failed'); process.exit(7)",
  ]);
  assert.deepEqual(result, { code: 7, stdout: "", stderr: "failed" });
});

test("runCommand rejects a command that exceeds its timeout", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
      timeoutMs: 10,
    }),
    /timed out/
  );
});

test("commandExists returns the supplied runner's result", async () => {
  const run = async (_command, args) => ({
    code: args[0] === "present" ? 0 : 1,
    stdout: "",
    stderr: "",
  });
  assert.equal(await commandExists("present", { run }), true);
  assert.equal(await commandExists("missing", { run }), false);
});
