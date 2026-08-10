import { fstatSync } from "node:fs";
import path from "node:path";

import { SourceError } from "./errors.mjs";
import {
  captureFileIdentity,
  hasFileIdentity,
  isNonEmptyFile,
  pathsReferToSameFile,
  reserveOwnedArtifact,
} from "./fs.mjs";
import { runCommand } from "./process.mjs";

function mediaError(videoPath, message, cause) {
  return new SourceError(`${message}: ${videoPath}`, { cause });
}

function frameRate(value) {
  const [numerator, denominator] = String(value ?? "").split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return numerator / denominator;
}

export function buildExtractAudioArgs(inputPath, outputPath) {
  return ["-y", "-i", inputPath, "-vn", "-acodec", "aac", "-b:a", "128k", outputPath];
}

function buildCapabilityAudioArgs(inputPath, childFd) {
  return [
    "-y", "-i", inputPath,
    "-vn", "-acodec", "aac", "-b:a", "128k",
    "-f", "ipod", `/dev/fd/${childFd}`,
  ];
}

function verifyAudioCapability(output, protectedFiles, { requireNonEmpty = false } = {}) {
  if (!Number.isSafeInteger(output?.fd) || output.fd < 0) {
    throw new TypeError("Audio output capability is invalid");
  }
  const info = fstatSync(output.fd);
  if (!info.isFile()
    || (requireNonEmpty && info.size <= 0)
    || protectedFiles.some((protectedFile) =>
      hasFileIdentity(info, protectedFile?.identity))) {
    throw new Error("Audio output capability is not an owned non-protected file");
  }
}

function includesIdentity(protectedFiles, identity) {
  return protectedFiles.some((protectedFile) =>
    hasFileIdentity(protectedFile?.identity, identity));
}

async function withProtectedInput(protectedFiles, inputPath, label) {
  const protectedInput = {
    ...(await captureFileIdentity(inputPath)),
    path: inputPath,
    label,
  };
  return includesIdentity(protectedFiles, protectedInput.identity)
    ? protectedFiles
    : [...protectedFiles, protectedInput];
}

export async function probeMedia(videoPath, { run = runCommand } = {}) {
  let result;
  try {
    result = await run("ffprobe", [
      "-v", "error",
      "-show_entries",
      "format=duration:stream=index,codec_type,width,height,avg_frame_rate",
      "-of", "json",
      videoPath,
    ]);
  } catch (error) {
    throw mediaError(videoPath, "Unable to inspect local video", error);
  }
  if (result.code !== 0) {
    throw mediaError(videoPath, "Unable to inspect local video");
  }

  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (error) {
    throw mediaError(videoPath, "Invalid media metadata", error);
  }

  const durationMs = Number(data?.format?.duration) * 1000;
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const videoStream = streams.find((stream) => stream?.codec_type === "video");
  const hasAudio = streams.some((stream) => stream?.codec_type === "audio");
  const subtitleStreamIndexes = streams
    .filter((stream) => stream?.codec_type === "subtitle")
    .map((stream) => stream?.index)
    .filter(Number.isInteger);

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw mediaError(videoPath, "Local video has an invalid duration");
  }
  if (!Number.isInteger(videoStream?.width) || videoStream.width <= 0 ||
      !Number.isInteger(videoStream?.height) || videoStream.height <= 0) {
    throw mediaError(videoPath, "Local video is missing video dimensions");
  }
  if (!hasAudio) {
    throw mediaError(videoPath, "Local video has no audio stream");
  }

  return {
    durationMs,
    width: videoStream.width,
    height: videoStream.height,
    hasAudio,
    videoStreamIndex: videoStream.index,
    subtitleStreamIndexes,
    frameRate: frameRate(videoStream.avg_frame_rate),
  };
}

