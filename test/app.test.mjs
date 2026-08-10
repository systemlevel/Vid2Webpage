import assert from "node:assert/strict";
import {
  linkSync,
  lstatSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { safeOutputName } from "../src/args.mjs";
import { runPipeline } from "../src/app.mjs";
import { OutputConflictError, SourceError } from "../src/errors.mjs";
import { isNonEmptyFile, pathsReferToSameFile } from "../src/fs.mjs";
import { parseVtt } from "../src/vtt.mjs";

const whisperVtt = [
  "WEBVTT",
  "",
  "00:00:00.000 --> 00:00:08.000",
  "Whisper words",
  "",
].join("\n");

const captionVtt = [
  "WEBVTT",
  "",
  "00:00:01.000 --> 00:00:03.000",
  "caption poison",
  "",
].join("\n");

async function makeHarness({
  kind,
  root,
  sourcePath,
  captionPath = null,
  completed = false,
  manifestTranscript = null,
  manifestSegments,
  cachedTranscriptText,
  extractedAudioPath,
  downloadedVideoPath,
  failRender = false,
  cacheRoot: selectedCacheRoot,
  removalFailures = [],
  renderHook,
  audioWriteHook,
} = {}) {
  const calls = [];
  const removed = [];
  const fingerprint = `${kind}-fingerprint`;
  const cacheRoot = selectedCacheRoot ?? path.join(root, "cache");
  const cacheDir = path.join(cacheRoot, fingerprint);
  await mkdir(cacheDir, { recursive: true });
  if (cachedTranscriptText !== undefined) {
    await writeFile(path.join(cacheDir, "transcript.vtt"), cachedTranscriptText);
  }

  let manifest = {
    schemaVersion: 1,
    status: completed ? "complete" : "building",
    source: null,
    transcript: manifestTranscript,
    segments: manifestSegments ?? (completed
      ? [{ startMs: 0, endMs: 8_000, text: "Already complete" }]
      : []),
    images: [],
    revision: 0,
  };
  const workspace = {
    outputDir: null,
    imagesDir: null,
    cacheDir,
    async loadManifest() {
      calls.push("load-manifest");
      return manifest;
    },
    async saveManifest(value) {
      calls.push("save-manifest");
      manifest = { ...value, revision: (value.revision ?? 0) + 1 };
      return manifest;
    },
  };

  const videoPath = downloadedVideoPath ?? path.join(cacheDir, "source.webm");
  const youtubeCaptionPath = path.join(cacheDir, "captions.en.vtt");
  const services = {
    classifySource: async (input, options) => {
      calls.push("classify");
      assert.equal(options.cwd, root);
      return kind === "local"
        ? { kind, input, path: sourcePath, stat: { size: 11, mtimeMs: 1 } }
        : { kind, input, url: input };
    },
    preflight: async (sourceKind, options) => {
      calls.push("preflight");
      assert.equal(sourceKind, kind);
      assert.equal(options.cacheRoot, cacheRoot);
      return {
        mlx: true,
        whisperCpp: false,
        whisperModelPath: path.join(cacheRoot, "model.bin"),
      };
    },
    fetchYoutubeMetadata: async () => {
      calls.push("youtube-metadata");
      return {
        videoId: "abc",
        title: "YouTube lesson",
        durationMs: 8_000,
        webpageUrl: "https://www.youtube.com/watch?v=abc",
      };
    },
    localFingerprint: async () => {
      calls.push("local-fingerprint");
      return fingerprint;
    },
    youtubeFingerprint: () => {
      calls.push("youtube-fingerprint");
      return fingerprint;
    },
    defaultCacheRoot: ({ env, homedir }) => {
      calls.push("default-cache-root");
      assert.deepEqual(env, { XDG_CACHE_HOME: path.join(root, "cache-parent") });
      assert.equal(typeof homedir, "string");
      return cacheRoot;
    },
    workspaceCacheDir: (base, value) => {
      calls.push("workspace-cache-dir");
      assert.equal(base, cacheRoot);
      assert.equal(value, fingerprint);
      return cacheDir;
    },
    ensureDirectory: async (directory) => {
      calls.push("ensure-cache");
      await mkdir(directory, { recursive: true });
    },
    downloadYoutubeMedia: async ({ url, cacheDir: requestedCacheDir }) => {
      calls.push("download-media");
      assert.equal(url, "https://youtu.be/abc");
      assert.equal(requestedCacheDir, cacheDir);
      await writeFile(videoPath, "youtube-video");
      return videoPath;
    },
    downloadYoutubeCaption: async ({ cacheDir: requestedCacheDir }) => {
      calls.push("download-caption");
      assert.equal(requestedCacheDir, cacheDir);
      await writeFile(youtubeCaptionPath, captionVtt);
      return youtubeCaptionPath;
    },
    probeMedia: async (requestedVideoPath) => {
      calls.push("probe-media");
      assert.equal(requestedVideoPath, kind === "local" ? sourcePath : videoPath);
      return {
        durationMs: 8_000,
        width: 640,
        height: 360,
        hasAudio: true,
        videoStreamIndex: 0,
        subtitleStreamIndexes: [],
        frameRate: 10,
      };
    },
    locateLocalCaption: async ({ videoPath: requestedVideoPath }) => {
      calls.push("discover-caption");
      assert.equal(requestedVideoPath, sourcePath);
      return captionPath ? { kind: "vtt", path: captionPath } : null;
    },
    materializeLocalCaption: async () => {
      throw new Error("direct VTT harness must not materialize captions");
    },
    discoverLocalCaption: async ({
      videoPath: requestedVideoPath,
      output,
      outputPath,
      protectedFiles,
    }) => {
      calls.push("discover-caption");
      assert.equal(requestedVideoPath, sourcePath);
      assert.equal(outputPath, undefined);
      assert.equal(Number.isSafeInteger(output.fd), true);
      assert.deepEqual(protectedFiles.map((protectedFile) => protectedFile.label), ["video"]);
      return captionPath;
    },
    openWorkspace: async ({
      cacheRoot: base,
      fingerprint: value,
      outputDir,
      source,
      protectedFiles,
    }) => {
      calls.push("open-workspace");
      assert.equal(base, cacheRoot);
      assert.equal(value, fingerprint);
      assert.deepEqual(
        protectedFiles.map((protectedFile) => protectedFile.label),
        kind === "local" ? ["video", ...(captionPath ? ["caption"] : [])] : [],
      );
      workspace.outputDir = outputDir;
      workspace.imagesDir = path.join(outputDir, "images");
      workspace.retentionDir = path.join(root, "output-retention");
      workspace.cacheRetentionDir = path.join(cacheDir, ".retention");
      await mkdir(workspace.retentionDir, { recursive: true });
      await mkdir(workspace.cacheRetentionDir, { recursive: true });
      manifest = { ...manifest, source: manifest.source ?? source };
      return workspace;
    },
    extractAudio: async ({ inputPath, output, outputPath, protectedFiles }) => {
      calls.push("extract-audio");
      assert.equal(inputPath, kind === "local" ? sourcePath : videoPath);
      if (audioWriteHook) {
        return audioWriteHook({ output, outputPath, protectedFiles });
      }
      if (extractedAudioPath) return extractedAudioPath;
      if (output) {
        writeFileSync(output.fd, "audio");
        return undefined;
      }
      await writeFile(outputPath, "audio");
      return outputPath;
    },
    loadVocabPrompt: async () => {
      calls.push("load-vocab");
      return "vocabulary";
    },
    transcribeTimed: async ({ audioPath, cacheDir: requestedCacheDir, tools, vocabPrompt }) => {
      calls.push("transcribe");
      assert.equal(audioPath, extractedAudioPath ?? path.join(cacheDir, "audio.m4a"));
      assert.equal(requestedCacheDir, cacheDir);
      assert.equal(tools.mlx, true);
      assert.equal(vocabPrompt, "vocabulary");
      const transcriptPath = path.join(cacheDir, "transcript.vtt");
      await writeFile(transcriptPath, whisperVtt);
      return {
        engine: "mlx-whisper",
        vttPath: transcriptPath,
        cues: [{ startMs: 0, endMs: 8_000, text: "returned cue poison" }],
      };
    },
    parseVtt,
    inspectTranscript: (segments) => ({
      loop: segments.some((segment) => segment.text.includes("degraded")) ? {} : null,
      fragmentation: null,
      clean: !segments.some((segment) => segment.text.includes("degraded")),
    }),
    detectSceneChanges: async (requestedVideoPath) => {
      calls.push("detect-scenes");
      assert.equal(requestedVideoPath, kind === "local" ? sourcePath : videoPath);
      return [3_000];
    },
    listFrameTimestamps: async () => {
      calls.push("list-frame-times");
      return [0, 1_000, 3_250, 4_000, 7_999];
    },
    buildCapturePlan: (options) => {
      calls.push("build-capture-plan");
      assert.equal(options.segments[0].text, "Whisper words");
      assert.equal(options.captionCues[0].text, "caption poison");
      return [{
        requestedMs: 4_000,
        timestampMs: 4_000,
        reasons: ["primary", "caption"],
        associations: [{
          segmentIndex: 0,
          requestedMs: 4_000,
          reasons: ["primary", "caption"],
        }],
        filename: "000004000-primary.jpg",
      }];
    },
    extractFrames: async ({
      videoPath: requestedVideoPath,
      captures,
      manifest: value,
      protectedFiles,
    }) => {
      calls.push("extract-frames");
      assert.equal(requestedVideoPath, kind === "local" ? sourcePath : videoPath);
      assert.deepEqual(
        protectedFiles.map((protectedFile) => protectedFile.label),
        kind === "local" ? ["video", ...(captionPath ? ["caption"] : [])] : [],
      );
      assert.ok(calls.indexOf("save-manifest") < calls.indexOf("extract-frames"));
      assert.equal(value.segments[0].text, "Whisper words");
      assert.equal(Object.hasOwn(captures[0], "segmentIndex"), false);
      assert.deepEqual(captures[0].associations, [{
        segmentIndex: 0,
        requestedMs: 4_000,
        reasons: ["primary", "caption"],
      }]);
      return {
        ...value,
        images: [{
          ...captures[0],
          width: 640,
          height: 360,
        }],
      };
    },
    renderOutput: async (renderOptions) => {
      const {
        workspace: requestedWorkspace,
        manifest: value,
        segments,
        transcriptVttPath,
      } = renderOptions;
      calls.push("render-output");
      assert.equal(requestedWorkspace, workspace);
      assert.equal(Object.hasOwn(renderOptions, "protectedFiles"), false);
      assert.equal(segments[0].text, "Whisper words");
      assert.doesNotMatch(JSON.stringify(segments), /caption poison|returned cue poison/);
      assert.equal(transcriptVttPath, path.join(cacheDir, "transcript.vtt"));
      if (failRender) throw new Error("render failed");
      await renderHook?.();
      return { ...value, status: "complete", segments };
    },
    removeTemporary: async (file) => {
      calls.push(`remove:${path.basename(file)}`);
      removed.push(file);
      if (removalFailures.includes(path.basename(file))) {
        throw new Error(`cannot remove ${path.basename(file)}`);
      }
      await rm(file, { force: true });
    },
    isNonEmptyFile,
    pathsReferToSameFile,
    canonicalPath: async (file) => {
      try {
        return await realpath(file);
      } catch {
        return path.join(await realpath(path.dirname(file)), path.basename(file));
      }
    },
    captureFileIdentity: async (file) => {
      const info = await stat(file);
      return {
        canonicalPath: await realpath(file),
        identity: { dev: info.dev, ino: info.ino },
      };
    },
    pathMatchesFileIdentity: async (file, protectedFile) => {
      try {
        const info = await stat(file);
        const canonical = await realpath(file);
        return canonical === protectedFile.canonicalPath
          || (info.dev === protectedFile.identity.dev && info.ino === protectedFile.identity.ino);
      } catch {
        return false;
      }
    },
    safeOutputName,
    basenameWithoutExtension: (file) => path.basename(file, path.extname(file)),
    readText: (file) => readFile(file, "utf8"),
  };

  return { calls, removed, services, workspace, cacheDir, videoPath };
}

test("audio extraction writes only through its owned capability when the final path becomes a protected hard link", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-audio-capability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "lesson.mov");
  const sidecarPath = path.join(root, "lesson.vtt");
  await writeFile(sourcePath, "local-video");
  await writeFile(sidecarPath, captionVtt);
  const sourceBefore = await stat(sourcePath);
  const sidecarBefore = await stat(sidecarPath);
  let audioPath;
  const harness = await makeHarness({
    kind: "local",
    root,
    sourcePath,
    captionPath: sidecarPath,
    audioWriteHook: async ({ output, outputPath }) => {
      if (output) {
        await link(sidecarPath, audioPath);
        writeFileSync(output.fd, "owned-audio");
        return undefined;
      }
      await link(sidecarPath, outputPath);
      await writeFile(outputPath, "unsafe-audio");
      return outputPath;
    },
  });
  audioPath = path.join(harness.cacheDir, "audio.m4a");

  await assert.rejects(runPipeline({
    input: sourcePath,
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
  }, harness.services), SourceError);

  assert.equal(await readFile(sourcePath, "utf8"), "local-video");
  assert.equal(await readFile(sidecarPath, "utf8"), captionVtt);
  assert.equal(await readFile(audioPath, "utf8"), captionVtt);
  const sourceAfter = await stat(sourcePath);
  const sidecarAfter = await stat(sidecarPath);
  assert.deepEqual(
    { dev: sourceAfter.dev, ino: sourceAfter.ino },
    { dev: sourceBefore.dev, ino: sourceBefore.ino },
  );
  assert.deepEqual(
    { dev: sidecarAfter.dev, ino: sidecarAfter.ino },
    { dev: sidecarBefore.dev, ino: sidecarBefore.ino },
  );
});

