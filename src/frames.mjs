import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

import { SourceError } from "./errors.mjs";
import { isNonEmptyFile } from "./fs.mjs";
import { runCommand } from "./process.mjs";

function frameError(filePath, message, cause) {
  return new SourceError(`${message}: ${filePath}`, { cause });
}

function safeFramePath(imagesDir, filename) {
  if (typeof imagesDir !== "string" || imagesDir.length === 0
    || typeof filename !== "string" || filename.length === 0
    || path.isAbsolute(filename)
    || filename !== path.basename(filename)
    || path.extname(filename).toLowerCase() !== ".jpg"
    || filename.includes("/")
    || filename.includes("\\")) {
    throw frameError(String(filename), "Frame filename is not a safe JPEG basename");
  }

  const resolvedImagesDir = path.resolve(imagesDir);
  const finalPath = path.resolve(imagesDir, filename);
  if (!finalPath.startsWith(`${resolvedImagesDir}${path.sep}`)) {
    throw frameError(filename, "Frame filename escapes the images directory");
  }
  return finalPath;
}

async function createOwnedTemp(finalPath) {
  const parsed = path.parse(finalPath);
  for (;;) {
    const tempPath = path.join(
      parsed.dir,
      `${parsed.name}.part-${process.pid}-${randomUUID()}.jpg`,
    );
    try {
      const handle = await open(tempPath, "wx");
      try {
        await handle.close();
      } catch (error) {
        await rm(tempPath, { force: true });
        throw error;
      }
      return tempPath;
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
  }
}

function completedFrame(capture, { width, height }) {
  return {
    requestedMs: capture.requestedMs,
    timestampMs: capture.timestampMs,
    reasons: capture.reasons,
    associations: capture.associations,
    filename: capture.filename,
    width,
    height,
  };
}

export function buildFrameArgs({ videoPath, timestampMs, outputPath }) {
  return [
    "-y",
    "-ss", (timestampMs / 1000).toFixed(3),
    "-i", videoPath,
    "-map", "0:v:0",
    "-frames:v", "1",
    "-q:v", "2",
    "-update", "1",
    outputPath,
  ];
}

export async function probeImageDimensions(imagePath, { run = runCommand } = {}) {
  let result;
  try {
    result = await run("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "json",
      imagePath,
    ]);
  } catch (error) {
    throw frameError(imagePath, "Unable to inspect extracted frame", error);
  }
  if (result?.code !== 0) {
    throw frameError(imagePath, "Unable to inspect extracted frame");
  }

  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (error) {
    throw frameError(imagePath, "Invalid extracted frame metadata", error);
  }
  const { width, height } = data?.streams?.[0] ?? {};
  if (!Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0) {
    throw frameError(imagePath, "Extracted frame has invalid dimensions");
  }
  return { width, height };
}

export async function extractFrames({
  videoPath,
  captures,
  workspace,
  manifest,
  run = runCommand,
  log = console,
}) {
  if (manifest?.status !== "building") {
    throw frameError(videoPath, "Frames can only be extracted into a building manifest");
  }

  let currentManifest = manifest;
  const orderedCaptures = [...captures].sort((left, right) =>
    left.timestampMs - right.timestampMs || left.filename.localeCompare(right.filename));

  for (const capture of orderedCaptures) {
    const finalPath = safeFramePath(workspace.imagesDir, capture.filename);
    if (path.resolve(videoPath) === finalPath) {
      throw frameError(videoPath, "Frame output must not overwrite the local video");
    }

    const existing = currentManifest.images.find((image) => image.filename === capture.filename);
    if (existing) {
      const reuseCandidate = completedFrame(capture, existing);
      if (await workspace.canReuseFrame(reuseCandidate)) {
        log?.info?.(`Reusing frame ${capture.filename}`);
        continue;
      }
    }

    let tempPath;
    let published = false;
    try {
      tempPath = await createOwnedTemp(finalPath);
      let result;
      try {
        result = await run("ffmpeg", buildFrameArgs({
          videoPath,
          timestampMs: capture.timestampMs,
          outputPath: tempPath,
        }));
      } catch (error) {
        throw frameError(capture.filename, "Unable to extract frame", error);
      }
      if (result?.code !== 0 || !(await isNonEmptyFile(tempPath))) {
        throw frameError(capture.filename, "Unable to extract a nonempty frame");
      }

      const dimensions = await probeImageDimensions(tempPath, { run });
      const frame = completedFrame(capture, dimensions);
      await rename(tempPath, finalPath);
      published = true;
      currentManifest = await workspace.recordFrame(currentManifest, frame);
      log?.info?.(`Extracted frame ${capture.filename}`);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw frameError(capture.filename, "Unable to publish extracted frame", error);
    } finally {
      if (tempPath && !published) await rm(tempPath, { force: true });
    }
  }

  return currentManifest;
}
