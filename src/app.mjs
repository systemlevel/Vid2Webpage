import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { safeOutputName } from "./args.mjs";
import {
  OutputConflictError,
  SourceError,
  TranscriptQualityError,
  TranscriptionError,
} from "./errors.mjs";
import { extractFrames } from "./frames.mjs";
import {
  canonicalPath,
  captureFileIdentity,
  isNonEmptyFile,
  pathMatchesFileIdentity,
  pathsReferToSameFile,
} from "./fs.mjs";
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
  canonicalPath,
  captureFileIdentity,
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
  pathMatchesFileIdentity,
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
  const authoritativeSegments = Array.isArray(manifest.segments)
    ? manifest.segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }))
    : [];
  if (!inspected?.quality?.clean
    || authoritativeSegments.length === 0
    || !authoritativeSegments.every(isTimedSegment)
    || !isDeepStrictEqual(authoritativeSegments, inspected.segments)) {
    return null;
  }
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
  protectedFiles,
  services,
}) {
  const audioOutputPath = path.join(cacheDir, "audio.m4a");
  await rejectProtectedAlias(audioOutputPath, protectedFiles, services, "Audio output");
  const audioPath = await services.extractAudio({
    inputPath: videoPath,
    outputPath: audioOutputPath,
  });
  await rejectProtectedAlias(audioPath, protectedFiles, services, "Extracted audio");
  const canonicalVttPath = path.join(cacheDir, "transcript.vtt");
  await rejectProtectedAlias(
    canonicalVttPath,
    protectedFiles,
    services,
    "Transcript output",
  );
  const vocabPrompt = await services.loadVocabPrompt();
  const transcript = await services.transcribeTimed({
    audioPath,
    cacheDir,
    tools,
    vocabPrompt,
  });
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

function pathContainsOrEquals(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`));
}

async function rejectOutputCacheOverlap(outputDir, cacheDir, services) {
  const [canonicalOutput, canonicalCache] = await Promise.all([
    services.canonicalPath(outputDir),
    services.canonicalPath(cacheDir),
  ]);
  if (pathContainsOrEquals(canonicalOutput, canonicalCache)
    || pathContainsOrEquals(canonicalCache, canonicalOutput)) {
    throw new OutputConflictError(
      `Output and cache directories must be isolated: ${outputDir}`,
    );
  }
}

async function rejectProtectedAlias(file, protectedFiles, services, description) {
  for (const protectedFile of protectedFiles) {
    if (await services.pathMatchesFileIdentity(file, protectedFile)) {
      throw new SourceError(
        `${description} must not alias local ${protectedFile.label}: ${file}`,
      );
    }
  }
}

async function protectLocalFile(file, label, services) {
  return {
    ...(await services.captureFileIdentity(file)),
    path: file,
    label,
  };
}

async function cleanupAfterSuccess({
  files,
  cacheDir,
  onWarning,
  protectedFiles,
  services,
}) {
  for (const file of new Set(files)) {
    if (!isContainedCacheFile(file, cacheDir)) continue;
    try {
      if ((await Promise.all(protectedFiles.map((protectedFile) =>
        services.pathMatchesFileIdentity(file, protectedFile)))).some(Boolean)) continue;
      await services.removeTemporary(file);
    } catch (error) {
      try {
        onWarning(
          `Unable to remove temporary file ${file}: ${error?.message ?? String(error)}`,
        );
      } catch {
        // Cleanup warnings must never turn a durable completion into failure.
      }
    }
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
    onWarning = () => {},
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
  const outputDir = path.resolve(cwd, output ?? services.safeOutputName(title));
  await rejectOutputCacheOverlap(outputDir, cacheDir, services);
  const protectedFiles = classified.kind === "local"
    ? [await protectLocalFile(classified.path, "video", services)]
    : [];
  await services.ensureDirectory(cacheDir);
  await rejectOutputCacheOverlap(outputDir, cacheDir, services);
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
    const captionOutputPath = path.join(cacheDir, "captions.vtt");
    await rejectProtectedAlias(
      captionOutputPath,
      protectedFiles,
      services,
      "Caption cache output",
    );
    captionPath = await services.discoverLocalCaption({
      videoPath,
      mediaInfo,
      outputPath: captionOutputPath,
    });
    if (captionPath) {
      await rejectProtectedAlias(
        captionPath,
        protectedFiles,
        services,
        "Local caption",
      );
      protectedFiles.push(await protectLocalFile(captionPath, "caption", services));
    }
  }

  const source = manifestSource({
    classified,
    metadata,
    fingerprint,
    mediaInfo,
    title,
  });
  await rejectOutputCacheOverlap(outputDir, cacheDir, services);
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
      onWarning,
      protectedFiles,
      services,
    });
    return manifest;
  }

  await rejectProtectedAlias(
    path.join(cacheDir, "transcript.vtt"),
    protectedFiles,
    services,
    "Transcript cache",
  );
  let transcript = await reusableTranscript(manifest, cacheDir, services);
  if (!transcript) {
    transcript = await transcribeAuthoritatively({
      videoPath,
      cacheDir,
      tools,
      protectedFiles,
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
  for (const capture of captures) {
    await rejectProtectedAlias(
      path.join(workspace.imagesDir, capture.filename),
      protectedFiles,
      services,
      "Frame output",
    );
  }
  manifest = await services.extractFrames({
    videoPath,
    captures,
    workspace,
    manifest,
  });
  for (const filename of ["transcript.vtt", "styles.css", "index.html"]) {
    await rejectProtectedAlias(
      path.join(workspace.outputDir, filename),
      protectedFiles,
      services,
      "Rendered output",
    );
  }
  await rejectOutputCacheOverlap(outputDir, cacheDir, services);
  const completedManifest = await services.renderOutput({
    workspace,
    manifest,
    segments: transcript.segments,
    transcriptVttPath: transcript.vttPath,
  });

  await cleanupAfterSuccess({
    files: cleanupFiles,
    cacheDir,
    onWarning,
    protectedFiles,
    services,
  });
  return completedManifest;
}
