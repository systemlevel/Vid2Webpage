import path from "node:path";
import { realpath, stat } from "node:fs/promises";

import { SourceError } from "./errors.mjs";
import { isNonEmptyFile } from "./fs.mjs";
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

async function canonicalPath(filePath) {
  try {
    return await realpath(filePath);
  } catch {
    let parentPath;
    try {
      parentPath = await realpath(path.dirname(filePath));
    } catch {
      parentPath = path.resolve(path.dirname(filePath));
    }
    return path.join(parentPath, path.basename(filePath));
  }
}

async function pathsReferToSameFile(firstPath, secondPath) {
  const [firstCanonicalPath, secondCanonicalPath] = await Promise.all([
    canonicalPath(firstPath),
    canonicalPath(secondPath),
  ]);
  if (firstCanonicalPath === secondCanonicalPath) return true;

  try {
    const [firstInfo, secondInfo] = await Promise.all([stat(firstPath), stat(secondPath)]);
    return firstInfo.dev === secondInfo.dev && firstInfo.ino === secondInfo.ino;
  } catch {
    return false;
  }
}

export function buildExtractAudioArgs(inputPath, outputPath) {
  return ["-y", "-i", inputPath, "-vn", "-acodec", "aac", "-b:a", "128k", outputPath];
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

export async function extractAudio({ inputPath, outputPath, run = runCommand }) {
  if (await pathsReferToSameFile(inputPath, outputPath)) {
    throw mediaError(inputPath, "Audio output must not overwrite local video");
  }
  let result;
  try {
    result = await run("ffmpeg", buildExtractAudioArgs(inputPath, outputPath));
  } catch (error) {
    throw mediaError(inputPath, "Unable to extract audio", error);
  }
  if (result.code !== 0 || !(await isNonEmptyFile(outputPath))) {
    throw mediaError(inputPath, "Unable to extract audio");
  }
  return outputPath;
}

export async function discoverLocalCaption({
  videoPath,
  mediaInfo,
  outputPath,
  run = runCommand,
  logger = console,
}) {
  const parsedPath = path.parse(videoPath);
  const vttPath = path.join(parsedPath.dir, `${parsedPath.name}.vtt`);
  if (await isNonEmptyFile(vttPath)) return vttPath;

  const srtPath = path.join(parsedPath.dir, `${parsedPath.name}.srt`);
  const inputPath = (await isNonEmptyFile(srtPath)) ? srtPath : null;
  const subtitleStreamIndex = mediaInfo.subtitleStreamIndexes?.[0];
  const args = inputPath
    ? ["-y", "-i", inputPath, "-f", "webvtt", outputPath]
    : Number.isInteger(subtitleStreamIndex)
      ? ["-y", "-i", videoPath, "-map", `0:${subtitleStreamIndex}`, "-f", "webvtt", outputPath]
      : null;

  if (!args) return null;
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
    const result = await run("ffmpeg", args);
    if (result.code !== 0 || !(await isNonEmptyFile(outputPath))) {
      throw new Error("Caption output was empty");
    }
    return outputPath;
  } catch (error) {
    logger?.warn?.(`Unable to prepare caption timing hints for ${videoPath}`, error);
    return null;
  }
}
