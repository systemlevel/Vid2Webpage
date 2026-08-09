import path from "node:path";
import { readdir } from "node:fs/promises";

import { SourceError } from "./errors.mjs";
import { isNonEmptyFile } from "./fs.mjs";
import { runCommand } from "./process.mjs";

function youtubeError(message, stderr = "", cause) {
  const detail = String(stderr).slice(0, 300);
  return new SourceError(detail ? `${message}: ${detail}` : message, { cause });
}

function validText(value) {
  return typeof value === "string" && value.trim() !== "";
}

export async function fetchYoutubeMetadata(url, { run = runCommand } = {}) {
  let result;
  try {
    result = await run("yt-dlp", ["--dump-single-json", "--skip-download", "--no-playlist", url]);
  } catch (error) {
    throw youtubeError("Unable to fetch YouTube metadata", "", error);
  }
  if (result?.code !== 0) {
    throw youtubeError("Unable to fetch YouTube metadata", result?.stderr);
  }

  let metadata;
  try {
    metadata = JSON.parse(result.stdout);
  } catch (error) {
    throw youtubeError("Invalid YouTube metadata", result.stderr, error);
  }

  const durationMs = Number(metadata?.duration) * 1000;
  if (
    !validText(metadata?.id) ||
    !validText(metadata?.title) ||
    !validText(metadata?.webpage_url) ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    throw youtubeError("Incomplete YouTube metadata", result.stderr);
  }

  return {
    videoId: metadata.id,
    title: metadata.title,
    durationMs,
    webpageUrl: metadata.webpage_url,
  };
}

export async function downloadYoutubeMedia({ url, cacheDir, run = runCommand }) {
  let result;
  try {
    result = await run("yt-dlp", [
      "--no-playlist",
      "-f", "bestvideo*+bestaudio/best",
      "--merge-output-format", "mkv",
      "-o", path.join(cacheDir, "source.%(ext)s"),
      "--print", "after_move:filepath",
      url,
    ]);
  } catch (error) {
    throw youtubeError("Unable to download YouTube media", "", error);
  }
  if (result?.code !== 0) {
    throw youtubeError("Unable to download YouTube media", result?.stderr);
  }

  const videoPath = result?.stdout?.trim();
  if (!validText(videoPath) || !(await isNonEmptyFile(videoPath))) {
    throw youtubeError("YouTube media download did not produce a video file", result?.stderr);
  }
  return videoPath;
}

export async function downloadYoutubeCaption({ url, cacheDir, run = runCommand, log = console }) {
  try {
    const result = await run("yt-dlp", [
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs", "en.*,en",
      "--sub-format", "vtt",
      "-o", path.join(cacheDir, "captions.%(ext)s"),
      url,
    ]);
    if (result?.code !== 0) {
      throw youtubeError("Unable to download YouTube caption timing hints", result?.stderr);
    }

    const names = (await readdir(cacheDir))
      .filter((name) => name.startsWith("captions") && name.endsWith(".vtt"))
      .sort();
    for (const name of names) {
      const captionPath = path.join(cacheDir, name);
      if (await isNonEmptyFile(captionPath)) return captionPath;
    }
    throw new Error("No nonempty YouTube caption VTT was produced");
  } catch (error) {
    log?.warn?.("Unable to download YouTube caption timing hints", error);
    return null;
  }
}
