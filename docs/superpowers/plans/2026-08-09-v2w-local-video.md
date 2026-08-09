# v2w Local Video Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `v2w` CLI that turns either a YouTube URL or a local video into a Whisper-authored transcript webpage with complete native-resolution screenshot coverage.

**Architecture:** A dependency-free Node 20+ ESM CLI coordinates focused source, media, transcription, quality, timeline, frame, manifest, and rendering modules. Whisper VTT supplies authoritative text and primary screenshot timing; optional caption cues and FFmpeg scene changes add frames without replacing a segment midpoint.

**Tech Stack:** Node.js 20+ ESM and built-in test runner, FFmpeg/FFprobe, `yt-dlp`, MLX Whisper `large-v3-turbo`, optional whisper.cpp fallback, static HTML/CSS.

## Global Constraints

- The public command is `v2w <youtube-url-or-local-file> [--output <directory>]`.
- The supported remote source is YouTube; reject generic HTTP media URLs.
- Local source files are read-only and must never be moved, changed, or deleted.
- Displayed transcript text always comes from Whisper timed VTT; caption text is timing-only and is never displayed.
- Every Whisper segment gets a required midpoint screenshot.
- Caption-cue midpoints and FFmpeg scene changes may add screenshots but never replace a required midpoint.
- Coalesce only candidates that resolve to the exact same decoded frame; do not use perceptual deduplication.
- Screenshots use FFmpeg JPEG quality `-q:v 2`, no scale filter, and retain native dimensions and aspect ratio.
- Final output contains HTML, CSS, VTT, JSON manifest, and screenshots—no video or audio.
- MLX Whisper uses `mlx-community/whisper-large-v3-turbo`; retry degraded output with previous-text conditioning disabled.
- If every engine fails or degradation survives retry, exit nonzero and do not mark the page complete.
- Runtime code has no npm dependencies and invokes processes with argument arrays, never interpolated shell commands.
- The manifest's atomic `status: "complete"` write is the sole completion marker.
- Normal automated tests do not download models or call YouTube.

## File Structure

| Path | Responsibility |
| --- | --- |
| `package.json` | Node 20 package, tests, and final `v2w` bin mapping |
| `bin/v2w.mjs` | Thin executable that delegates to `runCli` |
| `src/errors.mjs` | Typed operational errors and exit semantics |
| `src/args.mjs` | CLI parsing and safe default output names |
| `src/source.mjs` | Input classification and stable source fingerprints |
| `src/process.mjs` | Spawn/timeout wrapper and command discovery |
| `src/fs.mjs` | Atomic writes/copies and nonempty-file validation |
| `src/preflight.mjs` | Required-tool and Whisper-engine validation |
| `src/media.mjs` | FFprobe metadata, audio extraction, local caption discovery |
| `src/youtube.mjs` | YouTube metadata, media download, optional captions |
| `src/vtt.mjs` | VTT/SRT parsing, cue text, and timestamp formatting |
| `src/quality.mjs` | Repetition/fragmentation detection |
| `src/vocab.txt` | Optional project-local Whisper vocabulary prompt |
| `src/transcribe.mjs` | MLX/whisper.cpp timed-VTT engine cascade |
| `src/visual-timing.mjs` | Scene detection and decoded-frame PTS discovery |
| `src/timeline.mjs` | Multi-signal candidate planning and segment association |
| `src/workspace.mjs` | Cache paths, output compatibility, and resumable manifest |
| `src/frames.mjs` | Atomic native-resolution screenshot extraction |
| `src/render.mjs` | Safe HTML/CSS/VTT output and final completion update |
| `src/page.css` | Responsive transcript and screenshot-gallery styles |
| `src/app.mjs` | End-to-end orchestration with injectable services |
| `src/cli.mjs` | Progress/error presentation and process exit code |
| `test/*.test.mjs` | Unit and integration tests by module |
| `test/helpers/*.mjs` | Fake runner and generated FFmpeg fixture helpers |

---

### Task 1: Establish the Node package and CLI contract

**Files:**
- Create: `package.json`
- Create: `src/errors.mjs`
- Create: `src/args.mjs`
- Create: `test/args.test.mjs`

**Interfaces:**
- Produces: `UsageError extends V2wError`
- Produces: `parseCliArgs(argv) -> { input: string, output?: string, help: boolean }`
- Produces: `safeOutputName(label) -> string`

- [ ] **Step 1: Write failing argument and slug tests**

~~~js
import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs, safeOutputName } from "../src/args.mjs";
import { UsageError } from "../src/errors.mjs";

test("parses a source and optional output directory", () => {
  assert.deepEqual(parseCliArgs(["clip.mov", "--output", "notes"]), {
    input: "clip.mov",
    output: "notes",
    help: false,
  });
  assert.deepEqual(parseCliArgs(["-h"]), { help: true });
});

test("rejects missing and extra positional arguments", () => {
  assert.throws(() => parseCliArgs([]), UsageError);
  assert.throws(() => parseCliArgs(["one.mp4", "two.mp4"]), UsageError);
});

test("creates a bounded filesystem-safe output name", () => {
  assert.equal(safeOutputName("  Café: Market / Review!  "), "cafe-market-review");
  assert.equal(safeOutputName("***"), "v2w-output");
  assert.ok(safeOutputName("x".repeat(200)).length <= 80);
});
~~~

- [ ] **Step 2: Run the focused test and confirm the red state**

Run: `node --test test/args.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/args.mjs`.

- [ ] **Step 3: Add package metadata, typed errors, and minimal parsing**

`package.json`:

~~~json
{
  "name": "vid2webpage",
  "version": "2.0.0",
  "description": "Turn a YouTube URL or local video into a transcript webpage",
  "type": "module",
  "scripts": {
    "test": "node --test"
  },
  "engines": {
    "node": ">=20"
  },
  "license": "MIT"
}
~~~

`src/errors.mjs`:

~~~js
export class V2wError extends Error {
  constructor(message, { code = "V2W_ERROR", exitCode = 1, cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class UsageError extends V2wError {
  constructor(message) {
    super(message, { code: "USAGE", exitCode: 2 });
  }
}

export class DependencyError extends V2wError {}
export class SourceError extends V2wError {}
export class TranscriptionError extends V2wError {}
export class TranscriptQualityError extends V2wError {}
export class OutputConflictError extends V2wError {}
~~~

`src/args.mjs`:

~~~js
import { parseArgs } from "node:util";

import { UsageError } from "./errors.mjs";

export function safeOutputName(label) {
  const slug = label
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "v2w-output";
}

export function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        output: { type: "string", short: "o" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (parsed.values.help) return { help: true };
  if (parsed.positionals.length !== 1) {
    throw new UsageError("Expected exactly one YouTube URL or local video path");
  }
  return {
    input: parsed.positionals[0],
    output: parsed.values.output,
    help: false,
  };
}
~~~

- [ ] **Step 4: Run the focused test and full suite**

Run: `node --test test/args.test.mjs && npm test`

Expected: 3 tests pass; the complete suite exits 0.

- [ ] **Step 5: Commit the CLI contract**

~~~sh
git add package.json src/errors.mjs src/args.mjs test/args.test.mjs
git commit -m "feat: define v2w CLI contract"
~~~

---

### Task 2: Classify sources and compute stable fingerprints

**Files:**
- Create: `src/source.mjs`
- Create: `test/source.test.mjs`

**Interfaces:**
- Consumes: `SourceError`
- Produces: `classifySource(input, { cwd }) -> LocalSource | YoutubeSource`
- Produces: `localFingerprint(source) -> Promise<string>`
- Produces: `youtubeFingerprint(videoId) -> string`
- `LocalSource = { kind: "local", input: string, path: string, stat: { size, mtimeMs } }`
- `YoutubeSource = { kind: "youtube", input: string, url: string }`

- [ ] **Step 1: Write failing source tests using a temporary local file**

~~~js
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifySource,
  localFingerprint,
  youtubeFingerprint,
} from "../src/source.mjs";
import { SourceError } from "../src/errors.mjs";

test("classifies a readable local file and both YouTube URL forms", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "clip.mov"), "video");

  const local = await classifySource("clip.mov", { cwd: dir });
  assert.equal(local.kind, "local");
  assert.equal(local.path, path.join(dir, "clip.mov"));

  assert.equal(
    (await classifySource("https://www.youtube.com/watch?v=abc123")).kind,
    "youtube"
  );
  assert.equal((await classifySource("https://youtu.be/abc123")).kind, "youtube");
});

