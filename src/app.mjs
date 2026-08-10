import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { safeOutputName } from "./args.mjs";
import { TranscriptQualityError, TranscriptionError } from "./errors.mjs";
import { extractFrames } from "./frames.mjs";
import { isNonEmptyFile, pathsReferToSameFile } from "./fs.mjs";
import { discoverLocalCaption, extractAudio, probeMedia } from "./media.mjs";
import { defaultCacheRoot, preflight } from "./preflight.mjs";
import { inspectTranscript } from "./quality.mjs";
import { renderOutput } from "./render.mjs";
import {
  classifySource,
  localFingerprint,
  youtubeFingerprint,
} from "./source.mjs";
import { buildCapturePlan } from "./timeline.mjs";
import { loadVocabPrompt, transcribeTimed } from "./transcribe.mjs";
import { detectSceneChanges, listFrameTimestamps } from "./visual-timing.mjs";
import { parseVtt } from "./vtt.mjs";
import { openWorkspace, workspaceCacheDir } from "./workspace.mjs";
import {
  downloadYoutubeCaption,
  downloadYoutubeMedia,
  fetchYoutubeMetadata,
} from "./youtube.mjs";

const whisperEngines = new Set(["mlx-whisper", "whisper-cpp"]);

export const DEFAULT_SERVICES = Object.freeze({
  basenameWithoutExtension: (file) => path.basename(file, path.extname(file)),
  buildCapturePlan,
  classifySource,
  defaultCacheRoot,
  detectSceneChanges,
  discoverLocalCaption,
  downloadYoutubeCaption,
  downloadYoutubeMedia,
  ensureDirectory: (directory) => mkdir(directory, { recursive: true }),
  extractAudio,
  extractFrames,
  fetchYoutubeMetadata,
  inspectTranscript,
  isNonEmptyFile,
  listFrameTimestamps,
  loadVocabPrompt,
  localFingerprint,
  openWorkspace,
  parseVtt,
  pathsReferToSameFile,
  preflight,
  probeMedia,
  readText: (file) => readFile(file, "utf8"),
  removeTemporary: (file) => rm(file, { force: true }),
  renderOutput,
  safeOutputName,
  transcribeTimed,
  workspaceCacheDir,
  youtubeFingerprint,
});

function isTimedSegment(segment) {
  return Number.isSafeInteger(segment?.startMs)
    && segment.startMs >= 0
    && Number.isSafeInteger(segment?.endMs)
    && segment.endMs > segment.startMs
    && typeof segment.text === "string";
}

async function inspectWhisperVtt(vttPath, services) {
  if (!(await services.isNonEmptyFile(vttPath))) return null;

  let segments;
  try {
    segments = services.parseVtt(await services.readText(vttPath));
  } catch {
    return null;
  }
  if (!Array.isArray(segments)
    || segments.length === 0
    || !segments.every(isTimedSegment)
    || !segments.some((segment) => segment.text.trim() !== "")) {
    return null;
  }

  const quality = services.inspectTranscript(segments);
  return { segments, quality };
}

async function reusableTranscript(manifest, cacheDir, services) {
  const recorded = manifest.transcript;
  if (!recorded
    || !whisperEngines.has(recorded.engine)
    || recorded.filename !== "transcript.vtt") {
    return null;
  }

  const vttPath = path.join(cacheDir, "transcript.vtt");
  const inspected = await inspectWhisperVtt(vttPath, services);
  if (!inspected?.quality?.clean) return null;
  return {
    engine: recorded.engine,
    vttPath,
    segments: inspected.segments,
  };
}

async function transcribeAuthoritatively({
  videoPath,
  cacheDir,
  tools,
  services,
}) {
  const audioPath = await services.extractAudio({
    inputPath: videoPath,
    outputPath: path.join(cacheDir, "audio.m4a"),
  });
  const vocabPrompt = await services.loadVocabPrompt();
  const transcript = await services.transcribeTimed({
    audioPath,
    cacheDir,
    tools,
    vocabPrompt,
  });
  const canonicalVttPath = path.join(cacheDir, "transcript.vtt");
  if (path.resolve(transcript?.vttPath ?? "") !== path.resolve(canonicalVttPath)
    || !whisperEngines.has(transcript?.engine)) {
    throw new TranscriptionError(
      "Timed Whisper did not produce the authoritative cache transcript",
    );
  }

  const inspected = await inspectWhisperVtt(canonicalVttPath, services);
  if (!inspected) {
    throw new TranscriptionError(
      "Timed Whisper did not produce parseable nonempty transcript segments",
    );
  }
  if (!inspected.quality?.clean) {
    throw new TranscriptQualityError(
      `Whisper transcript quality failed: ${JSON.stringify(inspected.quality)}`,
    );
  }
  return {
    audioPath,
    engine: transcript.engine,
    vttPath: canonicalVttPath,
    segments: inspected.segments,
  };
}

