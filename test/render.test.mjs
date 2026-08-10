import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OutputConflictError } from "../src/errors.mjs";
import {
  escapeHtml,
  renderOutput,
  renderPage,
  youtubeTimestampUrl,
} from "../src/render.mjs";
import { openWorkspace } from "../src/workspace.mjs";

const segments = [
  {
    startMs: 1_000,
    endMs: 5_000,
    text: "Whisper says <buy> & hold",
  },
  {
    startMs: 5_000,
    endMs: 9_000,
    text: "Second <segment>",
  },
];

const sharedImage = {
  timestampMs: 3_000,
  requestedMs: 3_000,
  reasons: ["primary", "caption"],
  associations: [
    { segmentIndex: 0, requestedMs: 3_000, reasons: ["primary"] },
    { segmentIndex: 1, requestedMs: 3_100, reasons: ["caption"] },
  ],
  filename: "000003000-primary.jpg",
  width: 1_920,
  height: 1_080,
};

const manifest = {
  schemaVersion: 1,
  status: "building",
  source: {
    kind: "youtube",
    title: "A & B \"<unsafe>\"",
    webpageUrl: "https://www.youtube.com/watch?v=abc&list=one",
    fingerprint: "abc",
  },
  transcript: { engine: "mlx-whisper", filename: "cached.vtt" },
  segments,
  captionCues: [{ startMs: 1_000, endMs: 2_000, text: "caption cue words that must not render" }],
  images: [
    sharedImage,
    {
      timestampMs: 7_000,
      requestedMs: 7_000,
      reasons: ["scene"],
      associations: [{ segmentIndex: 1, requestedMs: 7_000, reasons: ["scene"] }],
      filename: "000007000-scene.jpg",
      width: 1_280,
      height: 720,
    },
  ],
};

async function createRenderableWorkspace(t, { engine = "mlx-whisper" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-render-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "video.mov");
  await writeFile(videoPath, "video-bytes");
  const source = {
    kind: "local",
    input: videoPath,
    fingerprint: `render-${path.basename(root)}`,
    title: "Local render",
    durationMs: 9_000,
    width: 1_920,
    height: 1_080,
  };
  const workspace = await openWorkspace({
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  });
  let building = await workspace.loadManifest();
  building = await workspace.saveManifest({
    ...building,
    transcript: { engine, filename: "cached.vtt" },
    segments,
  });
  for (const image of manifest.images) {
    building = await workspace.recordFrame(building, structuredClone(image));
    await writeFile(path.join(workspace.imagesDir, image.filename), "jpeg-bytes");
  }
  return { root, workspace, building };
}

test("renders escaped Whisper content and association-aware screenshot galleries", () => {
  const html = renderPage({ manifest, segments });

  assert.match(html, /A &amp; B &quot;&lt;unsafe&gt;&quot;/);
  assert.match(html, /Whisper says &lt;buy&gt; &amp; hold/);
  assert.match(html, /Second &lt;segment&gt;/);
  assert.doesNotMatch(html, /caption cue words that must not render/);
  assert.match(html, /<span class="reason">primary<\/span>/);
  assert.match(html, /<span class="reason">caption<\/span>/);
  assert.match(html, /<span class="reason">scene<\/span>/);

  const sharedReferences = html.match(/images\/000003000-primary\.jpg/g) ?? [];
  assert.equal(sharedReferences.length, 4, "one href and src for each associated segment");
  const imageSources = [...html.matchAll(/<img[^>]+src="(images\/[^\"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(imageSources)].sort(), [
    "images/000003000-primary.jpg",
    "images/000007000-scene.jpg",
  ]);
  assert.match(html, /2 screenshots/);
  assert.doesNotMatch(html, /<video|<audio/i);
});