test("rejects generic URLs, directories, and missing paths", async () => {
  await assert.rejects(
    classifySource("https://example.com/clip.mp4"),
    SourceError
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-directory-"));
  try {
    await assert.rejects(classifySource(dir), SourceError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await assert.rejects(classifySource("missing.mp4"), SourceError);
});

test("fingerprints are deterministic and source-specific", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-fingerprint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "clip.mp4"), "bytes");
  const source = await classifySource("clip.mp4", { cwd: dir });
  assert.equal(await localFingerprint(source), await localFingerprint(source));
  assert.notEqual(youtubeFingerprint("abc"), youtubeFingerprint("def"));
});
~~~

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test test/source.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/source.mjs`.

- [ ] **Step 3: Implement explicit URL validation and SHA-256 fingerprints**

~~~js
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { SourceError } from "./errors.mjs";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

function sha256(parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(String(part)).update("\0");
  return hash.digest("hex");
}

export async function classifySource(input, { cwd = process.cwd() } = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    url = null;
  }
  if (url) {
    if (!["http:", "https:"].includes(url.protocol) || !YOUTUBE_HOSTS.has(url.hostname)) {
      throw new SourceError("Only YouTube URLs are supported as remote sources");
    }
    return { kind: "youtube", input, url: url.toString() };
  }

  const resolved = path.resolve(cwd, input);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    throw new SourceError("Local video does not exist: " + resolved, { cause: error });
  }
  if (!info.isFile()) throw new SourceError("Local source is not a regular file: " + resolved);
  return {
    kind: "local",
    input,
    path: resolved,
    stat: { size: info.size, mtimeMs: info.mtimeMs },
  };
}

export async function localFingerprint(source) {
  return sha256(["local", source.path, source.stat.size, source.stat.mtimeMs]);
}

export function youtubeFingerprint(videoId) {
  return sha256(["youtube", videoId]);
}
~~~

- [ ] **Step 4: Run source tests and the full suite**

Run: `node --test test/source.test.mjs && npm test`

Expected: source tests pass; the complete suite exits 0.

- [ ] **Step 5: Commit source classification**

~~~sh
git add src/source.mjs test/source.test.mjs
git commit -m "feat: classify video sources"
~~~

---

### Task 3: Add safe process, atomic-file, cache, and dependency primitives

**Files:**
- Create: `src/process.mjs`
- Create: `src/fs.mjs`
- Create: `src/preflight.mjs`
- Create: `test/process.test.mjs`
- Create: `test/fs.test.mjs`
- Create: `test/preflight.test.mjs`

**Interfaces:**
- Consumes: `DependencyError`
- Produces: `runCommand(command, args, options) -> Promise<{ code, stdout, stderr }>`
- Produces: `commandExists(command, { run }) -> Promise<boolean>`
- Produces: `writeFileAtomic(path, data)`, `copyFileAtomic(from, to)`, `isNonEmptyFile(path)`
- Produces: `preflight(kind, { run, cacheRoot }) -> { mlx: boolean, whisperCpp: boolean, whisperModelPath: string }`
- Produces: `defaultCacheRoot({ env, homedir }) -> string`

- [ ] **Step 1: Write failing primitive tests**

~~~js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { copyFileAtomic, isNonEmptyFile, writeFileAtomic } from "../src/fs.mjs";
import { defaultCacheRoot, preflight } from "../src/preflight.mjs";
import { runCommand } from "../src/process.mjs";
import { DependencyError } from "../src/errors.mjs";

test("runCommand preserves literal arguments without a shell", async () => {
  const result = await runCommand(process.execPath, [
    "-e",
    "process.stdout.write(process.argv[1])",
    "value with spaces;$(ignored)",
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "value with spaces;$(ignored)");
});

test("atomic helpers publish complete files", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-fs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const one = path.join(dir, "one.txt");
  const two = path.join(dir, "two.txt");
  await writeFileAtomic(one, "complete");
  await copyFileAtomic(one, two);
  assert.equal(await readFile(two, "utf8"), "complete");
  assert.equal(await isNonEmptyFile(two), true);
});

test("preflight accepts MLX and requires yt-dlp only for YouTube", async () => {
  const run = async (_command, args) => ({
    code: ["ffmpeg", "ffprobe", "mlx_whisper"].includes(args[0]) ? 0 : 1,
    stdout: "",
    stderr: "",
  });
  assert.deepEqual(
    await preflight("local", { run, cacheRoot: "/cache" }),
    {
      mlx: true,
      whisperCpp: false,
      whisperModelPath: "/cache/models/ggml-large-v3-turbo.bin",
    }
  );
  await assert.rejects(preflight("youtube", { run, cacheRoot: "/cache" }), DependencyError);
});

test("cache root honors XDG_CACHE_HOME", () => {
  assert.equal(
    defaultCacheRoot({ env: { XDG_CACHE_HOME: "/xdg" }, homedir: "/home/me" }),
    "/xdg/v2w"
  );
});
~~~

Place the `runCommand` test in `test/process.test.mjs`, the atomic-helper
test in `test/fs.test.mjs`, and the preflight/cache-root tests in
`test/preflight.test.mjs`; keep the imports needed by each file.

- [ ] **Step 2: Run the three focused test files and confirm failure**

Run: `node --test test/process.test.mjs test/fs.test.mjs test/preflight.test.mjs`

Expected: FAIL because the three modules do not exist.

- [ ] **Step 3: Implement shell-free spawning, atomic siblings, and preflight**

Use `spawn(command, args, { shell: false })`, collect stdout/stderr, kill on timeout, and reject only process-start/timeout failures. Atomic helpers must write or copy to `path + ".part-" + process.pid`, then rename. `preflight` must:

~~~js
const required = kind === "youtube"
  ? ["ffmpeg", "ffprobe", "yt-dlp"]
  : ["ffmpeg", "ffprobe"];

for (const command of required) {
  if (!(await commandExists(command, { run }))) {
    throw new DependencyError(
      command + " is required" +
        (command === "ffmpeg" || command === "ffprobe"
          ? " — install with: brew install ffmpeg"
          : " — install with: brew install yt-dlp")
    );
  }
}

const mlx = await commandExists("mlx_whisper", { run });
const whisperCli = await commandExists("whisper-cli", { run });
const whisperModelPath = path.join(cacheRoot, "models", "ggml-large-v3-turbo.bin");
const whisperCpp = whisperCli && (await isNonEmptyFile(whisperModelPath));
if (!mlx && !whisperCpp) {
  throw new DependencyError(
    "No timed Whisper engine is ready — install MLX Whisper with: uv tool install mlx-whisper"
  );
}
return { mlx, whisperCpp, whisperModelPath };
~~~

`defaultCacheRoot` returns `path.join(env.XDG_CACHE_HOME || path.join(homedir, ".cache"), "v2w")`.

- [ ] **Step 4: Run primitive tests and the full suite**

Run: `node --test test/process.test.mjs test/fs.test.mjs test/preflight.test.mjs && npm test`

Expected: all primitive tests and the complete suite pass.

- [ ] **Step 5: Commit the runtime primitives**

~~~sh
git add src/process.mjs src/fs.mjs src/preflight.mjs test/process.test.mjs test/fs.test.mjs test/preflight.test.mjs
git commit -m "feat: add safe runtime primitives"
~~~

---

### Task 4: Probe local media, extract audio, and discover caption hints

**Files:**
- Create: `src/media.mjs`
- Create: `test/media.test.mjs`

**Interfaces:**
- Consumes: `runCommand`, `SourceError`, `isNonEmptyFile`
- Produces: `probeMedia(videoPath, { run }) -> MediaInfo`
- Produces: `extractAudio({ inputPath, outputPath, run }) -> outputPath`
- Produces: `discoverLocalCaption({ videoPath, mediaInfo, outputPath, run }) -> string | null`
- `MediaInfo = { durationMs, width, height, hasAudio, videoStreamIndex, subtitleStreamIndexes, frameRate }`

- [ ] **Step 1: Write failing tests for metadata validation and media commands**

~~~js
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildExtractAudioArgs,
  discoverLocalCaption,
  extractAudio,
  probeMedia,
} from "../src/media.mjs";
import { SourceError } from "../src/errors.mjs";

const probeJson = JSON.stringify({
  format: { duration: "12.345" },
  streams: [
    { index: 0, codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30000/1001" },
    { index: 1, codec_type: "audio" },
    { index: 2, codec_type: "subtitle" },
  ],
});

test("probeMedia returns validated duration, dimensions, and streams", async () => {
  const run = async () => ({ code: 0, stdout: probeJson, stderr: "" });
  assert.deepEqual(await probeMedia("/video.mov", { run }), {
    durationMs: 12345,
    width: 1920,
    height: 1080,
    hasAudio: true,
    videoStreamIndex: 0,
    subtitleStreamIndexes: [2],
    frameRate: 30000 / 1001,
  });
});

test("probeMedia rejects media without audio", async () => {
  const run = async () => ({
    code: 0,
    stdout: JSON.stringify({
      format: { duration: "2" },
      streams: [{ index: 0, codec_type: "video", width: 640, height: 360 }],
    }),
    stderr: "",
  });
  await assert.rejects(probeMedia("/silent.mp4", { run }), SourceError);
});

test("audio extraction writes AAC without touching the source", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-media-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, "audio.m4a");
  const run = async (_command, args) => {
    await writeFile(args.at(-1), "aac");
    return { code: 0, stdout: "", stderr: "" };
  };
  assert.deepEqual(buildExtractAudioArgs("/in.mov", outputPath), [
    "-y", "-i", "/in.mov", "-vn", "-acodec", "aac", "-b:a", "128k", outputPath,
  ]);
  assert.equal(await extractAudio({ inputPath: "/in.mov", outputPath, run }), outputPath);
});

test("sidecar VTT wins over SRT and embedded subtitles", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-caption-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const videoPath = path.join(dir, "lesson.mov");
  const vttPath = path.join(dir, "lesson.vtt");
  await writeFile(videoPath, "video");
  await writeFile(vttPath, "WEBVTT");
  const result = await discoverLocalCaption({
    videoPath,
    mediaInfo: { subtitleStreamIndexes: [2] },
    outputPath: path.join(dir, "embedded.vtt"),
    run: async () => { throw new Error("must not extract embedded captions"); },
  });
  assert.equal(result, vttPath);
});
~~~

- [ ] **Step 2: Run the media test and verify it fails**

Run: `node --test test/media.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/media.mjs`.

- [ ] **Step 3: Implement FFprobe parsing and read-only local preparation**

`probeMedia` runs:

~~~js
[
  "-v", "error",
  "-show_entries",
  "format=duration:stream=index,codec_type,width,height,avg_frame_rate",
  "-of", "json",
  videoPath,
]
~~~

Parse `avg_frame_rate` with a numerator/denominator helper. Reject nonzero FFprobe status, nonpositive duration, missing video dimensions, or no audio stream with a `SourceError` that names the file.

`extractAudio` uses the tested argument array and accepts success only when the output is nonempty.

`discoverLocalCaption` checks `<basename>.vtt`, then `<basename>.srt`. It returns the VTT directly; it converts SRT to WebVTT at `outputPath` using FFmpeg. If no sidecar exists and a subtitle stream is present, extract the first subtitle stream with:

~~~js
["-y", "-i", videoPath, "-map", "0:" + streamIndex, "-f", "webvtt", outputPath]
~~~

Return `null` when no timing hints are available. Caption-extraction failure logs a warning through an optional logger and returns `null`; it does not block Whisper.

- [ ] **Step 4: Run media tests and the full suite**

Run: `node --test test/media.test.mjs && npm test`

Expected: media tests pass; the complete suite exits 0.

- [ ] **Step 5: Commit local media support**

~~~sh
git add src/media.mjs test/media.test.mjs
git commit -m "feat: prepare local video media"
~~~

---

### Task 5: Acquire YouTube metadata, video, and optional caption timing

**Files:**
- Create: `src/youtube.mjs`
- Create: `test/youtube.test.mjs`

**Interfaces:**
- Consumes: `runCommand`, `SourceError`, `isNonEmptyFile`
- Produces: `fetchYoutubeMetadata(url, { run }) -> { videoId, title, durationMs, webpageUrl }`
- Produces: `downloadYoutubeMedia({ url, cacheDir, run }) -> videoPath`
- Produces: `downloadYoutubeCaption({ url, cacheDir, run, log }) -> string | null`

- [ ] **Step 1: Write failing tests with an injected yt-dlp runner**

~~~js
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  downloadYoutubeCaption,
  downloadYoutubeMedia,
  fetchYoutubeMetadata,
} from "../src/youtube.mjs";
import { SourceError } from "../src/errors.mjs";

test("parses yt-dlp metadata into the source contract", async () => {
  const run = async () => ({
    code: 0,
    stdout: JSON.stringify({
      id: "abc123",
      title: "A lesson",
      duration: 12.5,
      webpage_url: "https://www.youtube.com/watch?v=abc123",
    }),
    stderr: "",
  });
  assert.deepEqual(await fetchYoutubeMetadata("https://youtu.be/abc123", { run }), {
    videoId: "abc123",
    title: "A lesson",
    durationMs: 12500,
    webpageUrl: "https://www.youtube.com/watch?v=abc123",
  });
});

test("rejects incomplete metadata", async () => {
  const run = async () => ({ code: 0, stdout: "{\"id\":\"abc\"}", stderr: "" });
  await assert.rejects(fetchYoutubeMetadata("https://youtu.be/abc", { run }), SourceError);
});

test("media download returns the nonempty printed path", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-youtube-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "source.webm");
  const run = async () => {
    await writeFile(file, "video");
    return { code: 0, stdout: file + "\n", stderr: "" };
  };
  assert.equal(
    await downloadYoutubeMedia({ url: "https://youtu.be/abc", cacheDir: dir, run }),
    file
  );
});

test("caption failure is optional", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-youtube-caption-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await downloadYoutubeCaption({
    url: "https://youtu.be/abc",
    cacheDir: dir,
    run: async () => ({ code: 1, stdout: "", stderr: "no captions" }),
    log: { warn() {} },
  });
  assert.equal(result, null);
});
~~~

- [ ] **Step 2: Run the YouTube test and verify it fails**

Run: `node --test test/youtube.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/youtube.mjs`.

- [ ] **Step 3: Implement separate required-media and optional-caption calls**

Metadata arguments:

~~~js
["--dump-single-json", "--skip-download", "--no-playlist", url]
~~~

Media arguments:

~~~js
[
  "--no-playlist",
  "-f", "bestvideo*+bestaudio/best",
  "--merge-output-format", "mkv",
  "-o", path.join(cacheDir, "source.%(ext)s"),
  "--print", "after_move:filepath",
  url,
]
~~~

Caption arguments:

~~~js
[
  "--skip-download",
  "--write-subs",
  "--write-auto-subs",
  "--sub-langs", "en.*,en",
  "--sub-format", "vtt",
  "-o", path.join(cacheDir, "captions.%(ext)s"),
  url,
]
~~~

After the caption call, choose the lexically first nonempty `captions*.vtt`. Return `null` with one warning if the call failed or produced no VTT. Media or metadata failures throw `SourceError` with the first 300 stderr characters.

- [ ] **Step 4: Run YouTube tests and the full suite**

Run: `node --test test/youtube.test.mjs && npm test`

Expected: YouTube tests pass; the complete suite exits 0.

- [ ] **Step 5: Commit YouTube acquisition**

~~~sh
git add src/youtube.mjs test/youtube.test.mjs
git commit -m "feat: acquire YouTube source media"
~~~

---

### Task 6: Parse timed VTT and SRT without trusting caption text

**Files:**
- Create: `src/vtt.mjs`
- Create: `test/vtt.test.mjs`

**Interfaces:**
- Produces: `parseVtt(text) -> Cue[]`
- Produces: `parseSrt(text) -> Cue[]`
- Produces: `cueText(cues) -> string`
- Produces: `formatVttTimestamp(ms) -> string`
- `Cue = { startMs: number, endMs: number, text: string }`

- [ ] **Step 1: Write failing parser tests**

~~~js
import assert from "node:assert/strict";
import test from "node:test";

import { cueText, formatVttTimestamp, parseSrt, parseVtt } from "../src/vtt.mjs";

test("parses VTT timestamps, strips tags, and decodes entities", () => {
  const cues = parseVtt(
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<c>Market &amp; chart</c>\n"
  );
  assert.deepEqual(cues, [{
    startMs: 1000,
    endMs: 3500,
    text: "Market & chart",
  }]);
});

test("parses SRT comma timestamps", () => {
  assert.deepEqual(
    parseSrt("1\n00:00:02,250 --> 00:00:04,000\nSlide two\n"),
    [{ startMs: 2250, endMs: 4000, text: "Slide two" }]
  );
});

test("ignores preamble, NOTE, STYLE, REGION, and malformed cues", () => {
  const input = "WEBVTT\n\nNOTE comment\nignored\n\nSTYLE\n::cue { color: red }\n\nbad --> cue\nx\n";
  assert.deepEqual(parseVtt(input), []);
});

test("produces quality text and stable timestamps", () => {
  assert.equal(cueText([
    { startMs: 0, endMs: 1, text: "one" },
    { startMs: 1, endMs: 2, text: "two" },
  ]), "one\ntwo");
  assert.equal(formatVttTimestamp(3723004), "01:02:03.004");
});
~~~

- [ ] **Step 2: Run the VTT test and verify it fails**

Run: `node --test test/vtt.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/vtt.mjs`.

- [ ] **Step 3: Implement block-based cue parsing**

Normalize line endings, split input on blank-line blocks, and parse timing lines with:

~~~js
const TIMING = /^(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})/;
~~~

Skip `NOTE`, `STYLE`, and `REGION` blocks. Strip cue tags with `/<[^>]*>/g`, decode only `amp`, `lt`, `gt`, `quot`, `apos`, `#39`, and `nbsp`, collapse whitespace, and reject cues whose end is not greater than start. Keep all cue timings even when rolling-caption text repeats because caption cues are visual timing hints.