async function optionalCaptionCues(captionPath, services) {
  if (!captionPath) return [];
  try {
    const cues = services.parseVtt(await services.readText(captionPath));
    return Array.isArray(cues) ? cues : [];
  } catch {
    return [];
  }
}

function isContainedCacheFile(file, cacheDir) {
  if (typeof file !== "string" || file.length === 0) return false;
  const relative = path.relative(path.resolve(cacheDir), path.resolve(file));
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function cleanupAfterSuccess({
  files,
  cacheDir,
  localSourcePath,
  services,
}) {
  for (const file of new Set(files)) {
    if (!isContainedCacheFile(file, cacheDir)) continue;
    if (localSourcePath
      && await services.pathsReferToSameFile(file, localSourcePath)) {
      continue;
    }
    await services.removeTemporary(file);
  }
}

function manifestSource({ classified, metadata, fingerprint, mediaInfo, title }) {
  const common = {
    kind: classified.kind,
    fingerprint,
    title,
    durationMs: mediaInfo.durationMs,
    width: mediaInfo.width,
    height: mediaInfo.height,
  };
  if (classified.kind === "local") {
    return { ...common, input: classified.path };
  }
  return {
    ...common,
    input: classified.url,
    videoId: metadata.videoId,
    webpageUrl: metadata.webpageUrl,
  };
}

export async function runPipeline(
  {
    input,
    output,
    cwd = process.cwd(),
    env = process.env,
  },
  services = DEFAULT_SERVICES,
) {
  const classified = await services.classifySource(input, { cwd });
  const cacheRoot = services.defaultCacheRoot({ env, homedir: os.homedir() });
  const tools = await services.preflight(classified.kind, { cacheRoot });

  let metadata = null;
  let fingerprint;
  let title;
  if (classified.kind === "youtube") {
    metadata = await services.fetchYoutubeMetadata(classified.url);
    fingerprint = services.youtubeFingerprint(metadata.videoId);
    title = metadata.title;
  } else {
    fingerprint = await services.localFingerprint(classified);
    title = services.basenameWithoutExtension(classified.path);
  }

  const cacheDir = services.workspaceCacheDir(cacheRoot, fingerprint);
  await services.ensureDirectory(cacheDir);
  const cleanupFiles = [];
  let videoPath = classified.path;
  let captionPath = null;

  if (classified.kind === "youtube") {
    videoPath = await services.downloadYoutubeMedia({
      url: classified.url,
      cacheDir,
    });
    cleanupFiles.push(videoPath);
    captionPath = await services.downloadYoutubeCaption({
      url: classified.url,
      cacheDir,
    });
  }

  const mediaInfo = await services.probeMedia(videoPath);
  if (classified.kind === "local") {
    captionPath = await services.discoverLocalCaption({
      videoPath,
      mediaInfo,
      outputPath: path.join(cacheDir, "captions.vtt"),
    });
  }

  const source = manifestSource({
    classified,
    metadata,
    fingerprint,
    mediaInfo,
    title,
  });
  const outputDir = path.resolve(cwd, output ?? services.safeOutputName(title));
  const workspace = await services.openWorkspace({
    cacheRoot,
    fingerprint,
    outputDir,
    source,
  });
  let manifest = await workspace.loadManifest();

  if (manifest.status === "complete") {
    await cleanupAfterSuccess({
      files: cleanupFiles,
      cacheDir,
      localSourcePath: classified.kind === "local" ? classified.path : null,
      services,
    });
    return manifest;
  }

  let transcript = await reusableTranscript(manifest, cacheDir, services);
  if (!transcript) {
    transcript = await transcribeAuthoritatively({
      videoPath,
      cacheDir,
      tools,
      services,
    });
    cleanupFiles.push(transcript.audioPath);
  }

  const captionCues = await optionalCaptionCues(captionPath, services);
  const sceneTimes = await services.detectSceneChanges(videoPath);
  const frameTimes = await services.listFrameTimestamps(videoPath);
  const captures = services.buildCapturePlan({
    segments: transcript.segments,
    captionCues,
    sceneTimes,
    frameTimes,
    durationMs: mediaInfo.durationMs,
  });

  manifest = await workspace.saveManifest({
    ...manifest,
    transcript: {
      engine: transcript.engine,
      filename: "transcript.vtt",
    },
    segments: transcript.segments,
  });
  manifest = await services.extractFrames({
    videoPath,
    captures,
    workspace,
    manifest,
  });
  const completedManifest = await services.renderOutput({
    workspace,
    manifest,
    segments: transcript.segments,
    transcriptVttPath: transcript.vttPath,
  });

  await cleanupAfterSuccess({
    files: cleanupFiles,
    cacheDir,
    localSourcePath: classified.kind === "local" ? classified.path : null,
    services,
  });
  return completedManifest;
}