test("uses safe YouTube links and local time elements for segment timestamps", () => {
  const youtubeHtml = renderPage({ manifest, segments });
  assert.match(
    youtubeHtml,
    /href="https:\/\/www\.youtube\.com\/watch\?v=abc&amp;list=one&amp;t=1"/,
  );
  assert.match(youtubeHtml, />00:00:01\.000<\/a>/);
  assert.match(youtubeHtml, /href="https:\/\/www\.youtube\.com\/watch\?v=abc&amp;list=one&amp;t=5">00:00:05\.000<\/a>/);
  assert.equal(
    youtubeTimestampUrl("https://www.youtube.com/watch?v=abc&list=one", 4_250),
    "https://www.youtube.com/watch?v=abc&list=one&t=4",
  );
  assert.equal(escapeHtml("\"'<> &"), "&quot;&#39;&lt;&gt; &amp;");
  assert.throws(() => youtubeTimestampUrl("javascript:alert(1)", 1_000), TypeError);

  const localHtml = renderPage({
    manifest: {
      ...manifest,
      source: { kind: "local", title: "Local <clip>", input: "/video.mov", fingerprint: "local" },
    },
    segments,
  });
  assert.match(localHtml, /<time datetime="PT1S">00:00:01\.000<\/time>/);
  assert.doesNotMatch(localHtml, /youtube\.com/);
});

test("encodes contained image filenames as single URL path segments", () => {
  const html = renderPage({
    manifest: {
      ...manifest,
      images: [{
        ...sharedImage,
        filename: "frame#?%.jpg",
        associations: [{ segmentIndex: 0, requestedMs: 3_000, reasons: ["primary"] }],
      }],
    },
    segments: [segments[0]],
  });

  assert.match(html, /href="images\/frame%23%3F%25\.jpg"/);
  assert.match(html, /src="images\/frame%23%3F%25\.jpg"/);
});

test("renders a valid zero-based segment timestamp", () => {
  const html = renderPage({
    manifest: {
      ...manifest,
      source: { kind: "local", title: "Local", input: "/video.mov", fingerprint: "local" },
    },
    segments: [{ ...segments[0], startMs: 0 }],
  });

  assert.match(html, /<time datetime="PT0S">00:00:00\.000<\/time>/);
});

test("publishes assets and building metadata before one final completion write", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-render-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const transcriptVttPath = path.join(dir, "cached.vtt");
  await writeFile(transcriptVttPath, "WEBVTT\n\ncaption cue words that must not render\n");
  const writes = [];
  const workspace = {
    outputDir: path.join(dir, "output"),
    async withRenderLease(value, operation) {
      return operation({
        manifest: value,
        saveManifest: this.saveManifest.bind(this),
        markComplete: this.markComplete.bind(this),
      });
    },
    async saveManifest(value) {
      writes.push({ type: "save", value });
      assert.equal(await readFile(path.join(this.outputDir, "transcript.vtt"), "utf8"), await readFile(transcriptVttPath, "utf8"));
      assert.ok((await readFile(path.join(this.outputDir, "styles.css"), "utf8")).length > 0);
      return { ...value, revision: 8 };
    },
    async markComplete(value) {
      writes.push({ type: "complete", value });
      assert.ok((await readFile(path.join(this.outputDir, "index.html"), "utf8")).length > 0);
      return { ...value, status: "complete", revision: 9 };
    },
  };
  await mkdir(workspace.outputDir, { recursive: true });

  const completed = await renderOutput({ workspace, manifest, segments, transcriptVttPath });
  assert.equal(completed.status, "complete");
  assert.equal(writes.filter((write) => write.type === "complete").length, 1);
  assert.deepEqual(writes.map((write) => write.type), ["save", "complete"]);
  assert.equal(writes[0].value.transcript.filename, "transcript.vtt");
  assert.deepEqual(writes[0].value.segments, segments);
});

test("stops before later writes when an earlier render publication step fails", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-render-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outputDir = path.join(dir, "output");
  await mkdir(outputDir);
  let completions = 0;
  const workspace = {
    outputDir,
    async withRenderLease(value, operation) {
      return operation({
        manifest: value,
        saveManifest: this.saveManifest.bind(this),
        markComplete: this.markComplete.bind(this),
      });
    },
    async saveManifest() {
      throw new Error("manifest write failed");
    },
    async markComplete() {
      completions += 1;
    },
  };
  const transcriptVttPath = path.join(dir, "cached.vtt");
  await writeFile(transcriptVttPath, "WEBVTT\n");

  await assert.rejects(renderOutput({ workspace, manifest, segments, transcriptVttPath }), /manifest write failed/);
  assert.equal(completions, 0);
  assert.equal(await readFile(path.join(outputDir, "transcript.vtt"), "utf8"), "WEBVTT\n");
  await assert.rejects(access(path.join(outputDir, "index.html")));
});