for (const kind of ["local", "youtube"]) {
  test(`runs the complete ${kind} flow with Whisper-authoritative text`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "Local Lesson.mov");
    const sidecarPath = path.join(root, "Local Lesson.vtt");
    await writeFile(sourcePath, "local-video");
    await writeFile(sidecarPath, captionVtt);
    const harness = await makeHarness({
      kind,
      root,
      sourcePath,
      captionPath: kind === "local" ? sidecarPath : null,
    });

    const result = await runPipeline({
      input: kind === "local" ? sourcePath : "https://youtu.be/abc",
      output: "relative-output",
      cwd: root,
      env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    }, harness.services);

    assert.equal(result.status, "complete");
    assert.deepEqual(result.segments, [{ startMs: 0, endMs: 8_000, text: "Whisper words" }]);
    assert.equal(harness.workspace.outputDir, path.join(root, "relative-output"));
    assert.equal(result.images[0].associations[0].segmentIndex, 0);
    assert.equal(Object.hasOwn(result.images[0], "segmentIndex"), false);
    assert.equal(harness.calls.filter((call) => call === "render-output").length, 1);
    assert.ok(harness.calls.indexOf("classify") < harness.calls.indexOf("preflight"));
    assert.ok(harness.calls.indexOf("preflight") < harness.calls.indexOf(`${kind}-fingerprint`));
    assert.deepEqual(
      harness.removed.map((file) => path.basename(file)).sort(),
      kind === "youtube" ? ["audio.m4a", "source.webm"] : [],
    );
    if (kind === "local") {
      assert.equal(await readFile(sourcePath, "utf8"), "local-video");
      assert.equal(await readFile(sidecarPath, "utf8"), captionVtt);
      assert.equal(result.source.input, sourcePath);
    } else {
      assert.equal(result.source.videoId, "abc");
      assert.equal(result.source.webpageUrl, "https://www.youtube.com/watch?v=abc");
    }
  });
}