export async function extractAudio({
  inputPath,
  output,
  outputPath,
  protectedFiles = [],
  run = runCommand,
}) {
  if (!output) {
    if (typeof outputPath !== "string" || outputPath.length === 0) {
      throw mediaError(inputPath, "Audio output capability is required");
    }
    if (await pathsReferToSameFile(inputPath, outputPath)) {
      throw mediaError(inputPath, "Audio output must not overwrite local video");
    }
    const inputIdentity = {
      ...(await captureFileIdentity(inputPath)),
      path: inputPath,
      label: "video",
    };
    const effectiveProtectedFiles = includesIdentity(protectedFiles, inputIdentity.identity)
      ? protectedFiles
      : [...protectedFiles, inputIdentity];
    const reservation = await reserveOwnedArtifact(outputPath, {
      protectedFiles: effectiveProtectedFiles,
    });
    try {
      await extractAudio({
        inputPath,
        output: reservation.writer,
        protectedFiles: effectiveProtectedFiles,
        run,
      });
      return (await reservation.publish({
        protectedFiles: effectiveProtectedFiles,
      })).path;
    } finally {
      await reservation.discard();
    }
  }

  verifyAudioCapability(output, protectedFiles);
  const childFd = 3;
  let result;
  try {
    result = await run(
      "ffmpeg",
      buildCapabilityAudioArgs(inputPath, childFd),
      { stdio: ["ignore", "pipe", "pipe", output.fd] },
    );
  } catch (error) {
    throw mediaError(inputPath, "Unable to extract audio", error);
  }
  try {
    verifyAudioCapability(output, protectedFiles, { requireNonEmpty: true });
  } catch (error) {
    throw mediaError(inputPath, "Unable to extract audio", error);
  }
  if (result.code !== 0) {
    throw mediaError(inputPath, "Unable to extract audio");
  }
  return undefined;
}

export async function discoverLocalCaption({
  videoPath,
  mediaInfo,
  output,
  outputPath,
  protectedFiles = [],
  run = runCommand,
  logger = console,
}) {
  const parsedPath = path.parse(videoPath);
  const vttPath = path.join(parsedPath.dir, `${parsedPath.name}.vtt`);
  if (await isNonEmptyFile(vttPath)) return vttPath;

  const srtPath = path.join(parsedPath.dir, `${parsedPath.name}.srt`);
  const inputPath = (await isNonEmptyFile(srtPath)) ? srtPath : null;
  const subtitleStreamIndex = mediaInfo.subtitleStreamIndexes?.[0];
  if (!inputPath && !Number.isInteger(subtitleStreamIndex)) return null;

  let effectiveProtectedFiles;
  try {
    effectiveProtectedFiles = await withProtectedInput(
      protectedFiles,
      videoPath,
      "video",
    );
    if (inputPath) {
      effectiveProtectedFiles = await withProtectedInput(
        effectiveProtectedFiles,
        inputPath,
        "caption",
      );
    }
  } catch (error) {
    logger?.warn?.(`Unable to prepare caption timing hints for ${videoPath}`, error);
    return null;
  }

  if (!output) {
    const overwritesVideo = await pathsReferToSameFile(videoPath, outputPath);
    const overwritesCaptionInput = inputPath && await pathsReferToSameFile(inputPath, outputPath);
    if (overwritesVideo || overwritesCaptionInput) {
      logger?.warn?.(
        `Unable to prepare caption timing hints for ${videoPath}`,
        new Error("Caption output must not overwrite local input"),
      );
      return null;
    }
    try {
      const reservation = await reserveOwnedArtifact(outputPath, {
        protectedFiles: effectiveProtectedFiles,
      });
      try {
        const result = await discoverLocalCaption({
          videoPath,
          mediaInfo,
          output: reservation.writer,
          protectedFiles: effectiveProtectedFiles,
          run,
          logger,
        });
        if (result?.kind !== "capability-output") return null;
        return (await reservation.publish({
          protectedFiles: result.protectedFiles,
        })).path;
      } finally {
        await reservation.discard();
      }
    } catch (error) {
      logger?.warn?.(`Unable to prepare caption timing hints for ${videoPath}`, error);
      return null;
    }
  }

  const childFd = 3;
  const args = inputPath
    ? ["-y", "-i", inputPath, "-f", "webvtt", `pipe:${childFd}`]
    : [
      "-y", "-i", videoPath, "-map", `0:${subtitleStreamIndex}`,
      "-f", "webvtt", `pipe:${childFd}`,
    ];
  try {
    verifyAudioCapability(output, effectiveProtectedFiles);
    const result = await run(
      "ffmpeg",
      args,
      { stdio: ["ignore", "pipe", "pipe", output.fd] },
    );
    verifyAudioCapability(output, effectiveProtectedFiles, { requireNonEmpty: true });
    if (result.code !== 0) {
      throw new Error("Caption output was empty");
    }
    return { kind: "capability-output", protectedFiles: effectiveProtectedFiles };
  } catch (error) {
    logger?.warn?.(`Unable to prepare caption timing hints for ${videoPath}`, error);
    return null;
  }
}
