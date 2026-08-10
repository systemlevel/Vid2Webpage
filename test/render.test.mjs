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

import {
  escapeHtml,
  renderOutput,
  renderPage,
  youtubeTimestampUrl,
} from "../src/render.mjs";

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
