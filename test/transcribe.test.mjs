import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildMlxArgs,
  buildWhisperCppArgs,
  loadVocabPrompt,
  transcribeTimed,
} from "../src/transcribe.mjs";
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

test("omits the MLX prompt flag when vocabulary is empty", () => {
  assert.deepEqual(buildMlxArgs({
    audioPath: "/audio.m4a",
    cacheDir: "/cache",
    outputName: "transcript-first",
    model: "large-v3-turbo",
    vocabPrompt: "",
  }), [
    "/audio.m4a",
    "--model", "mlx-community/whisper-large-v3-turbo",
    "--output-dir", "/cache",
    "--output-name", "transcript-first",
    "--output-format", "vtt",
  ]);
});

test("builds whisper.cpp timed-VTT arguments", () => {
  assert.deepEqual(buildWhisperCppArgs({
    wavPath: "/cache/transcript.wav",
    cacheDir: "/cache",
    modelPath: "/model.bin",
  }), [
    "-m", "/model.bin",
    "-f", "/cache/transcript.wav",
    "-ovtt",
    "-of", "/cache/transcript-cpp",
    "-np",
  ]);
});

test("uses a clean MLX VTT as the authoritative transcript", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-transcribe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = async (command, args) => {
    assert.equal(command, "mlx_whisper");
    assert.doesNotMatch(JSON.stringify(args), /caption poison/i);
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
    captionText: "caption poison",
    captionVttPath: "/captions.vtt",
  });
  assert.equal(result.engine, "mlx-whisper");
  assert.equal(result.vttPath, path.join(dir, "transcript.vtt"));
  assert.equal(result.cues[0].text, "accurate words");
  assert.match(await readFile(result.vttPath, "utf8"), /accurate words/);
  assert.doesNotMatch(await readFile(result.vttPath, "utf8"), /caption poison/i);
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
  const commands = [];
  const run = async (command, args) => {
    commands.push(command);
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
    (error) => {
      assert(error instanceof TranscriptQualityError);
      assert.match(error.message, /first/i);
      assert.match(error.message, /retry/i);
      assert.match(error.message, /loop/i);
      return true;
    }
  );
  assert.deepEqual(commands, ["mlx_whisper", "mlx_whisper"]);
  assert.match(await readFile(path.join(dir, "transcript-first.vtt"), "utf8"), /stuck phrase/);
  assert.match(await readFile(path.join(dir, "transcript-retry.vtt"), "utf8"), /stuck phrase/);
});

test("falls back to whisper.cpp with converted mono PCM audio", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-whisper-cpp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const wavPath = path.join(dir, "transcript.wav");
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === "ffmpeg") {
      await writeFile(wavPath, "pcm");
    } else if (command === "whisper-cli") {
      await writeFile(path.join(dir, "transcript-cpp.vtt"), makeVtt(["fallback words"]));
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const result = await transcribeTimed({
    audioPath: "/audio.m4a",
    cacheDir: dir,
    tools: { mlx: false, whisperCpp: true, whisperModelPath: "/model.bin" },
    run,
    model: "large-v3-turbo",
    vocabPrompt: "SPX",
  });

  assert.deepEqual(calls, [
    ["ffmpeg", [
      "-y", "-i", "/audio.m4a", "-ar", "16000", "-ac", "1",
      "-c:a", "pcm_s16le", wavPath,
    ]],
    ["whisper-cli", [
      "-m", "/model.bin", "-f", wavPath, "-ovtt",
      "-of", path.join(dir, "transcript-cpp"), "-np",
    ]],
  ]);
  assert.equal(result.engine, "whisper-cpp");
  assert.equal(result.vttPath, path.join(dir, "transcript.vtt"));
  assert.equal(result.cues[0].text, "fallback words");
});

test("falls back after MLX exits nonzero without usable VTT", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-mlx-fallback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const commands = [];
  const run = async (command) => {
    commands.push(command);
    if (command === "mlx_whisper") {
      return { code: 1, stdout: "", stderr: "mlx failed" };
    }
    if (command === "ffmpeg") {
      await writeFile(path.join(dir, "transcript.wav"), "pcm");
    } else {
      await writeFile(path.join(dir, "transcript-cpp.vtt"), makeVtt(["recovered words"]));
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const result = await transcribeTimed({
    audioPath: "/audio.m4a",
    cacheDir: dir,
    tools: { mlx: true, whisperCpp: true, whisperModelPath: "/model.bin" },
    run,
    model: "large-v3-turbo",
    vocabPrompt: "",
  });

  assert.deepEqual(commands, ["mlx_whisper", "ffmpeg", "whisper-cli"]);
  assert.equal(result.engine, "whisper-cpp");
  assert.equal(result.cues[0].text, "recovered words");
});

test("does not reuse a stale MLX output after a failed command", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-stale-mlx-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "transcript-first.vtt"), makeVtt(["stale words"]));

  await assert.rejects(transcribeTimed({
    audioPath: "/audio.m4a",
    cacheDir: dir,
    tools: { mlx: true, whisperCpp: false },
    run: async () => ({ code: 1, stdout: "", stderr: "mlx failed" }),
    model: "large-v3-turbo",
    vocabPrompt: "",
  }), TranscriptionError);
  await assert.rejects(readFile(path.join(dir, "transcript-first.vtt")));
  await assert.rejects(readFile(path.join(dir, "transcript.vtt")));
});

test("does not publish a VTT with no parsed cues", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-empty-cues-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = async () => {
    await writeFile(path.join(dir, "transcript-first.vtt"), "WEBVTT\n\n");
    return { code: 0, stdout: "", stderr: "" };
  };

  await assert.rejects(transcribeTimed({
    audioPath: "/audio.m4a",
    cacheDir: dir,
    tools: { mlx: true, whisperCpp: false },
    run,
    model: "large-v3-turbo",
    vocabPrompt: "",
  }), TranscriptionError);
  await assert.rejects(readFile(path.join(dir, "transcript.vtt")));
});

test("wraps runner failures in a typed transcription error", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-runner-error-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const failure = new Error("spawn failed");

  await assert.rejects(transcribeTimed({
    audioPath: "/audio.m4a",
    cacheDir: dir,
    tools: { mlx: true, whisperCpp: false },
    run: async () => { throw failure; },
    model: "large-v3-turbo",
    vocabPrompt: "",
  }), (error) => {
    assert(error instanceof TranscriptionError);
    assert.match(error.message, /mlx/i);
    assert.equal(error.cause, failure);
    return true;
  });
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
