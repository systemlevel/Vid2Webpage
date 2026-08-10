import { lstat } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "../../src/process.mjs";

function fileSnapshot(info) {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    nlink: info.nlink,
    isFile: info.isFile(),
    isSymbolicLink: info.isSymbolicLink(),
  };
}

function isScreenshotCommand(command, args) {
  return command === "ffmpeg"
    && args.includes("-frames:v")
    && path.extname(args.at(-1)).toLowerCase() === ".jpg";
}

export function createObservedRealRunner({ run: delegate = runCommand } = {}) {
  const invocations = [];
  const run = async (command, args, options) => {
    const outputPath = args.at(-1);
    const screenshot = isScreenshotCommand(command, args);
    const stageBefore = screenshot
      ? fileSnapshot(await lstat(outputPath))
      : undefined;
    const result = await delegate(command, args, options);
    const stageAfter = screenshot
      ? fileSnapshot(await lstat(outputPath))
      : undefined;
    invocations.push({
      command,
      args: [...args],
      code: result.code,
      outputPath,
      stageBefore,
      stageAfter,
    });
    return result;
  };
  return { run, invocations };
}

export async function createFixtureVideo(directory, { run = runCommand } = {}) {
  const outputPath = path.join(directory, "hard-cuts.mp4");
  const result = await run("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "color=c=red:s=640x360:r=10:d=2",
    "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=10:d=2",
    "-f", "lavfi", "-i", "color=c=green:s=640x360:r=10:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=6",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]", "-map", "3:a",
    "-c:v", "mpeg4", "-q:v", "2",
    "-c:a", "aac", "-shortest",
    outputPath,
  ]);
  const output = result.code === 0 ? await lstat(outputPath) : null;
  if (result.code !== 0 || !output?.isFile() || output.size === 0) {
    throw new Error(`Unable to create FFmpeg fixture: ${result.stderr}`);
  }
  return outputPath;
}
