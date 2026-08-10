import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.mjs";
import { V2wError } from "../src/errors.mjs";

const usage = "Usage: v2w <youtube-url-or-local-file> [--output <directory>]\n";

function captureIo({ env = {}, cwd = "/work" } = {}) {
  const stdout = [];
  const stderr = [];
  return {
    io: {
      stdout: { write: (value) => stdout.push(String(value)) },
      stderr: { write: (value) => stderr.push(String(value)) },
      env,
      cwd,
    },
    stdout,
    stderr,
  };
}

function runExecutable(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../bin/v2w.mjs", import.meta.url)),
      ...args,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("prints exact help without running the pipeline", async () => {
  const capture = captureIo();
  const code = await runCli(["--help"], capture.io, async () => {
    throw new Error("must not run");
  });

  assert.equal(code, 0);
  assert.equal(capture.stdout.join(""), usage);
  assert.equal(capture.stderr.join(""), "");
});

test("passes parsed input, output, cwd, and env to the pipeline", async () => {
  const capture = captureIo({ env: { V2W_DEBUG: "0" }, cwd: "/chosen/work" });
  const received = [];

  const code = await runCli(
    ["clip.mov", "--output", "site"],
    capture.io,
    async (options) => { received.push(options); },
  );

  assert.equal(code, 0);
  assert.deepEqual(received, [{
    input: "clip.mov",
    output: "site",
    cwd: "/chosen/work",
    env: { V2W_DEBUG: "0" },
  }]);
  assert.equal(capture.stdout.join(""), "");
  assert.equal(capture.stderr.join(""), "");
});

test("maps usage errors to exit 2 and prints usage on stderr", async () => {
  const capture = captureIo();
  const code = await runCli([], capture.io, async () => {
    throw new Error("must not run");
  });

  assert.equal(code, 2);
  assert.match(capture.stderr.join(""), /Expected exactly one YouTube URL or local video path/);
  assert.ok(capture.stderr.join("").endsWith(usage));
  assert.equal(capture.stderr.join("").includes("at "), false);
});

test("uses a V2wError exit code and hides its stack by default", async () => {
  const capture = captureIo();
  const code = await runCli(["clip.mov"], capture.io, async () => {
    throw new V2wError("controlled failure", { exitCode: 7 });
  });

  assert.equal(code, 7);
  assert.equal(capture.stderr.join(""), "controlled failure\n");
});

test("maps unexpected errors to exit 1 and only shows stacks in debug mode", async () => {
  const ordinary = captureIo();
  assert.equal(await runCli(["clip.mov"], ordinary.io, async () => {
    throw new Error("boom");
  }), 1);
  assert.equal(ordinary.stderr.join(""), "boom\n");

  const debug = captureIo({ env: { V2W_DEBUG: "1" } });
  assert.equal(await runCli(["clip.mov"], debug.io, async () => {
    throw new Error("debug boom");
  }), 1);
  assert.match(debug.stderr.join(""), /^Error: debug boom\n\s+at /);
});

test("the executable exposes help and usage exit behavior", async () => {
  const help = await runExecutable(["--help"]);
  assert.deepEqual(help, { code: 0, stdout: usage, stderr: "" });

  const missing = await runExecutable([]);
  assert.equal(missing.code, 2);
  assert.ok(missing.stderr.endsWith(usage));
});
