import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
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

const defaultFileOps = { open, lstat, mkdir, rmdir, stat, unlink };

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

async function pathIsOwnedDirectory(directoryPath, identity, fileOps) {
  try {
    const info = await fileOps.lstat(directoryPath);
    return info.isDirectory() && !info.isSymbolicLink() && hasFileIdentity(info, identity);
  } catch {
    return false;
  }
}

async function reservationStillOwned(reservation, fileOps) {
  try {
    const handleInfo = await reservation.handle.stat();
    return handleInfo.isFile()
      && hasFileIdentity(handleInfo, reservation.tempIdentity)
      && await pathIsOwnedDirectory(
        reservation.generationPath,
        reservation.generationIdentity,
        fileOps,
      )
      && await pathIsOwnedRegularFile(reservation.ownerPath, reservation.ownerIdentity, {
        inspect: fileOps.lstat,
      })
      && await pathIsOwnedRegularFile(reservation.tempPath, reservation.tempIdentity, {
        inspect: fileOps.lstat,
      });
  } catch {
    return false;
  }
}

async function cleanupReservation(reservation, fileOps) {
  const errors = [];
  const generationOwned = reservation.generationIdentity
    && await pathIsOwnedDirectory(
      reservation.generationPath,
      reservation.generationIdentity,
      fileOps,
    );
  let tempOwned = false;
  if (generationOwned && reservation.tempIdentity) {
    tempOwned = await pathIsOwnedRegularFile(reservation.tempPath, reservation.tempIdentity, {
      inspect: fileOps.lstat,
    });
  } else if (generationOwned && reservation.handle) {
    try {
      const current = await fileOps.lstat(reservation.tempPath);
      tempOwned = current.isFile() && !current.isSymbolicLink();
    } catch {
      tempOwned = false;
    }
  }
  if (tempOwned) {
    try {
      await fileOps.unlink(reservation.tempPath);
    } catch (error) {
      errors.push(error);
    }
  }
  if (reservation.handle) {
    try {
      await reservation.handle.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (reservation.ownerHandle) {
    try {
      await reservation.ownerHandle.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (generationOwned && reservation.obsoleteBackupPath
    && reservation.obsoleteBackupIdentity
    && await pathIsOwnedRegularFile(
      reservation.obsoleteBackupPath,
      reservation.obsoleteBackupIdentity,
      { inspect: fileOps.lstat },
    )) {
    try {
      await fileOps.unlink(reservation.obsoleteBackupPath);
    } catch (error) {
      errors.push(error);
    }
  }

  let ownerRemoved = !reservation.ownerIdentity;
  if (generationOwned && reservation.ownerIdentity
    && await pathIsOwnedRegularFile(reservation.ownerPath, reservation.ownerIdentity, {
      inspect: fileOps.lstat,
    })) {
    try {
      await fileOps.unlink(reservation.ownerPath);
      ownerRemoved = true;
    } catch (error) {
      errors.push(error);
    }
  }
  if (generationOwned && ownerRemoved) {
    try {
      await fileOps.rmdir(reservation.generationPath);
    } catch (error) {
      if (![
        "ENOENT",
        "ENOTEMPTY",
        "EEXIST",
      ].includes(error.code)) errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Private frame generation cleanup failed");
}

async function reserveOwnedTemp(finalPath, { nextTempId, fileOps }) {
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
      const generationInfo = await fileOps.lstat(generationPath);
      if (!generationInfo.isDirectory() || generationInfo.isSymbolicLink()) {
        throw frameError(generationPath, "Reserved frame generation is not a private directory");
      }
      reservation.generationIdentity = fileIdentity(generationInfo);

      reservation.ownerHandle = await fileOps.open(ownerPath, "wx", 0o600);
      await reservation.ownerHandle.writeFile(id);
      const ownerInfo = await reservation.ownerHandle.stat();
      reservation.ownerIdentity = fileIdentity(ownerInfo);
      await reservation.ownerHandle.close();
      reservation.ownerHandle = undefined;

      reservation.handle = await fileOps.open(tempPath, "wx", 0o600);
      const pathInfo = await fileOps.lstat(tempPath);
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
        throw frameError(tempPath, "Reserved frame temp path is not a regular file");
      }
      reservation.tempIdentity = fileIdentity(pathInfo);
      const info = await reservation.handle.stat();
      if (!info.isFile() || !hasFileIdentity(info, reservation.tempIdentity)) {
        throw frameError(tempPath, "Reserved frame temp is not a regular file");
      }
      return reservation;
    } catch (error) {
      try {
        await cleanupReservation(reservation, fileOps);
      } catch (cleanupError) {
        throw frameError(
          tempPath,
          "Unable to reserve and clean private frame generation",
          new AggregateError([error, cleanupError]),
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
}) {
  if (manifest?.status !== "building") {
    throw frameError(videoPath, "Frames can only be extracted into a building manifest");
  }
  validateCaptureTimestamps(captures, videoPath);

  const resolvedFileOps = { ...defaultFileOps, ...fileOps };
  const sourceIdentity = await sourceIdentityOrNull(videoPath, resolvedFileOps);
  const withFrameLease = workspace.withFrameLease
    ? workspace.withFrameLease.bind(workspace)
    : async (manifestToLease, operation) => operation({
      manifest: manifestToLease,
      canReuseFrame: (frame) => workspace.canReuseFrame(frame),
      commitFrame: (prepared) => workspace.commitFrame(manifestToLease, prepared),
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
        const preparedFrame = {
          generationPath: reservation.generationPath,
          generationIdentity: reservation.generationIdentity,
          ownerPath: reservation.ownerPath,
          ownerIdentity: reservation.ownerIdentity,
          tempPath: reservation.tempPath,
          tempIdentity: reservation.tempIdentity,
          sourcePath: videoPath,
          sourceIdentity,
          frame,
        };
        nextManifest = await lease.commitFrame(preparedFrame);
        reservation.obsoleteBackupPath = preparedFrame.obsoleteBackupPath;
        reservation.obsoleteBackupIdentity = preparedFrame.obsoleteBackupIdentity;
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