- [ ] **Step 4: Run VTT tests and the full suite**

Run: `node --test test/vtt.test.mjs && npm test`

Expected: VTT tests pass; the complete suite exits 0.

- [ ] **Step 5: Commit timed-caption parsing**

~~~sh
git add src/vtt.mjs test/vtt.test.mjs
git commit -m "feat: parse timed transcript cues"
~~~

---

### Task 7: Port the transcript quality gates

**Files:**
- Create: `src/quality.mjs`
- Create: `test/quality.test.mjs`

**Interfaces:**
- Consumes: `cueText(cues)`
- Produces: `detectRepetitionLoop(text, options) -> object | null`
- Produces: `detectFragmentation(text, options) -> object | null`
- Produces: `inspectTranscript(cues) -> { loop, fragmentation, clean }`
- Produces: `distinctVocabularySize(text) -> number`

- [ ] **Step 1: Write failing tests based on observed yt-intake failure shapes**

~~~js
import assert from "node:assert/strict";
import test from "node:test";

import {
  detectFragmentation,
  detectRepetitionLoop,
  distinctVocabularySize,
  inspectTranscript,
} from "../src/quality.mjs";

const looped = [
  ...Array.from({ length: 60 }, () => "Why use the market?"),
  ...Array.from({ length: 40 }, (_, index) => "real sentence " + index),
].join("\n");

