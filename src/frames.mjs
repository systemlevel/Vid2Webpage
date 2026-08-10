import { randomUUID } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

import { SourceError } from "./errors.mjs";
import {
  fileIdentity,
  hasFileIdentity,
  isNonEmptyFile,
  pathIsOwnedRegularFile,
  pathsReferToSameFile,
} from "./fs.mjs";
import { runCommand } from "./process.mjs";

const defaultFileOps = { open, lstat, unlink };

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

function validateCaptureTimestamps(captures, videoPath) {
  if (!Array.isArray(captures)) {
    throw frameError(videoPath, "Frame captures must be an array");
  }
  for (const capture of captures) {
    const associations = capture?.associations;
    if (!Number.isSafeInteger(capture?.requestedMs) || capture.requestedMs < 0
      || !Number.isSafeInteger(capture?.timestampMs) || capture.timestampMs < 0
      || !Array.isArray(associations)
      || associations.some((association) =>
        !Number.isSafeInteger(association?.segmentIndex) || association.segmentIndex < 0
        || !Number.isSafeInteger(association?.requestedMs) || association.requestedMs < 0)) {
      throw frameError(videoPath, "Frame capture has invalid timestamps");
    }
  }
}

async function reservationStillOwned(reservation, fileOps) {
  try {
    const handleInfo = await reservation.handle.stat();
    return handleInfo.isFile()
      && hasFileIdentity(handleInfo, reservation.tempIdentity)
      && await pathIsOwnedRegularFile(reservation.tempPath, reservation.tempIdentity, {
        inspect: fileOps.lstat,
      });
  } catch {
    return false;
  }
}

async function cleanupReservation(reservation, fileOps) {
  const errors = [];
  if (await reservationStillOwned(reservation, fileOps)) {
    try {
      await fileOps.unlink(reservation.tempPath);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await reservation.handle.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Owned frame temp cleanup failed");
}

async function reserveOwnedTemp(finalPath, { nextTempId, fileOps }) {
  const parsed = path.parse(finalPath);
  for (;;) {
    const id = nextTempId();
    if (typeof id !== "string" || !/^[0-9a-f-]+$/u.test(id)) {
      throw frameError(finalPath, "Frame temp identity generator returned an invalid value");
    }
    const tempPath = path.join(parsed.dir, `${parsed.name}.part-${process.pid}-${id}.jpg`);
    let handle;
    try {
      handle = await fileOps.open(tempPath, "wx");
      const info = await handle.stat();
      if (!info.isFile()) {
        throw frameError(tempPath, "Reserved frame temp is not a regular file");
      }
      return { tempPath, tempIdentity: fileIdentity(info), handle };
    } catch (error) {
      if (!handle && error.code === "EEXIST") continue;
      if (handle) {
        const reservation = {
          tempPath,
          tempIdentity: fileIdentity(await handle.stat()),
          handle,
        };
        try {
          await cleanupReservation(reservation, fileOps);
        } catch (cleanupError) {
          throw frameError(
            tempPath,
            "Unable to reserve and clean frame temp",
            new AggregateError([error, cleanupError]),
          );
        }
      }
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

function formatTimestampMs(timestampMs) {
  const seconds = Math.floor(timestampMs / 1000);
  const milliseconds = String(timestampMs % 1000).padStart(3, "0");
  return `${seconds}.${milliseconds}`;
}

export function buildFrameArgs({ videoPath, timestampMs, outputPath }) {
  return [
    "-y",
    "-ss", formatTimestampMs(timestampMs),
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
  nextTempId = randomUUID,
  fileOps = {},
}) {
  if (manifest?.status !== "building") {
    throw frameError(videoPath, "Frames can only be extracted into a building manifest");
  }
  validateCaptureTimestamps(captures, videoPath);

  const resolvedFileOps = { ...defaultFileOps, ...fileOps };
  let currentManifest = manifest;
  const orderedCaptures = [...captures].sort((left, right) =>
    left.timestampMs - right.timestampMs || left.filename.localeCompare(right.filename));

  for (const capture of orderedCaptures) {
    const finalPath = safeFramePath(workspace.imagesDir, capture.filename);
    if (await pathsReferToSameFile(videoPath, finalPath)) {
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

    let reservation;
    let failure;
    try {
      reservation = await reserveOwnedTemp(finalPath, {
        nextTempId,
        fileOps: resolvedFileOps,
      });
      let result;
      try {
        result = await run("ffmpeg", buildFrameArgs({
          videoPath,
          timestampMs: capture.timestampMs,
          outputPath: reservation.tempPath,
        }));
      } catch (error) {
        throw frameError(capture.filename, "Unable to extract frame", error);
      }
      if (!(await reservationStillOwned(reservation, resolvedFileOps))) {
        throw frameError(capture.filename, "Extracted frame temp ownership changed");
      }
      if (result?.code !== 0 || !(await isNonEmptyFile(reservation.tempPath))) {
        throw frameError(capture.filename, "Unable to extract a nonempty frame");
      }

      const dimensions = await probeImageDimensions(reservation.tempPath, { run });
      if (!(await reservationStillOwned(reservation, resolvedFileOps))) {
        throw frameError(capture.filename, "Extracted frame temp ownership changed");
      }
      if (await pathsReferToSameFile(videoPath, finalPath)) {
        throw frameError(videoPath, "Frame output must not overwrite the local video");
      }
      const frame = completedFrame(capture, dimensions);
      currentManifest = await workspace.commitFrame(currentManifest, {
        tempPath: reservation.tempPath,
        tempIdentity: reservation.tempIdentity,
        frame,
      });
      log?.info?.(`Extracted frame ${capture.filename}`);
    } catch (error) {
      failure = error instanceof SourceError
        ? error
        : frameError(capture.filename, "Unable to publish extracted frame", error);
    }

    let cleanupError;
    if (reservation) {
      try {
        await cleanupReservation(reservation, resolvedFileOps);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) {
      throw frameError(
        capture.filename,
        "Frame temp cleanup failed",
        new AggregateError(failure ? [failure, cleanupError] : [cleanupError]),
      );
    }
    if (failure) throw failure;
  }

  return currentManifest;
}
