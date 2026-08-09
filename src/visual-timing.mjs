import { runCommand } from "./process.mjs";

function uniqueSortedMilliseconds(seconds) {
  return [...new Set(seconds.map((value) => Math.round(value * 1000)))].sort((a, b) => a - b);
}

export function parseSceneTimes(stderr) {
  const seconds = [...stderr.matchAll(/\bpts_time:([-+]?\d+(?:\.\d+)?)/g)]
    .map((match) => Number(match[1]));
  return uniqueSortedMilliseconds(seconds);
}

export async function detectSceneChanges(videoPath, { run = runCommand } = {}) {
  const result = await run("ffmpeg", [
    "-hide_banner",
    "-i", videoPath,
    "-filter:v", "select=gt(scene\\,0.30),showinfo",
    "-an",
    "-f", "null",
    "-",
  ]);
  if (result.code !== 0) {
    throw new Error(`Unable to detect scene changes: ${videoPath}`);
  }
  return parseSceneTimes(result.stderr);
}

export async function listFrameTimestamps(videoPath, { run = runCommand } = {}) {
  const result = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_frames",
    "-show_entries", "frame=best_effort_timestamp_time",
    "-of", "csv=p=0",
    videoPath,
  ]);
  if (result.code !== 0) {
    throw new Error(`Unable to list decoded frame timestamps: ${videoPath}`);
  }
  const seconds = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
  const frameTimes = uniqueSortedMilliseconds(seconds);
  if (frameTimes.length === 0) {
    throw new Error(`No decoded frame timestamps found: ${videoPath}`);
  }
  return frameTimes;
}