test("completes a real association-aware workspace without duplicating physical screenshots", async (t) => {
  const { root, workspace, building } = await createRenderableWorkspace(t);
  const transcriptVttPath = path.join(root, "cached.vtt");
  await writeFile(transcriptVttPath, "WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nWhisper text\n");

  const complete = await renderOutput({ workspace, manifest: building, segments, transcriptVttPath });
  const html = await readFile(path.join(workspace.outputDir, "index.html"), "utf8");

  assert.equal(complete.status, "complete");
  assert.equal((await workspace.loadManifest()).status, "complete");
  assert.equal((html.match(/images\/000003000-primary\.jpg/g) ?? []).length, 4);
  assert.match(html, /2 screenshots/);
});

test("rejects stale completed rendering before it can overwrite published assets", async (t) => {
  const { root, workspace, building } = await createRenderableWorkspace(t);
  const firstTranscript = path.join(root, "first.vtt");
  const staleTranscript = path.join(root, "stale.vtt");
  await writeFile(firstTranscript, "WEBVTT\n\nfirst transcript\n");
  await writeFile(staleTranscript, "WEBVTT\n\nstale transcript\n");
  await renderOutput({ workspace, manifest: building, segments, transcriptVttPath: firstTranscript });

  await assert.rejects(
    renderOutput({ workspace, manifest: building, segments, transcriptVttPath: staleTranscript }),
    OutputConflictError,
  );
  assert.equal(await readFile(path.join(workspace.outputDir, "transcript.vtt"), "utf8"), "WEBVTT\n\nfirst transcript\n");
});

test("concurrent same-revision renders leave artifacts from the sole completed attempt", async (t) => {
  const { root, workspace, building } = await createRenderableWorkspace(t);
  const firstTranscript = path.join(root, "first.vtt");
  const secondTranscript = path.join(root, "second.vtt");
  const firstText = "WEBVTT\n\nfirst concurrent transcript\n";
  const secondText = "WEBVTT\n\nsecond concurrent transcript\n";
  await writeFile(firstTranscript, firstText);
  await writeFile(secondTranscript, secondText);

  const outcomes = await Promise.allSettled([
    renderOutput({ workspace, manifest: building, segments, transcriptVttPath: firstTranscript }),
    renderOutput({ workspace, manifest: building, segments, transcriptVttPath: secondTranscript }),
  ]);
  const winner = outcomes.findIndex((outcome) => outcome.status === "fulfilled");

  assert.notEqual(winner, -1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(
    await readFile(path.join(workspace.outputDir, "transcript.vtt"), "utf8"),
    winner === 0 ? firstText : secondText,
  );
});

test("rejects malformed associations and blank engine before publishing assets", async (t) => {
  for (const mutate of [
    (value) => ({
      ...value,
      images: [{ ...value.images[0], associations: [
        ...value.images[0].associations,
        { segmentIndex: 0, requestedMs: 3_001, reasons: ["primary"] },
      ] }],
    }),
    (value) => ({ ...value, transcript: { ...value.transcript, engine: "  " } }),
  ]) {
    const { root, workspace, building } = await createRenderableWorkspace(t);
    const transcriptVttPath = path.join(root, "candidate.vtt");
    await writeFile(transcriptVttPath, "WEBVTT\n\ncandidate\n");
    await assert.rejects(
      renderOutput({ workspace, manifest: mutate(building), segments, transcriptVttPath }),
      OutputConflictError,
    );
    await assert.rejects(access(path.join(workspace.outputDir, "transcript.vtt")));
    await assert.rejects(access(path.join(workspace.outputDir, "styles.css")));
    await assert.rejects(access(path.join(workspace.outputDir, "index.html")));
  }
});
