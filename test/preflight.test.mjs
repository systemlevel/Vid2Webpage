import assert from "node:assert/strict";
import test from "node:test";

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { defaultCacheRoot, preflight } from "../src/preflight.mjs";
import { DependencyError } from "../src/errors.mjs";

test("preflight accepts MLX and requires yt-dlp only for YouTube", async () => {
  const run = async (_command, args) => ({
    code: ["ffmpeg", "ffprobe", "mlx_whisper"].includes(args[0]) ? 0 : 1,
    stdout: "",
    stderr: "",
  });
  assert.deepEqual(
    await preflight("local", { run, cacheRoot: "/cache" }),
    {
      mlx: true,
      whisperCpp: false,
      whisperModelPath: "/cache/models/ggml-large-v3-turbo.bin",
    }
  );
  await assert.rejects(preflight("youtube", { run, cacheRoot: "/cache" }), DependencyError);
});

test("cache root honors XDG_CACHE_HOME", () => {
  assert.equal(
    defaultCacheRoot({ env: { XDG_CACHE_HOME: "/xdg" }, homedir: "/home/me" }),
    "/xdg/v2w"
  );
});

test("cache root falls back to the user's cache directory", () => {
  assert.equal(
    defaultCacheRoot({ env: {}, homedir: "/home/me" }),
    "/home/me/.cache/v2w"
  );
});

test("preflight accepts a ready Whisper-C++ model when MLX is unavailable", async (t) => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "v2w-cache-"));
  t.after(() => rm(cacheRoot, { recursive: true, force: true }));
  const modelPath = path.join(cacheRoot, "models", "ggml-large-v3-turbo.bin");
  await mkdir(path.dirname(modelPath));
  await writeFile(modelPath, "model");
  const run = async (_command, args) => ({
    code: ["ffmpeg", "ffprobe", "whisper-cli"].includes(args[0]) ? 0 : 1,
    stdout: "",
    stderr: "",
  });

  assert.deepEqual(await preflight("local", { run, cacheRoot }), {
    mlx: false,
    whisperCpp: true,
    whisperModelPath: modelPath,
  });
});

test("preflight rejects when no timed Whisper engine is ready", async () => {
  const run = async (_command, args) => ({
    code: ["ffmpeg", "ffprobe"].includes(args[0]) ? 0 : 1,
    stdout: "",
    stderr: "",
  });

  await assert.rejects(
    preflight("local", { run, cacheRoot: "/missing-cache" }),
    /No timed Whisper engine is ready/
  );
});
