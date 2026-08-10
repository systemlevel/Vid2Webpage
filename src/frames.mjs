import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { SourceError } from "./errors.mjs";
import {
  fileIdentity,
  hasFileIdentity,
  pathsReferToSameFile,
} from "./fs.mjs";
import {
  cleanupFrameStageSync,
  resolveFrameFileOps,
  verifyOpenFrameStageSync,
} from "./frame-stage.mjs";
import { runCommand } from "./process.mjs";

const defaultFileOps = { open, mkdir, stat };

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

async function sourceIdentityOrNull(videoPath, fileOps) {
  try {
    const info = await fileOps.stat(videoPath);
    return info.isFile() ? fileIdentity(info) : null;
  } catch {
    return null;
  }
}

async function sourceIdentityIsCurrent(videoPath, identity, fileOps) {
  if (!identity) return true;
  try {
    return hasFileIdentity(await fileOps.stat(videoPath), identity);
  } catch {
    return false;
  }
}

function pathsReferToSameFileSync(firstPath, secondPath, fileOps) {
  try {
    const first = fileOps.stat(firstPath);
    const second = fileOps.stat(secondPath);
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

async function closeReservationHandles(reservation) {
  const errors = [];
  if (reservation.handle) {
    try {
      await reservation.handle.close();
    } catch (error) {
      errors.push(error);
    }
    reservation.handle = undefined;
  }
  if (reservation.ownerHandle) {
    try {
      await reservation.ownerHandle.close();
    } catch (error) {
      errors.push(error);
    }
    reservation.ownerHandle = undefined;
  }
  return errors;
}

async function reserveOwnedTemp(finalPath, { nextTempId, fileOps, frameFileOps }) {
  for (;;) {
    const id = nextTempId();
    if (typeof id !== "string" || !/^[0-9a-f-]+$/u.test(id)) {
      throw frameError(finalPath, "Frame temp identity generator returned an invalid value");
    }
    const generationPath = path.join(path.dirname(finalPath), `.v2w-frame-stage-${id}`);
    const ownerPath = path.join(generationPath, `owner-${id}`);
    const tempPath = path.join(generationPath, path.basename(finalPath));
    const reservation = {
      generationPath,
      ownerPath,
      tempPath,
    };
    try {
      await fileOps.mkdir(generationPath, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
    try {
      const generationInfo = frameFileOps.lstat(generationPath);
      if (!generationInfo.isDirectory() || generationInfo.isSymbolicLink()) {
        throw frameError(generationPath, "Reserved frame generation is not a private directory");
      }
      reservation.generationIdentity = fileIdentity(generationInfo);

      reservation.ownerHandle = await fileOps.open(ownerPath, "wx", 0o600);
      await reservation.ownerHandle.writeFile(id);
      const ownerInfo = await reservation.ownerHandle.stat();
      if (!ownerInfo.isFile()) {
        throw frameError(ownerPath, "Reserved frame owner is not a regular file");
      }
      reservation.ownerIdentity = fileIdentity(ownerInfo);
      const ownerPathInfo = frameFileOps.lstat(ownerPath);
      if (!ownerPathInfo.isFile() || ownerPathInfo.isSymbolicLink()
        || !hasFileIdentity(ownerPathInfo, reservation.ownerIdentity)) {
        throw frameError(ownerPath, "Reserved frame owner path identity changed");
      }
      await reservation.ownerHandle.close();
      reservation.ownerHandle = undefined;

      reservation.handle = await fileOps.open(tempPath, "wx", 0o600);
      const info = await reservation.handle.stat();
      if (!info.isFile()) {
        throw frameError(tempPath, "Reserved frame temp is not a regular file");
      }
      reservation.tempIdentity = fileIdentity(info);
      reservation.tempFd = reservation.handle.fd;
      const pathInfo = frameFileOps.lstat(tempPath);
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink()
        || !hasFileIdentity(pathInfo, reservation.tempIdentity)) {
        throw frameError(tempPath, "Reserved frame temp path identity changed");
      }
      return reservation;
    } catch (error) {
      const cleanupErrors = await closeReservationHandles(reservation);
      try {
        cleanupFrameStageSync(reservation, frameFileOps);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw frameError(
          tempPath,
          "Unable to reserve and clean private frame generation",
          new AggregateError([error, ...cleanupErrors]),
        );
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
  frameFileOps = {},
}) {
  if (manifest?.status !== "building") {
    throw frameError(videoPath, "Frames can only be extracted into a building manifest");
  }
  validateCaptureTimestamps(captures, videoPath);

  const resolvedFileOps = { ...defaultFileOps, ...fileOps };
  const resolvedFrameFileOps = resolveFrameFileOps(frameFileOps);
  const sourceIdentity = await sourceIdentityOrNull(videoPath, resolvedFileOps);
  const withFrameLease = workspace.withFrameLease
    ? workspace.withFrameLease.bind(workspace)
    : async (manifestToLease, operation) => operation({
      manifest: manifestToLease,
      canReuseFrame: (frame) => workspace.canReuseFrame(frame),
      commitFrame: (prepared) => workspace.commitFrame(manifestToLease, prepared),
      cleanupFrame: (stage) => cleanupFrameStageSync(stage, resolvedFrameFileOps),
    });
  let currentManifest = manifest;
  const orderedCaptures = [...captures].sort((left, right) =>
    left.timestampMs - right.timestampMs || left.filename.localeCompare(right.filename));

  for (const capture of orderedCaptures) {
    currentManifest = await withFrameLease(currentManifest, async (lease) => {
      const leasedManifest = lease.manifest;
      const finalPath = safeFramePath(workspace.imagesDir, capture.filename);
      if (await pathsReferToSameFile(videoPath, finalPath)) {
        throw frameError(videoPath, "Frame output must not overwrite the local video");
      }

      const existing = leasedManifest.images.find((image) => image.filename === capture.filename);
      if (existing) {
        const reuseCandidate = completedFrame(capture, existing);
        if (await lease.canReuseFrame(reuseCandidate)) {
          if (!(await sourceIdentityIsCurrent(videoPath, sourceIdentity, resolvedFileOps))
            || await pathsReferToSameFile(videoPath, finalPath)) {
            throw frameError(videoPath, "Reusable frame must not alias the local video");
          }
          log?.info?.(`Reusing frame ${capture.filename}`);
          return leasedManifest;
        }
      }

      let reservation;
      let nextManifest;
      let failure;
      try {
        reservation = await reserveOwnedTemp(finalPath, {
          nextTempId,
          fileOps: resolvedFileOps,
          frameFileOps: resolvedFrameFileOps,
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
        if (!verifyOpenFrameStageSync(reservation, resolvedFrameFileOps)) {
          throw frameError(capture.filename, "Extracted frame temp ownership changed");
        }
        if (result?.code !== 0
          || !verifyOpenFrameStageSync(reservation, resolvedFrameFileOps, {
            requireNonEmpty: true,
          })) {
          throw frameError(capture.filename, "Unable to extract a nonempty frame");
        }

        const dimensions = await probeImageDimensions(reservation.tempPath, { run });
        if (!verifyOpenFrameStageSync(reservation, resolvedFrameFileOps, {
          requireNonEmpty: true,
        })) {
          throw frameError(capture.filename, "Extracted frame temp ownership changed");
        }
        if (pathsReferToSameFileSync(videoPath, finalPath, resolvedFrameFileOps)) {
          throw frameError(videoPath, "Frame output must not overwrite the local video");
        }
        const frame = completedFrame(capture, dimensions);
        const preparedFrame = {
          generationPath: reservation.generationPath,
          generationIdentity: reservation.generationIdentity,
          ownerPath: reservation.ownerPath,
          ownerIdentity: reservation.ownerIdentity,
          tempPath: reservation.tempPath,
          tempIdentity: reservation.tempIdentity,
          tempFd: reservation.tempFd,
          sourcePath: videoPath,
          sourceIdentity,
          frame,
        };
        try {
          nextManifest = await lease.commitFrame(preparedFrame);
        } finally {
          reservation.backupPath = preparedFrame.backupPath;
          reservation.backupIdentity = preparedFrame.backupIdentity;
          reservation.preserveBackup = preparedFrame.preserveBackup;
        }
        log?.info?.(`Extracted frame ${capture.filename}`);
      } catch (error) {
        failure = error instanceof SourceError
          ? error
          : frameError(capture.filename, "Unable to publish extracted frame", error);
      }

      let cleanupError;
      if (reservation) {
        const cleanupErrors = await closeReservationHandles(reservation);
        try {
          lease.cleanupFrame(reservation);
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (cleanupErrors.length === 1) [cleanupError] = cleanupErrors;
        if (cleanupErrors.length > 1) {
          cleanupError = new AggregateError(
            cleanupErrors,
            "Private frame generation cleanup failed",
          );
        }
      }
      if (cleanupError) {
        const cleanupCauses = cleanupError instanceof AggregateError
          ? cleanupError.errors
          : [cleanupError];
        throw frameError(
          capture.filename,
          "Frame temp cleanup failed",
          new AggregateError(failure ? [failure, ...cleanupCauses] : cleanupCauses),
        );
      }
      if (failure) throw failure;
      return nextManifest;
    });
  }

  return currentManifest;
}