const fragmented = [
  ...Array.from({ length: 50 }, (_, index) => "word" + index),
  ...Array.from({ length: 10 }, (_, index) => "normal sentence number " + index),
].join("\n");

test("detects a repetition loop", () => {
  assert.equal(detectRepetitionLoop(looped).line, "why use the market?");
});

test("detects segmentation collapse", () => {
  assert.ok(detectFragmentation(fragmented));
});

test("passes a varied well-segmented transcript", () => {
  const cues = Array.from({ length: 60 }, (_, index) => ({
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    text: "This is a complete unique sentence number " + index,
  }));
  assert.deepEqual(inspectTranscript(cues), {
    loop: null,
    fragmentation: null,
    clean: true,
  });
});

test("counts digits and apostrophes as vocabulary", () => {
  assert.equal(distinctVocabularySize("SPX 6000 trader's SPX"), 3);
});
~~~

- [ ] **Step 2: Run the quality test and verify it fails**

Run: `node --test test/quality.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/quality.mjs`.

- [ ] **Step 3: Port the exact yt-intake thresholds and normalization**

Use these defaults:

~~~js
export const REPETITION_DEFAULTS = {
  minLines: 20,
  minRepeatCount: 10,
  minRepeatShare: 0.1,
  minUniqueShare: 0.5,
};

export const FRAGMENTATION_DEFAULTS = {
  minLines: 40,
  maxWordsPerLine: 3.5,
  maxSingleWordShare: 0.4,
};
~~~

Normalize repetition lines to trimmed lowercase with collapsed whitespace. Fragmentation computes mean words per nonempty line and the single-word line share. `inspectTranscript` runs both detectors on `cueText(cues)`. `distinctVocabularySize` uses `/[a-z0-9']+/g`.

- [ ] **Step 4: Run quality tests and the full suite**

Run: `node --test test/quality.test.mjs && npm test`

Expected: quality tests pass; the complete suite exits 0.

- [ ] **Step 5: Commit transcript quality gates**

~~~sh
git add src/quality.mjs test/quality.test.mjs
git commit -m "feat: validate Whisper transcript quality"
~~~

---

### Task 8: Produce authoritative timed VTT through the Whisper engine cascade

**Files:**
- Create: `src/vocab.txt`
- Create: `src/transcribe.mjs`
- Create: `test/transcribe.test.mjs`

**Interfaces:**
- Consumes: `parseVtt`, `inspectTranscript`, `copyFileAtomic`, `TranscriptionError`, `TranscriptQualityError`
- Produces: `loadVocabPrompt(filePath) -> Promise<string>`
- Produces: `buildMlxArgs(options) -> string[]`
- Produces: `buildWhisperCppArgs(options) -> string[]`
- Produces: `transcribeTimed(options) -> { engine: "mlx-whisper" | "whisper-cpp", vttPath: string, cues: Cue[] }`

- [ ] **Step 1: Write failing engine-cascade tests**

~~~js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildMlxArgs, loadVocabPrompt, transcribeTimed } from "../src/transcribe.mjs";
import { formatVttTimestamp } from "../src/vtt.mjs";
import { TranscriptQualityError, TranscriptionError } from "../src/errors.mjs";

function makeVtt(lines) {
  return "WEBVTT\n\n" + lines.map((line, index) => {
    return formatVttTimestamp(index * 1000) + " --> " +
      formatVttTimestamp((index + 1) * 1000) + "\n" + line;
  }).join("\n\n") + "\n";
}

test("loads a comma-separated prompt while ignoring comments", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-vocab-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "vocab.txt");
  await writeFile(file, "# names\nVid2Webpage\nFFmpeg\n");
  assert.equal(await loadVocabPrompt(file), "Vid2Webpage, FFmpeg");
});

test("builds MLX timed-VTT arguments", () => {
  assert.deepEqual(buildMlxArgs({
    audioPath: "/audio.m4a",
    cacheDir: "/cache",
    outputName: "transcript-first",
    model: "large-v3-turbo",
    vocabPrompt: "SPX",
  }), [
    "/audio.m4a",
    "--model", "mlx-community/whisper-large-v3-turbo",
    "--output-dir", "/cache",
    "--output-name", "transcript-first",
    "--output-format", "vtt",
    "--initial-prompt", "SPX",
  ]);
});

test("uses a clean MLX VTT as the authoritative transcript", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-transcribe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = async (command, args) => {
    assert.equal(command, "mlx_whisper");
    await writeFile(path.join(dir, "transcript-first.vtt"), makeVtt(["accurate words"]));
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await transcribeTimed({
    audioPath: "/audio.m4a",
    cacheDir: dir,
    tools: { mlx: true, whisperCpp: false },
    run,
    model: "large-v3-turbo",
    vocabPrompt: "",
  });
  assert.equal(result.engine, "mlx-whisper");
  assert.equal(result.cues[0].text, "accurate words");
  assert.match(await readFile(result.vttPath, "utf8"), /accurate words/);
});

test("retries MLX without previous-text conditioning", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    const retry = args.includes("--condition-on-previous-text");
    const lines = retry
      ? Array.from({ length: 60 }, (_, index) => "unique sentence number " + index)
      : Array.from({ length: 60 }, () => "stuck phrase");
    await writeFile(
      path.join(dir, retry ? "transcript-retry.vtt" : "transcript-first.vtt"),
      makeVtt(lines)
    );
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await transcribeTimed({
    audioPath: "/audio.m4a",
    cacheDir: dir,
    tools: { mlx: true, whisperCpp: false },
    run,
    model: "large-v3-turbo",
    vocabPrompt: "",
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(-2), ["--condition-on-previous-text", "False"]);
  assert.match(await readFile(result.vttPath, "utf8"), /unique sentence/);
});

test("rejects two degraded MLX passes", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-bad-transcript-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = async (_command, args) => {
    const retry = args.includes("--condition-on-previous-text");
    await writeFile(
      path.join(dir, retry ? "transcript-retry.vtt" : "transcript-first.vtt"),
      makeVtt(Array.from({ length: 60 }, () => "stuck phrase"))
    );
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    transcribeTimed({
      audioPath: "/audio.m4a",
      cacheDir: dir,
      tools: { mlx: true, whisperCpp: true, whisperModelPath: "/model.bin" },
      run,
      model: "large-v3-turbo",
      vocabPrompt: "",
    }),
    TranscriptQualityError
  );
});

test("throws when no engine produces timed VTT", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-no-transcript-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    transcribeTimed({
      audioPath: "/audio.m4a",
      cacheDir: dir,
      tools: { mlx: false, whisperCpp: true, whisperModelPath: "/model.bin" },
      run: async () => ({ code: 1, stdout: "", stderr: "failed" }),
      model: "large-v3-turbo",
      vocabPrompt: "",
    }),
    TranscriptionError
  );
});
~~~

- [ ] **Step 2: Run the transcription test and confirm failure**

Run: `node --test test/transcribe.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/transcribe.mjs`.

- [ ] **Step 3: Implement timed MLX, retry, and whisper.cpp fallback**

Map `large-v3-turbo` to `mlx-community/whisper-large-v3-turbo`. MLX writes `transcript-first.vtt`; if it is nonempty and clean, atomically copy it to `transcript.vtt`. When degraded, rerun as `transcript-retry.vtt` with:

~~~js
["--condition-on-previous-text", "False"]
~~~

Accept only a clean retry. If both passes are degraded, throw `TranscriptQualityError` with both detector summaries and leave both VTT files in the cache.

`loadVocabPrompt` reads `src/vocab.txt` by default, trims lines, removes
blank/comment lines, and joins entries with `, `. Seed the file with the
literal entries `Vid2Webpage`, `YouTube`, and `FFmpeg`; the mechanism is
general and does not import Lakefront's finance-specific vocabulary.

When MLX is absent or exits nonzero without a usable VTT, convert AAC to 16 kHz mono WAV:

~~~js
["-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]
~~~

Then run whisper.cpp:

~~~js
[
  "-m", tools.whisperModelPath,
  "-f", wavPath,
  "-ovtt",
  "-of", path.join(cacheDir, "transcript-cpp"),
  "-np",
]
~~~

Parse and quality-check `transcript-cpp.vtt`. Captions are never consulted here. If no engine yields a nonempty clean VTT, throw `TranscriptionError`.

- [ ] **Step 4: Run transcription tests and the full suite**

Run: `node --test test/transcribe.test.mjs && npm test`

Expected: transcription tests pass; the complete suite exits 0.

- [ ] **Step 5: Commit timed Whisper transcription**

~~~sh
git add src/vocab.txt src/transcribe.mjs test/transcribe.test.mjs
git commit -m "feat: transcribe video to timed VTT"
~~~

---

### Task 9: Detect visual changes and build the loss-resistant screenshot timeline

**Files:**
- Create: `src/visual-timing.mjs`
- Create: `src/timeline.mjs`
- Create: `test/visual-timing.test.mjs`
- Create: `test/timeline.test.mjs`

**Interfaces:**
- Produces: `detectSceneChanges(videoPath, { run }) -> number[]` in milliseconds
- Produces: `listFrameTimestamps(videoPath, { run }) -> number[]` in milliseconds
- Produces: `buildCapturePlan({ segments, captionCues, sceneTimes, frameTimes, durationMs }) -> Capture[]`
- `Capture = { requestedMs, timestampMs, reasons: string[], segmentIndex, filename }`

- [ ] **Step 1: Write failing visual-timing parser tests**

~~~js
import assert from "node:assert/strict";
import test from "node:test";

import {
  detectSceneChanges,
  listFrameTimestamps,
  parseSceneTimes,
} from "../src/visual-timing.mjs";

test("parses FFmpeg showinfo scene timestamps", () => {
  assert.deepEqual(
    parseSceneTimes("showinfo n:1 pts:100 pts_time:2.004\nshowinfo n:2 pts_time:4.125"),
    [2004, 4125]
  );
});

test("builds scene and frame timestamp commands", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (command === "ffmpeg") {
      return { code: 0, stdout: "", stderr: "showinfo pts_time:2.0" };
    }
    return { code: 0, stdout: "0.000000\n0.100000\n2.000000\n", stderr: "" };
  };
  assert.deepEqual(await detectSceneChanges("/video.mp4", { run }), [2000]);
  assert.deepEqual(await listFrameTimestamps("/video.mp4", { run }), [0, 100, 2000]);
  assert.match(calls[0].args.join(" "), /gt\(scene\\,0\.30\)/);
  assert.ok(calls[1].args.includes("frame=best_effort_timestamp_time"));
});
~~~