test("retains downloaded media and extracted audio when the pipeline fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await makeHarness({ kind: "youtube", root, failRender: true });

  await assert.rejects(runPipeline({
    input: "https://youtu.be/abc",
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
  }, harness.services), /render failed/);

  assert.deepEqual(harness.removed, []);
  assert.equal(await readFile(harness.videoPath, "utf8"), "youtube-video");
  assert.equal(await readFile(path.join(harness.cacheDir, "audio.m4a"), "utf8"), "audio");
});

test("returns a matching completed workspace without retranscribing or rewriting it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-complete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "lesson.mov");
  await writeFile(sourcePath, "local-video");
  const harness = await makeHarness({ kind: "local", root, sourcePath, completed: true });

  const result = await runPipeline({
    input: sourcePath,
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
  }, harness.services);

  assert.equal(result.status, "complete");
  assert.equal(result.segments[0].text, "Already complete");
  assert.equal(harness.workspace.outputDir, path.join(root, "lesson"));
  assert.equal(harness.calls.includes("save-manifest"), false);
  assert.equal(harness.calls.includes("extract-audio"), false);
  assert.equal(harness.calls.includes("transcribe"), false);
  assert.equal(harness.calls.includes("extract-frames"), false);
  assert.equal(harness.calls.includes("render-output"), false);
  assert.deepEqual(harness.removed, []);
  assert.equal(await readFile(sourcePath, "utf8"), "local-video");
});

