import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractFrames } from "../src/frames.mjs";
import { captureFileIdentity } from "../src/fs.mjs";
import { probeMedia } from "../src/media.mjs";
import { renderOutput } from "../src/render.mjs";
import { buildCapturePlan } from "../src/timeline.mjs";
import { detectSceneChanges, listFrameTimestamps } from "../src/visual-timing.mjs";
import { openWorkspace } from "../src/workspace.mjs";
import {
  createFixtureVideo,
  createObservedRealRunner,
} from "./helpers/ffmpeg-fixture.mjs";

const nativeDimensions = Object.freeze({ width: 640, height: 360 });
const segments = Object.freeze([
  Object.freeze({ startMs: 0, endMs: 5_000, text: "Whisper first <trusted>" }),
  Object.freeze({ startMs: 3_000, endMs: 5_500, text: "Whisper second & trusted" }),
]);
const captionCues = Object.freeze([
  Object.freeze({
    startMs: 4_200,
    endMs: 4_300,
    text: "CAPTION POISON MUST NOT RENDER",
  }),
]);

function identity(info) {
  return { dev: info.dev, ino: info.ino };
}

async function outputInventory(outputDir) {
  const files = [];
  const directories = [];
  const visit = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        directories.push(relative);
        await visit(path.join(directory, entry.name), relative);
      } else {
        files.push(relative);
      }
    }
  };
  await visit(outputDir);
  return { files: files.sort(), directories: directories.sort() };
}