- [ ] **Step 2: Write failing pure timeline tests**

~~~js
import assert from "node:assert/strict";
import test from "node:test";

import { buildCapturePlan } from "../src/timeline.mjs";

const segments = [
  { startMs: 0, endMs: 8000, text: "first" },
  { startMs: 8000, endMs: 16000, text: "second" },
];
const frames = [0, 2000, 4000, 5250, 6000, 10000, 12000, 15000, 15900];

test("keeps every segment midpoint and adds caption and scene captures", () => {
  const plan = buildCapturePlan({
    segments,
    captionCues: [{ startMs: 1000, endMs: 3000, text: "ignored caption words" }],
    sceneTimes: [5000],
    frameTimes: frames,
    durationMs: 16000,
  });
  assert.deepEqual(
    plan.map(({ timestampMs, reasons, segmentIndex }) => ({
      timestampMs, reasons, segmentIndex,
    })),
    [
      { timestampMs: 2000, reasons: ["caption"], segmentIndex: 0 },
      { timestampMs: 4000, reasons: ["primary"], segmentIndex: 0 },
      { timestampMs: 5250, reasons: ["scene"], segmentIndex: 0 },
      { timestampMs: 12000, reasons: ["primary"], segmentIndex: 1 },
    ]
  );
});

test("coalesces only candidates on the same decoded frame", () => {
  const plan = buildCapturePlan({
    segments,
    captionCues: [{ startMs: 3000, endMs: 5000, text: "timing only" }],
    sceneTimes: [],
    frameTimes: frames,
    durationMs: 16000,
  });
  const atFour = plan.find((capture) => capture.timestampMs === 4000);
  assert.deepEqual(atFour.reasons, ["primary", "caption"]);
  assert.equal(atFour.filename, "000004000-primary.jpg");
});

test("attaches gap captures to the nearest transcript segment", () => {
  const plan = buildCapturePlan({
    segments: [
      { startMs: 0, endMs: 2000, text: "one" },
      { startMs: 6000, endMs: 8000, text: "two" },
    ],
    captionCues: [],
    sceneTimes: [3750],
    frameTimes: [0, 1000, 4000, 7000],
    durationMs: 8000,
  });
  assert.equal(plan.find((capture) => capture.reasons.includes("scene")).segmentIndex, 0);
});
~~~

- [ ] **Step 3: Run both timing test files and confirm failure**

Run: `node --test test/visual-timing.test.mjs test/timeline.test.mjs`

Expected: FAIL because both modules are absent.

- [ ] **Step 4: Implement process-backed timing discovery**

Scene detection runs:

~~~js
[
  "-hide_banner",
  "-i", videoPath,
  "-filter:v", "select=gt(scene\\,0.30),showinfo",
  "-an",
  "-f", "null",
  "-",
]
~~~

Treat FFmpeg nonzero status as fatal because scene coverage is part of the approved screenshot contract. Parse every `pts_time` from stderr, convert seconds to rounded milliseconds, sort, and remove exact duplicates.

Frame PTS discovery runs:

~~~js
[
  "-v", "error",
  "-select_streams", "v:0",
  "-show_frames",
  "-show_entries", "frame=best_effort_timestamp_time",
  "-of", "csv=p=0",
  videoPath,
]
~~~

Reject an empty frame list.

- [ ] **Step 5: Implement pure multi-signal timeline construction**

For each transcript segment, add midpoint reason `primary`. For every caption cue, add its midpoint with reason `caption`. For every scene cut, request `cut + 250` milliseconds, capped to one millisecond before the next cut and to `durationMs - 1`.

Canonicalize each requested time to the first decoded frame PTS greater than or equal to it, falling back to the last frame when the request is after all PTS values. Merge a candidate only when canonical `timestampMs` is identical. Sort reasons by `primary`, `scene`, `caption`; use the first reason as the filename suffix. Attach by containing segment, then by nearest segment midpoint with earlier segment winning ties.

Build filenames as
`String(timestampMs).padStart(9, "0") + "-" + primaryReason + ".jpg"`.

- [ ] **Step 6: Run timing tests and the full suite**

Run: `node --test test/visual-timing.test.mjs test/timeline.test.mjs && npm test`

Expected: visual timing and timeline tests pass; the complete suite exits 0.

- [ ] **Step 7: Commit screenshot timeline planning**

~~~sh
git add src/visual-timing.mjs src/timeline.mjs test/visual-timing.test.mjs test/timeline.test.mjs
git commit -m "feat: plan complete screenshot timeline"
~~~

---

### Task 10: Add cache workspaces and resumable output manifests

**Files:**
- Create: `src/workspace.mjs`
- Create: `test/workspace.test.mjs`

**Interfaces:**
- Consumes: `writeFileAtomic`, `isNonEmptyFile`, `OutputConflictError`
- Produces: `workspaceCacheDir(cacheRoot, fingerprint) -> string`
- Produces: `openWorkspace({ cacheRoot, fingerprint, outputDir, source }) -> Workspace`
- Produces: `Workspace.loadManifest()`, `Workspace.saveManifest(manifest)`
- Produces: `Workspace.recordFrame(manifest, frame)`, `Workspace.markComplete(manifest)`
- Produces: `Workspace.canReuseFrame(manifestEntry) -> Promise<boolean>`

- [ ] **Step 1: Write failing manifest and conflict tests**

~~~js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OutputConflictError } from "../src/errors.mjs";
import { openWorkspace } from "../src/workspace.mjs";

const source = {
  kind: "local",
  input: "clip.mp4",
  fingerprint: "fingerprint-a",
  title: "clip",
  durationMs: 10000,
  width: 640,
  height: 360,
};

test("creates cache, output, images, and a building manifest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await openWorkspace({
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  });
  const manifest = await workspace.loadManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.status, "building");
  assert.equal(manifest.source.fingerprint, source.fingerprint);
});

test("resumes a matching manifest and rejects a different source", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  };
  const first = await openWorkspace(options);
  assert.equal((await openWorkspace(options)).outputDir, first.outputDir);
  await assert.rejects(
    openWorkspace({
      ...options,
      fingerprint: "fingerprint-b",
      source: { ...source, fingerprint: "fingerprint-b" },
    }),
    OutputConflictError
  );
});

test("rejects a nonempty output without a v2w manifest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-foreign-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");
  await mkdir(outputDir);
  await writeFile(path.join(outputDir, "user-file.txt"), "keep");
  await assert.rejects(
    openWorkspace({
      cacheRoot: path.join(root, "cache"),
      fingerprint: source.fingerprint,
      outputDir,
      source,
    }),
    OutputConflictError
  );
});

test("records frames atomically and marks complete last", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await openWorkspace({
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  });
  let manifest = await workspace.loadManifest();
  manifest = await workspace.recordFrame(manifest, {
    timestampMs: 4000,
    requestedMs: 4000,
    segmentIndex: 0,
    reasons: ["primary"],
    filename: "000004000-primary.jpg",
    width: 640,
    height: 360,
  });
  manifest = await workspace.markComplete(manifest);
  assert.equal(manifest.status, "complete");
  assert.equal(JSON.parse(await readFile(workspace.manifestPath, "utf8")).status, "complete");
});
~~~

- [ ] **Step 2: Run workspace tests and confirm failure**

Run: `node --test test/workspace.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/workspace.mjs`.

- [ ] **Step 3: Implement manifest schema and safe resume rules**

The initial manifest shape is:

~~~js
{
  schemaVersion: 1,
  status: "building",
  source,
  transcript: null,
  segments: [],
  images: [],
  createdAt: new Date().toISOString(),
  completedAt: null,
}
~~~

Create `cacheDir = path.join(cacheRoot, fingerprint)`, the output directory, and `output/images`. If output exists:

1. An empty directory is safe.
2. A nonempty directory without `manifest.json` throws `OutputConflictError`.
3. A manifest with another schema or source fingerprint throws `OutputConflictError`.
4. A matching manifest resumes.

Every manifest mutation uses `writeFileAtomic`. `recordFrame` replaces any existing entry with the same filename, sorts images by timestamp, and persists immediately. `canReuseFrame` requires equal filename, timestamp, segment index, and ordered reasons plus a nonempty image file. `markComplete` sets `completedAt` and performs the final manifest write.