for (const captionKind of ["srt", "embedded"]) {
  test(`completed local rerun with ${captionKind} captions is read-only`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-complete-caption-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "lesson.mov");
    const sidecarPath = path.join(root, "lesson.srt");
    await writeFile(sourcePath, "local-video");
    if (captionKind === "srt") {
      await writeFile(sidecarPath, "1\n00:00:00,000 --> 00:00:01,000\ntiming hint\n");
    }
    const harness = await makeHarness({
      kind: "local",
      root,
      sourcePath,
      captionPath: captionKind === "srt" ? sidecarPath : null,
      completed: true,
    });
    let protectedLabels;
    const openWorkspace = harness.services.openWorkspace;
    harness.services.openWorkspace = async (options) => {
      protectedLabels = options.protectedFiles?.map((file) => file.label);
      return openWorkspace(options);
    };
    harness.services.locateLocalCaption = async () => captionKind === "srt"
      ? { kind: "srt", path: sidecarPath }
      : { kind: "embedded", streamIndex: 2 };
    harness.services.materializeLocalCaption = async () => {
      throw new Error("completed rerun must not materialize caption timing hints");
    };
    harness.services.discoverLocalCaption = async () => {
      throw new Error("completed rerun must not republish caption timing hints");
    };

    const result = await runPipeline({
      input: sourcePath,
      cwd: root,
      env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    }, harness.services);

    assert.equal(result.status, "complete");
    assert.equal(result.segments[0].text, "Already complete");
    assert.deepEqual(
      protectedLabels,
      captionKind === "srt" ? ["video", "caption"] : ["video"],
    );
    assert.equal(harness.calls.includes("save-manifest"), false);
    assert.equal(harness.calls.includes("render-output"), false);
    assert.equal(await readFile(sourcePath, "utf8"), "local-video");
    if (captionKind === "srt") {
      assert.match(await readFile(sidecarPath, "utf8"), /timing hint/);
    }
  });
}

