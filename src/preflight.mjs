import os from "node:os";
import path from "node:path";

import { DependencyError } from "./errors.mjs";
import { isNonEmptyFile } from "./fs.mjs";
import { commandExists, runCommand } from "./process.mjs";

export function defaultCacheRoot({ env = process.env, homedir = os.homedir() } = {}) {
  return path.join(
    env.XDG_CACHE_HOME || path.join(homedir, ".cache"),
    "v2w"
  );
}

export async function preflight(
  kind,
  { run = runCommand, cacheRoot = defaultCacheRoot() } = {}
) {
  const required = kind === "youtube"
    ? ["ffmpeg", "ffprobe", "yt-dlp"]
    : ["ffmpeg", "ffprobe"];

  for (const command of required) {
    if (!(await commandExists(command, { run }))) {
      throw new DependencyError(
        command + " is required" +
          (command === "ffmpeg" || command === "ffprobe"
            ? " — install with: brew install ffmpeg"
            : " — install with: brew install yt-dlp")
      );
    }
  }

  const mlx = await commandExists("mlx_whisper", { run });
  const whisperCli = await commandExists("whisper-cli", { run });
  const whisperModelPath = path.join(
    cacheRoot,
    "models",
    "ggml-large-v3-turbo.bin"
  );
  const whisperCpp = whisperCli && (await isNonEmptyFile(whisperModelPath));
  if (!mlx && !whisperCpp) {
    throw new DependencyError(
      "No timed Whisper engine is ready — install MLX Whisper with: uv tool install mlx-whisper"
    );
  }
  return { mlx, whisperCpp, whisperModelPath };
}