`workspaceCacheDir` returns `path.join(cacheRoot, fingerprint)`.
`openWorkspace` uses that helper for `workspace.cacheDir`.

- [ ] **Step 4: Run workspace tests and the full suite**

Run: `node --test test/workspace.test.mjs && npm test`

Expected: workspace tests pass; the complete suite exits 0.

- [ ] **Step 5: Commit resumable workspaces**

~~~sh
git add src/workspace.mjs test/workspace.test.mjs
git commit -m "feat: add resumable v2w manifests"
~~~

---

### Task 11: Extract native-resolution screenshots atomically

**Files:**
- Create: `src/frames.mjs`
- Create: `test/frames.test.mjs`

**Interfaces:**
- Consumes: `isNonEmptyFile`, `Workspace.canReuseFrame`, `Workspace.recordFrame`
- Produces: `buildFrameArgs({ videoPath, timestampMs, outputPath }) -> string[]`
- Produces: `probeImageDimensions(imagePath, { run }) -> { width, height }`
- Produces: `extractFrames({ videoPath, captures, workspace, manifest, run, log }) -> manifest`

- [ ] **Step 1: Write failing frame extraction tests**

~~~js
import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildFrameArgs, extractFrames } from "../src/frames.mjs";

test("frame arguments preserve native resolution and request one JPEG", () => {
  const args = buildFrameArgs({
    videoPath: "/video with spaces.mov",
    timestampMs: 4250,
    outputPath: "/out.part.jpg",
  });
  assert.deepEqual(args, [
    "-y", "-ss", "4.250", "-i", "/video with spaces.mov",
    "-map", "0:v:0", "-frames:v", "1", "-q:v", "2",
    "-update", "1", "/out.part.jpg",
  ]);
  assert.equal(args.includes("-vf"), false);
});

test("extractFrames records every nonempty completed image", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-frames-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");
  const imagesDir = path.join(outputDir, "images");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(imagesDir, { recursive: true }));
  const recorded = [];
  const workspace = {
    imagesDir,
    canReuseFrame: async () => false,
    recordFrame: async (manifest, frame) => {
      recorded.push(frame);
      return { ...manifest, images: [...manifest.images, frame] };
    },
  };
  const run = async (command, args) => {
    if (command === "ffmpeg") {
      await writeFile(args.at(-1), "jpeg-bytes");
      return { code: 0, stdout: "", stderr: "" };
    }
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ width: 1920, height: 1080 }] }),
      stderr: "",
    };
  };
  const captures = [{
    requestedMs: 4000,
    timestampMs: 4250,
    reasons: ["primary", "caption"],
    segmentIndex: 0,
    filename: "000004250-primary.jpg",
  }];
  const result = await extractFrames({
    videoPath: "/video.mov",
    captures,
    workspace,
    manifest: { images: [] },
    run,
    log: { info() {} },
  });
  assert.equal(recorded.length, 1);
  assert.deepEqual(
    { width: recorded[0].width, height: recorded[0].height },
    { width: 1920, height: 1080 }
  );
  assert.equal(result.images.length, 1);
});
~~~

- [ ] **Step 2: Run frame tests and confirm failure**

Run: `node --test test/frames.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/frames.mjs`.

- [ ] **Step 3: Implement sequential, resumable frame extraction**

For each capture in timestamp order:

1. Reuse it only when `workspace.canReuseFrame` confirms the manifest entry and nonempty file.
2. Write to `<basename>.part-<pid>.jpg` so FFmpeg recognizes the image format.
3. Run the tested FFmpeg arguments.
4. Require a nonempty part file.
5. Probe dimensions with FFprobe JSON `stream=width,height`.
6. Rename the part file to the final filename.
7. Call `workspace.recordFrame` immediately.

Throw on any capture failure; do not silently omit required or supplementary images. Keep extraction sequential in v1 to avoid disk-pressure and manifest-write races.

- [ ] **Step 4: Run frame tests and the full suite**

Run: `node --test test/frames.test.mjs && npm test`

Expected: frame tests pass; the complete suite exits 0.

- [ ] **Step 5: Commit native frame extraction**

~~~sh
git add src/frames.mjs test/frames.test.mjs
git commit -m "feat: extract native transcript screenshots"
~~~

---

### Task 12: Render the safe transcript and screenshot webpage

**Files:**
- Create: `src/render.mjs`
- Create: `src/page.css`
- Create: `test/render.test.mjs`

**Interfaces:**
- Consumes: `copyFileAtomic`, `writeFileAtomic`, `Workspace.saveManifest`, `Workspace.markComplete`
- Produces: `escapeHtml(value) -> string`
- Produces: `youtubeTimestampUrl(url, timestampMs) -> string`
- Produces: `renderPage({ manifest, segments }) -> string`
- Produces: `renderOutput({ workspace, manifest, segments, transcriptVttPath }) -> completedManifest`

- [ ] **Step 1: Write failing rendering and safety tests**

~~~js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  escapeHtml,
  renderOutput,
  renderPage,
  youtubeTimestampUrl,
} from "../src/render.mjs";

const segments = [{
  startMs: 1000,
  endMs: 5000,
  text: "Whisper says <buy> & hold",
}];

const manifest = {
  schemaVersion: 1,
  status: "building",
  source: {
    kind: "youtube",
    title: "A & B",
    webpageUrl: "https://www.youtube.com/watch?v=abc",
    fingerprint: "abc",
  },
  transcript: { engine: "mlx-whisper", filename: "transcript.vtt" },
  segments,
  images: [{
    timestampMs: 3000,
    requestedMs: 3000,
    segmentIndex: 0,
    reasons: ["primary", "caption"],
    filename: "000003000-primary.jpg",
    width: 1920,
    height: 1080,
  }],
};

test("escapes source and Whisper text and never renders caption text", () => {
  const html = renderPage({ manifest, segments });
  assert.match(html, /A &amp; B/);
  assert.match(html, /Whisper says &lt;buy&gt; &amp; hold/);
  assert.doesNotMatch(html, /ignored caption words/);
  assert.match(html, /images\/000003000-primary\.jpg/);
});

test("adds a YouTube timestamp without corrupting existing query parameters", () => {
  assert.equal(
    youtubeTimestampUrl("https://www.youtube.com/watch?v=abc", 4250),
    "https://www.youtube.com/watch?v=abc&t=4"
  );
  assert.equal(escapeHtml("\"'<>"), "&quot;&#39;&lt;&gt;");
});

test("writes page assets before the final completion manifest", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-render-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const transcriptVttPath = path.join(dir, "cached.vtt");
  await writeFile(transcriptVttPath, "WEBVTT\n");
  const writes = [];
  const workspace = {
    outputDir: path.join(dir, "output"),
    manifestPath: path.join(dir, "output", "manifest.json"),
    saveManifest: async (value) => {
      writes.push(value.status);
      return value;
    },
    markComplete: async (value) => {
      assert.equal((await readFile(path.join(dir, "output", "index.html"), "utf8")).length > 0, true);
      writes.push("complete");
      return { ...value, status: "complete" };
    },
  };
  await mkdir(workspace.outputDir, { recursive: true });
  const completed = await renderOutput({ workspace, manifest, segments, transcriptVttPath });
  assert.equal(completed.status, "complete");
  assert.equal(writes.at(-1), "complete");
});
~~~

- [ ] **Step 2: Run rendering tests and confirm failure**

Run: `node --test test/render.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/render.mjs`.

- [ ] **Step 3: Implement semantic, escaped HTML with image galleries**

`renderPage` groups `manifest.images` by `segmentIndex`, sorts by `timestampMs`, and emits one `<article>` per Whisper segment. Each image is:

~~~html
<a class="frame" href="images/000003000-primary.jpg">
  <img
    src="images/000003000-primary.jpg"
    width="1920"
    height="1080"
    loading="lazy"
    alt="Frame at 00:00:03.000"
  >
</a>
~~~

Render reason labels from the manifest but never caption cue text. Escape all dynamic text and attributes. YouTube timestamps are links; local timestamps are `<time>` elements. Include source identity, engine, and image count without embedding video.

`src/page.css` uses a readable centered transcript column, responsive CSS grid galleries, object-fit thumbnails, full-width images on narrow screens, visible keyboard focus, and no fixed image dimensions beyond intrinsic `width`/`height` attributes.

`renderOutput` performs this order:

1. atomically copy cached VTT to `transcript.vtt`;
2. atomically copy `src/page.css` to `styles.css`;
3. save the building manifest with transcript and segment metadata;
4. atomically write `index.html`; and
5. call `workspace.markComplete` as the final write.

- [ ] **Step 4: Run rendering tests and the full suite**

Run: `node --test test/render.test.mjs && npm test`

Expected: rendering tests pass; the complete suite exits 0.

- [ ] **Step 5: Commit page rendering**

~~~sh
git add src/render.mjs src/page.css test/render.test.mjs
git commit -m "feat: render transcript screenshot pages"
~~~

---

### Task 13: Orchestrate both source flows and expose the `v2w` executable