test("real hard cuts add coalesced native JPEGs through owned stages and render only Whisper text", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-ffmpeg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = await createFixtureVideo(root);
  const videoBefore = await stat(videoPath);
  const protectedVideo = {
    label: "video",
    path: videoPath,
    ...(await captureFileIdentity(videoPath)),
  };
  const observed = createObservedRealRunner();

  const media = await probeMedia(videoPath, { run: observed.run });
  assert.deepEqual(
    { width: media.width, height: media.height },
    nativeDimensions,
  );
  assert.equal(media.hasAudio, true);
  assert.ok(Math.abs(media.durationMs - 6_000) < 100, media.durationMs);

  const sceneTimes = await detectSceneChanges(videoPath, { run: observed.run });
  assert.ok(sceneTimes.some((value) => Math.abs(value - 2_000) < 300), sceneTimes);
  assert.ok(sceneTimes.some((value) => Math.abs(value - 4_000) < 300), sceneTimes);
  const frameTimes = await listFrameTimestamps(videoPath, { run: observed.run });
  const captures = buildCapturePlan({
    segments,
    captionCues,
    sceneTimes,
    frameTimes,
    durationMs: media.durationMs,
  });

  for (const segmentIndex of segments.keys()) {
    assert.ok(captures.some((capture) => capture.associations.some((association) =>
      association.segmentIndex === segmentIndex
        && association.reasons.includes("primary"))), `missing segment ${segmentIndex} primary`);
  }
  const sceneCaptures = captures.filter((capture) => capture.reasons.includes("scene"));
  assert.ok(sceneCaptures.some((capture) => Math.abs(capture.requestedMs - 2_250) < 300));
  assert.ok(sceneCaptures.some((capture) => Math.abs(capture.requestedMs - 4_250) < 300));
  const coalesced = captures.find((capture) =>
    capture.reasons.includes("scene") && capture.reasons.includes("caption"));
  assert.ok(coalesced, "scene and caption timing should share one decoded frame");
  assert.equal(Object.hasOwn(coalesced, "segmentIndex"), false);
  assert.equal(coalesced.requestedMs, 4_250);
  assert.equal(coalesced.timestampMs, 4_300);
  assert.deepEqual(coalesced.reasons, ["primary", "scene", "caption"]);
  assert.deepEqual(
    coalesced.associations,
    [
      {
        segmentIndex: 0,
        requestedMs: 4_250,
        reasons: ["scene", "caption"],
      },
      {
        segmentIndex: 1,
        requestedMs: 4_250,
        reasons: ["primary"],
      },
    ],
  );

  const source = {
    kind: "local",
    input: videoPath,
    fingerprint: "real-ffmpeg-fixture",
    title: "Real FFmpeg fixture",
    durationMs: media.durationMs,
    width: media.width,
    height: media.height,
  };
  const outputDir = path.join(root, "output");
  const workspace = await openWorkspace({
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir,
    source,
    protectedFiles: [protectedVideo],
  });
  assert.ok(path.relative(outputDir, workspace.retentionDir).startsWith(".."));
  let manifest = await workspace.loadManifest();
  manifest = await workspace.saveManifest({
    ...manifest,
    transcript: { engine: "mlx-whisper", filename: "transcript.vtt" },
    segments: [...segments],
  }, { expectedManifest: manifest });

  manifest = await extractFrames({
    videoPath,
    captures,
    workspace,
    manifest,
    run: observed.run,
    log: { info() {} },
  });
  assert.equal(manifest.images.length, captures.length);
  assert.equal(new Set(manifest.images.map((image) => image.filename)).size, captures.length);
  for (const image of manifest.images) {
    assert.deepEqual({ width: image.width, height: image.height }, nativeDimensions);
    assert.equal(Object.hasOwn(image, "segmentIndex"), false);
    assert.ok(image.associations.length > 0);
    const jpeg = await readFile(path.join(workspace.imagesDir, image.filename));
    assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.deepEqual([...jpeg.subarray(-2)], [0xff, 0xd9]);
  }

  const screenshots = observed.invocations.filter((invocation) =>
    invocation.stageBefore !== undefined);
  assert.equal(screenshots.length, manifest.images.length);
  for (const invocation of screenshots) {
    assert.equal(invocation.code, 0);
    assert.match(
      path.basename(path.dirname(invocation.outputPath)),
      /^\.v2w-frame-stage-[0-9a-f-]+$/u,
    );
    assert.ok(invocation.args.includes("-y"));
    const qualityIndex = invocation.args.indexOf("-q:v");
    assert.equal(invocation.args[qualityIndex + 1], "2");
    assert.equal(invocation.args.includes("-s"), false);
    assert.equal(invocation.args.includes("-vf"), false);
    assert.equal(invocation.args.includes("-filter:v"), false);
    assert.equal(invocation.args.includes("-filter_complex"), false);
    assert.equal(invocation.args.some((argument) => argument.includes("scale=")), false);
    assert.deepEqual(
      {
        size: invocation.stageBefore.size,
        nlink: invocation.stageBefore.nlink,
        isFile: invocation.stageBefore.isFile,
        isSymbolicLink: invocation.stageBefore.isSymbolicLink,
      },
      { size: 0, nlink: 1, isFile: true, isSymbolicLink: false },
    );
    assert.deepEqual(
      identity(invocation.stageAfter),
      identity(invocation.stageBefore),
    );
    assert.ok(invocation.stageAfter.size > 0);
    const published = await stat(path.join(workspace.imagesDir, path.basename(invocation.outputPath)));
    assert.deepEqual(identity(published), identity(invocation.stageAfter));
    await assert.rejects(lstat(invocation.outputPath), { code: "ENOENT" });
  }

  const transcriptVttPath = path.join(root, "transcript.vtt");
  await writeFile(
    transcriptVttPath,
    "WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nWhisper first <trusted>\n\n"
      + "00:00:03.000 --> 00:00:05.500\nWhisper second & trusted\n",
  );
  manifest = await renderOutput({ workspace, manifest, segments, transcriptVttPath });
  assert.equal(manifest.status, "complete");
  const durableManifest = JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8"));
  assert.deepEqual(durableManifest, manifest);
  assert.equal(durableManifest.images.every((image) =>
    image.width === nativeDimensions.width && image.height === nativeDimensions.height), true);
  const html = await readFile(path.join(outputDir, "index.html"), "utf8");
  assert.match(html, /Whisper first &lt;trusted&gt;/);
  assert.match(html, /Whisper second &amp; trusted/);
  assert.doesNotMatch(html, /CAPTION POISON MUST NOT RENDER/);
  assert.doesNotMatch(html, /<video|<audio/i);
  const logicalSources = [...html.matchAll(/<img[^>]+src="(images\/[^"]+\.jpg)"/g)]
    .map((match) => match[1]);
  const uniqueSources = [...new Set(logicalSources)].sort();
  const physicalSources = manifest.images
    .map((image) => `images/${image.filename}`)
    .sort();
  assert.ok(manifest.images.some((image) => image.associations.length > 1));
  assert.equal(
    logicalSources.length,
    manifest.images.reduce((total, image) => total + image.associations.length, 0),
  );
  assert.ok(logicalSources.length > uniqueSources.length);
  assert.deepEqual(uniqueSources, physicalSources);
  for (const reference of uniqueSources) {
    assert.ok((await stat(path.join(outputDir, reference))).size > 0);
  }

  const inventory = await outputInventory(outputDir);
  assert.deepEqual(inventory.directories, ["images"]);
  assert.deepEqual(inventory.files, [
    "index.html",
    "manifest.json",
    "styles.css",
    "transcript.vtt",
    ...physicalSources,
  ].sort());
  assert.equal(inventory.files.some((file) =>
    /(?:\.part-|\.v2w-frame-stage-|retention|\.(?:mp4|m4a|wav))$/u.test(file)), false);
  assert.deepEqual(identity(await stat(videoPath)), identity(videoBefore));
  assert.equal((await stat(videoPath)).size, videoBefore.size);

  if (process.env.V2W_FFMPEG_DIAGNOSTICS === "1") {
    t.diagnostic(JSON.stringify({
      media,
      sceneTimes,
      captures,
      screenshotInvocations: screenshots.map((invocation) => ({
        args: invocation.args,
        code: invocation.code,
        stageBefore: invocation.stageBefore,
        stageAfter: invocation.stageAfter,
      })),
      completedImages: manifest.images,
      logicalImageReferences: logicalSources.length,
      uniqueImageReferences: uniqueSources,
      inventory,
      retentionDir: workspace.retentionDir,
    }, null, 2));
  }
});