test("reuses only a recorded nonempty clean Whisper transcript", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "lesson.mov");
  const sidecarPath = path.join(root, "lesson.vtt");
  await writeFile(sourcePath, "local-video");
  await writeFile(sidecarPath, captionVtt);
  const harness = await makeHarness({
    kind: "local",
    root,
    sourcePath,
    captionPath: sidecarPath,
    manifestTranscript: { engine: "mlx-whisper", filename: "transcript.vtt" },
    manifestSegments: parseVtt(whisperVtt),
    cachedTranscriptText: whisperVtt,
  });

  const result = await runPipeline({
    input: sourcePath,
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
  }, harness.services);

  assert.equal(result.segments[0].text, "Whisper words");
  assert.equal(harness.calls.includes("extract-audio"), false);
  assert.equal(harness.calls.includes("transcribe"), false);
  assert.deepEqual(harness.removed, []);
});

test("retranscribes when clean cached VTT does not match persisted Whisper segments", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "lesson.mov");
  const sidecarPath = path.join(root, "lesson.vtt");
  await writeFile(sourcePath, "local-video");
  await writeFile(sidecarPath, captionVtt);
  const harness = await makeHarness({
    kind: "local",
    root,
    sourcePath,
    captionPath: sidecarPath,
    manifestTranscript: { engine: "mlx-whisper", filename: "transcript.vtt" },
    manifestSegments: parseVtt(whisperVtt),
    cachedTranscriptText: captionVtt,
  });

  const result = await runPipeline({
    input: sourcePath,
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
  }, harness.services);

  assert.equal(harness.calls.filter((call) => call === "transcribe").length, 1);
  assert.deepEqual(result.segments, parseVtt(whisperVtt));
  assert.doesNotMatch(JSON.stringify(result.segments), /caption poison/);
});

for (const invalidCache of [
  { name: "empty", text: "", transcript: { engine: "mlx-whisper", filename: "transcript.vtt" } },
  { name: "unparseable", text: "not a VTT", transcript: { engine: "mlx-whisper", filename: "transcript.vtt" } },
  { name: "degraded", text: whisperVtt.replace("Whisper words", "degraded words"), transcript: { engine: "mlx-whisper", filename: "transcript.vtt" } },
  { name: "unrecorded", text: whisperVtt, transcript: null },
  { name: "wrong engine", text: whisperVtt, transcript: { engine: "caption-import", filename: "transcript.vtt" } },
  { name: "wrong filename", text: whisperVtt, transcript: { engine: "mlx-whisper", filename: "../transcript.vtt" } },
  { name: "missing provenance", text: whisperVtt, transcript: { engine: "mlx-whisper", filename: "transcript.vtt" } },
]) {
  test(`retranscribes instead of reusing the ${invalidCache.name} cache`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-invalid-cache-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "lesson.mov");
    const sidecarPath = path.join(root, "lesson.vtt");
    await writeFile(sourcePath, "local-video");
    await writeFile(sidecarPath, captionVtt);
    const harness = await makeHarness({
      kind: "local",
      root,
      sourcePath,
      captionPath: sidecarPath,
      manifestTranscript: invalidCache.transcript,
      cachedTranscriptText: invalidCache.text,
    });

    const result = await runPipeline({
      input: sourcePath,
      cwd: root,
      env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    }, harness.services);

    assert.equal(result.segments[0].text, "Whisper words");
    assert.equal(harness.calls.filter((call) => call === "transcribe").length, 1);
    assert.doesNotMatch(JSON.stringify(result.segments), /caption poison/);
  });
}