**Files:**
- Create: `src/app.mjs`
- Create: `src/cli.mjs`
- Create: `bin/v2w.mjs`
- Create: `test/app.test.mjs`
- Create: `test/cli.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: every production module from Tasks 1–12
- Produces: `runPipeline({ input, output, cwd, env }, services) -> completedManifest`
- Produces: `runCli(argv, io, runPipelineFn) -> Promise<number>`
- Produces: executable `v2w`

- [ ] **Step 1: Write failing orchestration tests for local and YouTube input**

~~~js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPipeline } from "../src/app.mjs";

function fakeServices({ kind, sourcePath, root }) {
  const calls = [];
  const videoPath = sourcePath || path.join(root, "download.webm");
  const captionPath = path.join(root, "caption.vtt");
  const transcriptPath = path.join(root, "transcript.vtt");
  return {
    calls,
    services: {
      classifySource: async (input) => kind === "local"
        ? { kind, input, path: sourcePath, stat: { size: 5, mtimeMs: 1 } }
        : { kind, input, url: input },
      fetchYoutubeMetadata: async () => ({
        videoId: "abc",
        title: "YouTube lesson",
        durationMs: 8000,
        webpageUrl: "https://www.youtube.com/watch?v=abc",
      }),
      localFingerprint: async () => "local-fingerprint",
      youtubeFingerprint: () => "youtube-fingerprint",
      preflight: async () => ({
        mlx: true,
        whisperCpp: false,
        whisperModelPath: path.join(root, "model.bin"),
      }),
      defaultCacheRoot: () => path.join(root, "cache"),
      workspaceCacheDir: (cacheRoot, fingerprint) => path.join(cacheRoot, fingerprint),
      downloadYoutubeMedia: async () => {
        await writeFile(videoPath, "video");
        return videoPath;
      },
      downloadYoutubeCaption: async () => {
        await writeFile(captionPath, "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\ncaption words\n");
        return captionPath;
      },
      probeMedia: async () => ({
        durationMs: 8000,
        width: 640,
        height: 360,
        hasAudio: true,
        videoStreamIndex: 0,
        subtitleStreamIndexes: [],
        frameRate: 10,
      }),
      discoverLocalCaption: async () => null,
      extractAudio: async ({ outputPath }) => {
        await writeFile(outputPath, "audio");
        return outputPath;
      },
      transcribeTimed: async () => {
        await writeFile(
          transcriptPath,
          "WEBVTT\n\n00:00:00.000 --> 00:00:08.000\nWhisper words\n"
        );
        return {
          engine: "mlx-whisper",
          vttPath: transcriptPath,
          cues: [{ startMs: 0, endMs: 8000, text: "Whisper words" }],
        };
      },
      parseVtt: (text) => text.includes("caption words")
        ? [{ startMs: 0, endMs: 2000, text: "caption words" }]
        : [{ startMs: 0, endMs: 8000, text: "Whisper words" }],
      detectSceneChanges: async () => [3000],
      listFrameTimestamps: async () => [0, 1000, 3250, 4000, 7999],
      buildCapturePlan: (options) => {
        calls.push(options);
        return [{
          requestedMs: 4000,
          timestampMs: 4000,
          reasons: ["primary"],
          segmentIndex: 0,
          filename: "000004000-primary.jpg",
        }];
      },
      openWorkspace: async ({ outputDir, source }) => ({
        outputDir,
        imagesDir: path.join(outputDir, "images"),
        cacheDir: path.join(root, "cache", source.fingerprint),
        loadManifest: async () => ({
          schemaVersion: 1,
          status: "building",
          source,
          transcript: null,
          segments: [],
          images: [],
        }),
        saveManifest: async (value) => value,
      }),
      extractFrames: async ({ manifest }) => ({
        ...manifest,
        images: [{
          timestampMs: 4000,
          requestedMs: 4000,
          segmentIndex: 0,
          reasons: ["primary"],
          filename: "000004000-primary.jpg",
          width: 640,
          height: 360,
        }],
      }),
      renderOutput: async ({ manifest, segments }) => ({
        ...manifest,
        status: "complete",
        segments,
      }),
      ensureDirectory: async () => {},
      removeTemporary: async () => {},
      isNonEmptyFile: async () => false,
      loadVocabPrompt: async () => "",
      inspectTranscript: () => ({ loop: null, fragmentation: null, clean: true }),
      safeOutputName: (label) => label.toLowerCase().replaceAll(" ", "-"),
      basenameWithoutExtension: () => "local-lesson",
      readText: readFile,
    },
  };
}

for (const kind of ["local", "youtube"]) {
  test("runs the complete " + kind + " pipeline with Whisper text", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2w-app-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "local.mov");
    await writeFile(sourcePath, "video");
    const { calls, services } = fakeServices({ kind, sourcePath, root });
    const result = await runPipeline({
      input: kind === "local" ? sourcePath : "https://youtu.be/abc",
      output: path.join(root, "output"),
      cwd: root,
      env: {},
    }, services);
    assert.equal(result.status, "complete");
    assert.equal(result.segments[0].text, "Whisper words");
    if (kind === "youtube") {
      assert.equal(calls[0].captionCues[0].text, "caption words");
    }
    if (kind === "local") {
      assert.equal(await readFile(sourcePath, "utf8"), "video");
    }
  });
}
~~~

- [ ] **Step 2: Write failing CLI exit-code tests**

~~~js
import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.mjs";
import { UsageError } from "../src/errors.mjs";

function captureIo() {
  const stdout = [];
  const stderr = [];
  return {
    io: {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    },
    stdout,
    stderr,
  };
}

test("prints help without running the pipeline", async () => {
  const capture = captureIo();
  const code = await runCli(["--help"], capture.io, async () => {
    throw new Error("must not run");
  });
  assert.equal(code, 0);
  assert.match(capture.stdout.join(""), /v2w <youtube-url-or-local-file>/);
});

test("maps usage errors to exit 2 and operational errors to exit 1", async () => {
  const usage = captureIo();
  assert.equal(
    await runCli([], usage.io, async () => {}),
    2
  );
  const failure = captureIo();
  assert.equal(
    await runCli(["clip.mov"], failure.io, async () => {
      throw new Error("boom");
    }),
    1
  );
});
~~~

- [ ] **Step 3: Run app and CLI tests and confirm failure**

Run: `node --test test/app.test.mjs test/cli.test.mjs`

Expected: FAIL because `src/app.mjs` and `src/cli.mjs` do not exist.

- [ ] **Step 4: Implement the orchestrator with an injectable service table**

`runPipeline` performs this exact sequence:

1. classify the input;
2. preflight required tools for its kind;
3. fetch YouTube metadata and fingerprint, or fingerprint the local file;
4. resolve the cache root with `defaultCacheRoot({ env, homedir: os.homedir() })`, derive it with `workspaceCacheDir`, and create the fingerprint cache directory;
5. download URL video/captions or retain the local path and discover local captions;
6. probe video metadata and assemble the manifest source record;
7. derive output from title/basename unless `--output` was given, then resolve a relative output against `cwd`;
8. open/resume the workspace;
9. reuse a nonempty, clean cached `transcript.vtt` recorded by the matching manifest, or extract audio, load the vocabulary prompt, and transcribe;
10. parse optional caption cues strictly as timing hints;
11. detect scene changes and decoded frame PTS;
12. build the capture plan;
13. save transcript and segment metadata to the building manifest while retaining the capture plan in memory;
14. extract/resume every frame;
15. render VTT, CSS, and HTML;
16. atomically mark the manifest complete; and
17. only after success, remove downloaded media and extracted audio from the cache.

Wrap temporary cleanup so it never targets `source.path` for a local input. On failure, skip cleanup and rethrow so cache diagnostics remain.

Use a frozen `DEFAULT_SERVICES` object containing production imports. Tests pass the table shown above; do not monkeypatch ESM globals.

The remaining service entries map exactly to Node primitives:

~~~js
{
  ensureDirectory: (directory) => mkdir(directory, { recursive: true }),
  removeTemporary: (file) => rm(file, { force: true }),
  basenameWithoutExtension: (file) => path.basename(file, path.extname(file)),
  readText: (file) => readFile(file, "utf8"),
  isNonEmptyFile,
  inspectTranscript,
}
~~~

- [ ] **Step 5: Implement CLI presentation and bin mapping**

`src/cli.mjs` prints:

~~~text
Usage: v2w <youtube-url-or-local-file> [--output <directory>]
~~~

`runCli` returns 0 on help/success, `error.exitCode` for `V2wError`, and 1 for unexpected errors. It writes errors to stderr without stack traces unless `V2W_DEBUG=1`.

`bin/v2w.mjs`:

~~~js
#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

process.exitCode = await runCli(process.argv.slice(2));
~~~

Add to `package.json`:

~~~json
"bin": {
  "v2w": "bin/v2w.mjs"
}
~~~

Make the bin executable with `chmod +x bin/v2w.mjs`.

- [ ] **Step 6: Run orchestration, CLI, and full tests**

Run: `node --test test/app.test.mjs test/cli.test.mjs && npm test`

Expected: both source-flow tests and CLI tests pass; the complete suite exits 0.

- [ ] **Step 7: Verify the executable directly**

Run: `node bin/v2w.mjs --help`

Expected: exit 0 and the exact usage line.

- [ ] **Step 8: Commit the working CLI**

~~~sh
git add package.json bin/v2w.mjs src/app.mjs src/cli.mjs test/app.test.mjs test/cli.test.mjs
git commit -m "feat: expose complete v2w pipeline"
~~~

---

### Task 14: Verify real FFmpeg scene and native-frame behavior

**Files:**
- Create: `test/helpers/ffmpeg-fixture.mjs`
- Create: `test/ffmpeg-integration.test.mjs`

**Interfaces:**
- Consumes: production media, visual-timing, timeline, workspace, frame, and rendering interfaces
- Produces: `createFixtureVideo(directory) -> videoPath`

- [ ] **Step 1: Write a failing FFmpeg integration test**

~~~js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractFrames } from "../src/frames.mjs";
import { probeMedia } from "../src/media.mjs";
import { renderOutput } from "../src/render.mjs";
import { buildCapturePlan } from "../src/timeline.mjs";
import { detectSceneChanges, listFrameTimestamps } from "../src/visual-timing.mjs";
import { openWorkspace } from "../src/workspace.mjs";
import { createFixtureVideo } from "./helpers/ffmpeg-fixture.mjs";

test("hard cuts add native-resolution screenshots with complete HTML references", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-ffmpeg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = await createFixtureVideo(root);
  const media = await probeMedia(videoPath);
  assert.deepEqual(
    { width: media.width, height: media.height },
    { width: 640, height: 360 }
  );

  const segments = [
    { startMs: 0, endMs: 3000, text: "Whisper first" },
    { startMs: 3000, endMs: 6000, text: "Whisper second" },
  ];
  const sceneTimes = await detectSceneChanges(videoPath);
  assert.ok(sceneTimes.some((value) => Math.abs(value - 2000) < 300));
  assert.ok(sceneTimes.some((value) => Math.abs(value - 4000) < 300));

  const captures = buildCapturePlan({
    segments,
    captionCues: [],
    sceneTimes,
    frameTimes: await listFrameTimestamps(videoPath),
    durationMs: media.durationMs,
  });
  const source = {
    kind: "local",
    input: videoPath,
    fingerprint: "fixture",
    title: "fixture",
    durationMs: media.durationMs,
    width: media.width,
    height: media.height,
  };
  const workspace = await openWorkspace({
    cacheRoot: path.join(root, "cache"),
    fingerprint: "fixture",
    outputDir: path.join(root, "output"),
    source,
  });
  let manifest = await workspace.loadManifest();
  manifest.transcript = { engine: "mlx-whisper", filename: "transcript.vtt" };
  manifest.segments = segments;
  manifest = await workspace.saveManifest(manifest);
  manifest = await extractFrames({ videoPath, captures, workspace, manifest });
  for (const image of manifest.images) {
    assert.deepEqual(
      { width: image.width, height: image.height },
      { width: 640, height: 360 }
    );
  }

  const transcriptVttPath = path.join(root, "transcript.vtt");
  await writeFile(
    transcriptVttPath,
    "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nWhisper first\n\n" +
      "00:00:03.000 --> 00:00:06.000\nWhisper second\n"
  );
  manifest = await renderOutput({ workspace, manifest, segments, transcriptVttPath });
  const html = await readFile(path.join(workspace.outputDir, "index.html"), "utf8");
  const references = [...html.matchAll(/src=\"(images\/[^\"]+\.jpg)\"/g)].map((match) => match[1]);
  assert.equal(references.length, manifest.images.length);
  for (const reference of references) {
    assert.ok((await readFile(path.join(workspace.outputDir, reference))).length > 0);
  }
});
~~~

- [ ] **Step 2: Run the integration test and confirm the missing fixture failure**

Run: `node --test test/ffmpeg-integration.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `test/helpers/ffmpeg-fixture.mjs`.

