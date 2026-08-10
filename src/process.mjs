import { spawn } from "node:child_process";

export function runCommand(command, args, options = {}) {
  const { timeoutMs, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timer;
    const stdout = [];
    const stderr = [];

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };

    try {
      child = spawn(command, args, { ...spawnOptions, shell: false });
    } catch (error) {
      finish(reject, error);
      return;
    }

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      finish(resolve, {
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill();
        finish(reject, new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
    }
  });
}

export async function commandExists(command, { run = runCommand } = {}) {
  return (await run("which", [command])).code === 0;
}