for (const aliasKind of ["direct", "symlink", "hard-link"]) {
  test(`rejects a returned ${aliasKind} audio alias of the local source`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-alias-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "lesson.mov");
    const sidecarPath = path.join(root, "lesson.vtt");
    await writeFile(sourcePath, "local-video");
    await writeFile(sidecarPath, captionVtt);
    const cacheDir = path.join(root, "cache", "local-fingerprint");
    await mkdir(cacheDir, { recursive: true });
    let audioAlias = sourcePath;
    if (aliasKind === "symlink") {
      audioAlias = path.join(cacheDir, "audio-link.m4a");
      await symlink(sourcePath, audioAlias);
    }
    if (aliasKind === "hard-link") {
      audioAlias = path.join(cacheDir, "audio-link.m4a");
      await link(sourcePath, audioAlias);
    }
    const harness = await makeHarness({
      kind: "local",
      root,
      sourcePath,
      captionPath: sidecarPath,
      extractedAudioPath: audioAlias,
    });

    await assert.rejects(runPipeline({
      input: sourcePath,
      cwd: root,
      env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    }, harness.services), SourceError);

    assert.equal(await readFile(sourcePath, "utf8"), "local-video");
    assert.equal(await readFile(sidecarPath, "utf8"), captionVtt);
    assert.equal((await stat(audioAlias)).isFile(), true);
    assert.deepEqual(harness.removed, []);
    assert.equal(harness.calls.includes("transcribe"), false);
  });
}

for (const aliasKind of ["symlink", "hard-link"]) {
  test(`caption timing leaves a ${aliasKind} sidecar alias immutable`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-caption-alias-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "lesson.mov");
    const sidecarPath = path.join(root, "lesson.vtt");
    const captionAlias = path.join(root, `caption-${aliasKind}.vtt`);
    await writeFile(sourcePath, "local-video");
    await writeFile(sidecarPath, captionVtt);
    if (aliasKind === "symlink") await symlink(sidecarPath, captionAlias);
    else await link(sidecarPath, captionAlias);
    const harness = await makeHarness({
      kind: "local",
      root,
      sourcePath,
      captionPath: captionAlias,
    });

    const result = await runPipeline({
      input: sourcePath,
      cwd: root,
      env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    }, harness.services);

    assert.equal(result.status, "complete");
    assert.equal(await readFile(sidecarPath, "utf8"), captionVtt);
    assert.equal(await readFile(captionAlias, "utf8"), captionVtt);
  });
}

for (const aliasKind of ["symlink", "hard-link"]) {
  test(`rejects audio extraction before its cache destination can overwrite a ${aliasKind} caption alias`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-caption-destination-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "lesson.mov");
    const sidecarPath = path.join(root, "lesson.vtt");
    await writeFile(sourcePath, "local-video");
    await writeFile(sidecarPath, captionVtt);
    const before = await stat(sidecarPath);
    const harness = await makeHarness({
      kind: "local",
      root,
      sourcePath,
      captionPath: sidecarPath,
    });
    const audioPath = path.join(harness.cacheDir, "audio.m4a");
    if (aliasKind === "symlink") await symlink(sidecarPath, audioPath);
    else await link(sidecarPath, audioPath);

    await assert.rejects(runPipeline({
      input: sourcePath,
      cwd: root,
      env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    }, harness.services), SourceError);

    const after = await stat(sidecarPath);
    assert.deepEqual({ dev: after.dev, ino: after.ino }, { dev: before.dev, ino: before.ino });
    assert.equal(await readFile(sidecarPath, "utf8"), captionVtt);
    assert.equal(await readFile(audioPath, "utf8"), captionVtt);
    assert.equal(harness.calls.includes("extract-audio"), false);
  });
}

test("rejects a returned temporary path that directly aliases the local caption", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-returned-caption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "lesson.mov");
  const sidecarPath = path.join(root, "lesson.vtt");
  await writeFile(sourcePath, "local-video");
  await writeFile(sidecarPath, captionVtt);
  const before = await stat(sidecarPath);
  const harness = await makeHarness({
    kind: "local",
    root,
    sourcePath,
    captionPath: sidecarPath,
    extractedAudioPath: sidecarPath,
  });

  await assert.rejects(runPipeline({
    input: sourcePath,
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
  }, harness.services), SourceError);

  const after = await stat(sidecarPath);
  assert.deepEqual({ dev: after.dev, ino: after.ino }, { dev: before.dev, ino: before.ino });
  assert.equal(await readFile(sidecarPath, "utf8"), captionVtt);
  assert.equal(harness.calls.includes("transcribe"), false);
  assert.deepEqual(harness.removed, []);
});