- [ ] **Step 3: Implement a deterministic six-second hard-cut fixture**

`createFixtureVideo` invokes:

~~~js
[
  "-y",
  "-f", "lavfi", "-i", "color=c=red:s=640x360:r=10:d=2",
  "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=10:d=2",
  "-f", "lavfi", "-i", "color=c=green:s=640x360:r=10:d=2",
  "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=6",
  "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
  "-map", "[v]", "-map", "3:a",
  "-c:v", "mpeg4", "-q:v", "2",
  "-c:a", "aac", "-shortest",
  outputPath,
]
~~~

Require FFmpeg exit 0 and a nonempty output. The fixture is generated under the test's temporary directory and is never committed.

- [ ] **Step 4: Run the integration test twice and the full suite**

Run: `node --test test/ffmpeg-integration.test.mjs && node --test test/ffmpeg-integration.test.mjs && npm test`

Expected: both isolated runs pass, proving no stale-file dependency; the complete suite exits 0.

- [ ] **Step 5: Commit real-media coverage**

~~~sh
git add test/helpers/ffmpeg-fixture.mjs test/ffmpeg-integration.test.mjs
git commit -m "test: verify scene-aware native screenshots"
~~~

---

### Task 15: Document, install, and smoke-test both input modes

**Files:**
- Modify: `README.md`
- Create: `scripts/verify-output.mjs`

**Interfaces:**
- Consumes: final `v2w` executable
- Produces: operator-facing installation, usage, output, cache, and troubleshooting documentation

- [ ] **Step 1: Replace the YouTube-only README contract**

Document:

- what `v2w` produces and that it displays only Whisper text;
- Node 20+, FFmpeg/FFprobe, MLX Whisper, `yt-dlp` for URLs, and the optional whisper.cpp model path;
- `npm link` installation;
- URL and local-file examples with `--output`;
- native-resolution required and supplementary screenshots;
- caption timing versus transcript text;
- the exact output tree and manifest purpose;
- cache location and safe resume rules;
- local-source immutability;
- model, missing-audio, quality-gate, caption-absence, and output-conflict troubleshooting;
- legacy `yt-to-webpage.pl` status; and
- `npm test`.

- [ ] **Step 2: Run automated verification before installation**

Run: `npm test`

Expected: every unit and integration test passes with zero failures.

- [ ] **Step 3: Install the local package command**

Run: `npm link`

Expected: npm links this checkout and exits 0.

Run: `command -v v2w && v2w --help`

Expected: `v2w` resolves on PATH and prints the documented usage.

- [ ] **Step 4: Run a real YouTube MLX Whisper smoke test**

~~~sh
v2w_smoke_root=$(mktemp -d /tmp/v2w-smoke.XXXXXX)
v2w "https://www.youtube.com/watch?v=jNQXAC9IVRw" --output "$v2w_smoke_root/youtube"
~~~

Expected: exit 0; `youtube/manifest.json` has `status: "complete"`; transcript text is nonempty; every segment has a `primary` image; and every referenced JPEG exists and is nonempty.

- [ ] **Step 5: Run the same media as a local-file MLX Whisper smoke test**

~~~sh
yt-dlp --no-playlist -o "$v2w_smoke_root/local.%(ext)s" --print after_move:filepath "https://www.youtube.com/watch?v=jNQXAC9IVRw"
v2w_local_source=$(find "$v2w_smoke_root" -maxdepth 1 -type f -name "local.*" -print -quit)
v2w_local_sha_before=$(shasum -a 256 "$v2w_local_source" | awk '{print $1}')
v2w "$v2w_local_source" --output "$v2w_smoke_root/local-output"
v2w_local_sha_after=$(shasum -a 256 "$v2w_local_source" | awk '{print $1}')
test "$v2w_local_sha_before" = "$v2w_local_sha_after"
~~~

Expected: exit 0 with the same completeness checks as the URL output. Record the local file's SHA-256 before and after and require equality.

- [ ] **Step 6: Add and run a deterministic output auditor**

`scripts/verify-output.mjs`:

~~~js
#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

for (const argument of process.argv.slice(2)) {
  const outputDir = path.resolve(argument);
  const manifest = JSON.parse(
    await readFile(path.join(outputDir, "manifest.json"), "utf8")
  );
  assert.equal(manifest.status, "complete");
  assert.ok((await stat(path.join(outputDir, "transcript.vtt"))).size > 0);
  for (let index = 0; index < manifest.segments.length; index += 1) {
    assert.ok(
      manifest.images.some(
        (image) => image.segmentIndex === index && image.reasons.includes("primary")
      ),
      "segment " + index + " has no primary screenshot"
    );
  }
  for (const image of manifest.images) {
    assert.ok(image.width > 0 && image.height > 0);
  }
  const html = await readFile(path.join(outputDir, "index.html"), "utf8");
  const references = [...html.matchAll(/src="(images\/[^"]+\.jpg)"/g)]
    .map((match) => match[1]);
  assert.equal(references.length, manifest.images.length);
  for (const reference of references) {
    assert.ok((await stat(path.join(outputDir, reference))).size > 0);
  }
  process.stdout.write(path.basename(outputDir) + ": PASS\n");
}
~~~

Run:

~~~sh
node scripts/verify-output.mjs "$v2w_smoke_root/youtube" "$v2w_smoke_root/local-output"
~~~

Expected: print `youtube: PASS` and `local-output: PASS`, then exit 0.

- [ ] **Step 7: Re-run the complete quality gate**

Run: `npm test && git diff --check && git status --short`

Expected: tests pass, no whitespace errors, and only the intended README and output-auditor edits remain.

- [ ] **Step 8: Commit documentation and the verified operator flow**

~~~sh
git add README.md scripts/verify-output.mjs
git commit -m "docs: document v2w video workflow"
~~~

- [ ] **Step 9: Verify the final branch state**

Run: `npm test && git status --short && git log --oneline -15`

Expected: all tests pass, the worktree is clean, and the task commits appear in dependency order.