for (const aliasKind of ["symlink", "hard-link"]) {
  test(`successful cleanup skips an audio target replaced by a ${aliasKind} caption alias`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-cleanup-caption-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "lesson.mov");
    const sidecarPath = path.join(root, "lesson.vtt");
    await writeFile(sourcePath, "local-video");
    await writeFile(sidecarPath, captionVtt);
    const sidecarBefore = await stat(sidecarPath);
    let audioPath;
    const harness = await makeHarness({
      kind: "local",
      root,
      sourcePath,
      captionPath: sidecarPath,
      renderHook: async () => {
        await rm(audioPath);
        if (aliasKind === "symlink") await symlink(sidecarPath, audioPath);
        else await link(sidecarPath, audioPath);
      },
    });
    audioPath = path.join(harness.cacheDir, "audio.m4a");

    const result = await runPipeline({
      input: sourcePath,
      cwd: root,
      env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    }, harness.services);

    assert.equal(result.status, "complete");
    assert.equal(await readFile(sidecarPath, "utf8"), captionVtt);
    assert.equal(await readFile(audioPath, "utf8"), captionVtt);
    assert.deepEqual(
      { dev: (await stat(sidecarPath)).dev, ino: (await stat(sidecarPath)).ino },
      { dev: sidecarBefore.dev, ino: sidecarBefore.ino },
    );
    assert.deepEqual(harness.removed, []);
  });
}

test("protected cleanup bypasses the former identity-validation and removal gap", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-cleanup-removal-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "lesson.mov");
  const sidecarPath = path.join(root, "lesson.vtt");
  await writeFile(sourcePath, "local-video");
  await writeFile(sidecarPath, captionVtt);
  const sidecarBefore = await stat(sidecarPath);
  const warnings = [];
  let rendered = false;
  let swapped = false;
  const harness = await makeHarness({
    kind: "local",
    root,
    sourcePath,
    captionPath: sidecarPath,
    renderHook: async () => { rendered = true; },
  });
  const audioPath = path.join(harness.cacheDir, "audio.m4a");
  const matchIdentity = harness.services.pathMatchesFileIdentity;
  harness.services.pathMatchesFileIdentity = async (file, protectedFile) => {
    const matches = await matchIdentity(file, protectedFile);
    if (rendered
      && !swapped
      && file === audioPath
      && protectedFile.label === "caption") {
      unlinkSync(audioPath);
      linkSync(sidecarPath, audioPath);
      swapped = true;
    }
    return matches;
  };
  const unsafeRemove = harness.services.removeTemporary;
  harness.services.removeTemporary = async (file, options) => {
    if (!options?.expectedIdentity) return unsafeRemove(file);
    const current = lstatSync(file);
    if (current.dev !== options.expectedIdentity.dev
      || current.ino !== options.expectedIdentity.ino) {
      throw new Error("temporary file ownership changed before removal");
    }
    unlinkSync(file);
    return undefined;
  };

  const completed = await runPipeline({
    input: sourcePath,
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    onWarning: (message) => warnings.push(message),
  }, harness.services);

  assert.equal(completed.status, "complete");
  assert.equal(swapped, false);
  assert.equal(await readFile(sidecarPath, "utf8"), captionVtt);
  assert.equal(await readFile(audioPath, "utf8"), "audio");
  const sidecarAfter = await stat(sidecarPath);
  assert.deepEqual(
    { dev: sidecarAfter.dev, ino: sidecarAfter.ino },
    { dev: sidecarBefore.dev, ino: sidecarBefore.ino },
  );
  assert.deepEqual(warnings, [
    `Retained temporary file ${audioPath}: protected local cleanup cannot prove atomic removal`,
  ]);
});

test("protected local cleanup retains owned audio without entering the mutable remove boundary", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-cleanup-conservative-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "lesson.mov");
  const sidecarPath = path.join(root, "lesson.vtt");
  await writeFile(sourcePath, "local-video");
  await writeFile(sidecarPath, captionVtt);
  const warnings = [];
  let removeCalls = 0;
  const harness = await makeHarness({
    kind: "local",
    root,
    sourcePath,
    captionPath: sidecarPath,
  });
  const audioPath = path.join(harness.cacheDir, "audio.m4a");
  harness.services.removeTemporary = async (file) => {
    removeCalls += 1;
    await rm(file, { force: true });
    await link(sidecarPath, file);
    await rm(file, { force: true });
  };

  const completed = await runPipeline({
    input: sourcePath,
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    onWarning: (message) => warnings.push(message),
  }, harness.services);

  assert.equal(completed.status, "complete");
  assert.equal(removeCalls, 0);
  assert.equal(await readFile(audioPath, "utf8"), "audio");
  assert.equal(await readFile(sidecarPath, "utf8"), captionVtt);
  assert.deepEqual(warnings, [
    `Retained temporary file ${audioPath}: protected local cleanup cannot prove atomic removal`,
  ]);
});

for (const relation of ["equal", "descendant", "ancestor", "symlink alias"]) {
  test(`rejects output with ${relation} canonical overlap with the fingerprint cache`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-isolation-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const harness = await makeHarness({ kind: "youtube", root });
    let output = harness.cacheDir;
    if (relation === "descendant") output = path.join(harness.cacheDir, "site");
    if (relation === "ancestor") output = path.dirname(harness.cacheDir);
    if (relation === "symlink alias") {
      output = path.join(root, "cache-alias");
      await symlink(harness.cacheDir, output);
    }

    await assert.rejects(runPipeline({
      input: "https://youtu.be/abc",
      output,
      cwd: root,
      env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    }, harness.services), OutputConflictError);

    assert.equal(harness.calls.includes("download-media"), false);
  });
}

test("rejects a generated output that canonically contains its fingerprint cache", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-default-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "lesson.mov");
  const sidecarPath = path.join(root, "lesson.vtt");
  await writeFile(sourcePath, "local-video");
  await writeFile(sidecarPath, captionVtt);
  const harness = await makeHarness({
    kind: "local",
    root,
    sourcePath,
    captionPath: sidecarPath,
    cacheRoot: path.join(root, "lesson"),
  });

  await assert.rejects(runPipeline({
    input: sourcePath,
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
  }, harness.services), OutputConflictError);

  assert.equal(harness.calls.includes("probe-media"), false);
});

test("keeps a completed result and warns while continuing best-effort cleanup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-cleanup-warning-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const warnings = [];
  const harness = await makeHarness({
    kind: "youtube",
    root,
    removalFailures: ["audio.m4a"],
  });

  const result = await runPipeline({
    input: "https://youtu.be/abc",
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    onWarning: (message) => warnings.push(message),
  }, harness.services);

  assert.equal(result.status, "complete");
  assert.deepEqual(
    harness.removed.map((file) => path.basename(file)),
    ["source.webm", "audio.m4a"],
  );
  await assert.rejects(stat(harness.videoPath));
  assert.equal(await readFile(path.join(harness.cacheDir, "audio.m4a"), "utf8"), "audio");
  assert.deepEqual(warnings, [
    `Unable to remove temporary file ${path.join(harness.cacheDir, "audio.m4a")}: cannot remove audio.m4a`,
  ]);
  assert.equal(Object.hasOwn(result, "warnings"), false);
});

test("protected cleanup never invokes a fallible identity probe after completion", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-cleanup-identity-warning-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "lesson.mov");
  const sidecarPath = path.join(root, "lesson.vtt");
  await writeFile(sourcePath, "local-video");
  await writeFile(sidecarPath, captionVtt);
  let rendered = false;
  const warnings = [];
  const harness = await makeHarness({
    kind: "local",
    root,
    sourcePath,
    captionPath: sidecarPath,
    renderHook: async () => { rendered = true; },
  });
  const matchIdentity = harness.services.pathMatchesFileIdentity;
  harness.services.pathMatchesFileIdentity = async (...args) => {
    if (rendered) throw new Error("identity probe failed");
    return matchIdentity(...args);
  };

  const result = await runPipeline({
    input: sourcePath,
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
    onWarning: (message) => warnings.push(message),
  }, harness.services);

  assert.equal(result.status, "complete");
  assert.deepEqual(harness.removed, []);
  assert.deepEqual(warnings, [
    `Retained temporary file ${path.join(harness.cacheDir, "audio.m4a")}: protected local cleanup cannot prove atomic removal`,
  ]);
  assert.equal(await readFile(sourcePath, "utf8"), "local-video");
  assert.equal(await readFile(sidecarPath, "utf8"), captionVtt);
});

test("does not clean a downloaded path outside the fingerprint cache", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-cleanup-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outsideVideo = path.join(root, "outside.webm");
  const harness = await makeHarness({
    kind: "youtube",
    root,
    downloadedVideoPath: outsideVideo,
  });

  const result = await runPipeline({
    input: "https://youtu.be/abc",
    cwd: root,
    env: { XDG_CACHE_HOME: path.join(root, "cache-parent") },
  }, harness.services);

  assert.equal(result.status, "complete");
  assert.equal(await readFile(outsideVideo, "utf8"), "youtube-video");
  assert.deepEqual(harness.removed.map((file) => path.basename(file)), ["audio.m4a"]);
});
