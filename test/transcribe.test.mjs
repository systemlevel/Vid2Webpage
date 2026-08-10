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

function argumentValue(args, flag) {
  return args[args.indexOf(flag) + 1];
}

function mlxVttPath(args) {
  return path.join(
    argumentValue(args, "--output-dir"),
    argumentValue(args, "--output-name") + ".vtt"
  );
}

function whisperCppVttPath(args) {
  return argumentValue(args, "-of") + ".vtt";
}

test("loads a comma-separated prompt while ignoring comments", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-vocab-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "vocab.txt");
  await writeFile(file, "# names\nVid2Webpage\nFFmpeg\n");
  assert.equal(await loadVocabPrompt(file), "Vid2Webpage, FFmpeg");
});

test("loads the seeded general vocabulary by default", async () => {
  assert.equal(await loadVocabPrompt(), "Vid2Webpage, YouTube, FFmpeg");
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

test("rejects unsupported MLX models", () => {
  assert.throws(() => buildMlxArgs({
    audioPath: "/audio.m4a",
    cacheDir: "/cache",
    outputName: "transcript-first",
    model: "tiny.en",
    vocabPrompt: "",
  }), (error) => {
    assert(error instanceof TranscriptionError);
    assert.match(error.message, /unsupported mlx model/i);
    return true;
  });
});

test("rejects inherited model keys before runner execution", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-model-allowlist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  for (const model of ["toString", "constructor", "__proto__"]) {
    await t.test(model, async () => {
      let runnerCalls = 0;
      await assert.rejects(transcribeTimed({
        audioPath: "/audio.m4a",
        cacheDir: dir,
        tools: { mlx: true, whisperCpp: false },
        run: async () => {
          runnerCalls += 1;
          return { code: 0, stdout: "", stderr: "" };
        },
        model,
        vocabPrompt: "",
      }), (error) => {
        assert(error instanceof TranscriptionError);
        assert.match(error.message, /unsupported mlx model/i);
        return true;
      });
      assert.equal(runnerCalls, 0);
    });
  }
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
    await writeFile(mlxVttPath(args), makeVtt(["accurate words"]));
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
      mlxVttPath(args),
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
  const candidatePaths = [];
  const run = async (command, args) => {
    commands.push(command);
    candidatePaths.push(mlxVttPath(args));
    await writeFile(
      mlxVttPath(args),
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
  assert.notEqual(candidatePaths[0], candidatePaths[1]);
  assert.match(await readFile(candidatePaths[0], "utf8"), /stuck phrase/);
  assert.match(await readFile(candidatePaths[1], "utf8"), /stuck phrase/);
});

test("falls back to whisper.cpp with converted mono PCM audio", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-whisper-cpp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  let wavPath;
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === "ffmpeg") {
      wavPath = args.at(-1);
      await writeFile(wavPath, "pcm");
    } else if (command === "whisper-cli") {
      await writeFile(whisperCppVttPath(args), makeVtt(["fallback words"]));
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

  assert.deepEqual(calls[0], ["ffmpeg", [
    "-y", "-i", "/audio.m4a", "-ar", "16000", "-ac", "1",
    "-c:a", "pcm_s16le", wavPath,
  ]]);
  assert.deepEqual(calls[1], ["whisper-cli", [
    "-m", "/model.bin", "-f", wavPath, "-ovtt",
    "-of", argumentValue(calls[1][1], "-of"), "-np",
  ]]);
  assert.match(path.basename(wavPath), /^transcript-[\w-]+\.wav$/);
  assert.match(path.basename(argumentValue(calls[1][1], "-of")), /^transcript-cpp-[\w-]+$/);
  assert.equal(path.dirname(wavPath), dir);
  assert.equal(path.dirname(argumentValue(calls[1][1], "-of")), dir);
  assert.equal(result.engine, "whisper-cpp");
  assert.equal(result.vttPath, path.join(dir, "transcript.vtt"));
  assert.equal(result.cues[0].text, "fallback words");
});

test("falls back after MLX exits nonzero without usable VTT", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-mlx-fallback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const commands = [];
  const run = async (command, args) => {
    commands.push(command);
    if (command === "mlx_whisper") {
      return { code: 1, stdout: "", stderr: "mlx failed" };
    }
    if (command === "ffmpeg") {
      await writeFile(args.at(-1), "pcm");
    } else {
      await writeFile(whisperCppVttPath(args), makeVtt(["recovered words"]));
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

test("does not delete or reuse a stale fixed-name first-pass VTT", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-stale-mlx-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stalePath = path.join(dir, "transcript-first.vtt");
  await writeFile(stalePath, makeVtt(["stale words"]));

  await assert.rejects(transcribeTimed({
    audioPath: "/audio.m4a",
    cacheDir: dir,
    tools: { mlx: true, whisperCpp: false },
    run: async () => ({ code: 1, stdout: "", stderr: "mlx failed" }),
    model: "large-v3-turbo",
    vocabPrompt: "",
  }), TranscriptionError);
  assert.match(await readFile(stalePath, "utf8"), /stale words/);
  await assert.rejects(readFile(path.join(dir, "transcript.vtt")));
});

test("does not delete or reuse a stale fixed-name retry VTT", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-stale-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stalePath = path.join(dir, "transcript-retry.vtt");
  await writeFile(stalePath, makeVtt(["stale retry words"]));
  const run = async (_command, args) => {
    if (!args.includes("--condition-on-previous-text")) {
      await writeFile(
        mlxVttPath(args),
        makeVtt(Array.from({ length: 60 }, () => "stuck phrase"))
      );
    }
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
  assert.match(await readFile(stalePath, "utf8"), /stale retry words/);
  await assert.rejects(readFile(path.join(dir, "transcript.vtt")));
});

test("does not delete or reuse a stale fixed-name whisper.cpp VTT", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-stale-cpp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stalePath = path.join(dir, "transcript-cpp.vtt");
  await writeFile(stalePath, makeVtt(["stale cpp words"]));
  const run = async (command, args) => {
    if (command === "ffmpeg") await writeFile(args.at(-1), "pcm");
    return { code: 0, stdout: "", stderr: "" };
  };

  await assert.rejects(transcribeTimed({
    audioPath: "/audio.m4a",
    cacheDir: dir,
    tools: { mlx: false, whisperCpp: true, whisperModelPath: "/model.bin" },
    run,
    model: "large-v3-turbo",
    vocabPrompt: "",
  }), TranscriptionError);
  assert.match(await readFile(stalePath, "utf8"), /stale cpp words/);
  await assert.rejects(readFile(path.join(dir, "transcript.vtt")));
});

test("rejects a clean-looking MLX VTT from a nonzero exit", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-nonzero-mlx-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = async (_command, args) => {
    await writeFile(mlxVttPath(args), makeVtt(["partial mlx words"]));
    return { code: 1, stdout: "", stderr: "mlx failed after partial output" };
  };

  await assert.rejects(transcribeTimed({
    audioPath: "/audio.m4a",
    cacheDir: dir,
    tools: { mlx: true, whisperCpp: false },
    run,
    model: "large-v3-turbo",
    vocabPrompt: "",
  }), (error) => {
    assert(error instanceof TranscriptionError);
    assert.match(error.message, /exited 1/i);
    return true;
  });
  await assert.rejects(readFile(path.join(dir, "transcript.vtt")));
});

test("rejects a clean-looking MLX retry VTT from a nonzero exit", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-nonzero-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = async (_command, args) => {
    const retry = args.includes("--condition-on-previous-text");
    const lines = retry
      ? ["partial retry words"]
      : Array.from({ length: 60 }, () => "stuck phrase");
    await writeFile(mlxVttPath(args), makeVtt(lines));
    return { code: retry ? 1 : 0, stdout: "", stderr: retry ? "retry failed" : "" };
  };

  await assert.rejects(transcribeTimed({
    audioPath: "/audio.m4a",
    cacheDir: dir,
    tools: { mlx: true, whisperCpp: false },
    run,
    model: "large-v3-turbo",
    vocabPrompt: "",
  }), (error) => {
    assert(error instanceof TranscriptionError);
    assert.match(error.message, /retry.*exited 1/i);
    return true;
  });
  await assert.rejects(readFile(path.join(dir, "transcript.vtt")));
});

test("rejects a clean-looking whisper.cpp VTT from a nonzero exit", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-nonzero-cpp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = async (command, args) => {
    if (command === "ffmpeg") {
      await writeFile(args.at(-1), "pcm");
      return { code: 0, stdout: "", stderr: "" };
    }
    await writeFile(whisperCppVttPath(args), makeVtt(["partial cpp words"]));
    return { code: 1, stdout: "", stderr: "cpp failed after partial output" };
  };

  await assert.rejects(transcribeTimed({
    audioPath: "/audio.m4a",
    cacheDir: dir,
    tools: { mlx: false, whisperCpp: true, whisperModelPath: "/model.bin" },
    run,
    model: "large-v3-turbo",
    vocabPrompt: "",
  }), (error) => {
    assert(error instanceof TranscriptionError);
    assert.match(error.message, /whisper\.cpp.*exited 1/i);
    return true;
  });
  await assert.rejects(readFile(path.join(dir, "transcript.vtt")));
});

test("reports a missing MLX VTT explicitly", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-vtt-diagnostics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(transcribeTimed({
    audioPath: "/missing.m4a",
    cacheDir: dir,
    tools: { mlx: true, whisperCpp: false },
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    model: "large-v3-turbo",
    vocabPrompt: "",
  }), /missing VTT/i);
});

test("reports an empty MLX VTT explicitly", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-empty-vtt-diagnostic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(transcribeTimed({
    audioPath: "/empty.m4a",
    cacheDir: dir,
    tools: { mlx: true, whisperCpp: false },
    run: async (_command, args) => {
      await writeFile(mlxVttPath(args), "");
      return { code: 0, stdout: "", stderr: "" };
    },
    model: "large-v3-turbo",
    vocabPrompt: "",
  }), /empty VTT/i);
});

test("does not publish a VTT with no parsed cues", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-empty-cues-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = async (_command, args) => {
    await writeFile(mlxVttPath(args), "WEBVTT\n\n");
    return { code: 0, stdout: "", stderr: "" };
  };

  await assert.rejects(transcribeTimed({
    audioPath: "/audio.m4a",
    cacheDir: dir,
    tools: { mlx: true, whisperCpp: false },
    run,
    model: "large-v3-turbo",
    vocabPrompt: "",
  }), (error) => {
    assert(error instanceof TranscriptionError);
    assert.match(error.message, /no parseable nonempty cues/i);
    return true;
  });
  await assert.rejects(readFile(path.join(dir, "transcript.vtt")));
});

test("isolates interleaved calls that share one cache directory", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-concurrent-transcribe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let markFirstWritten;
  let markSecondWritten;
  const firstWritten = new Promise((resolve) => { markFirstWritten = resolve; });
  const secondWritten = new Promise((resolve) => { markSecondWritten = resolve; });
  const candidatePaths = new Map();
  const run = async (_command, args) => {
    assert.doesNotMatch(JSON.stringify(args), /caption poison/i);
    const audioPath = args[0];
    const candidatePath = mlxVttPath(args);
    candidatePaths.set(audioPath, candidatePath);
    if (audioPath === "/first.m4a") {
      await writeFile(candidatePath, makeVtt(["first invocation words"]));
      markFirstWritten();
      await secondWritten;
    } else {
      await writeFile(candidatePath, makeVtt(["second invocation words"]));
      markSecondWritten();
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const options = {
    cacheDir: dir,
    tools: { mlx: true, whisperCpp: false },
    run,
    model: "large-v3-turbo",
    vocabPrompt: "Vid2Webpage",
    captionText: "caption poison",
  };

  const firstPromise = transcribeTimed({ ...options, audioPath: "/first.m4a" });
  await firstWritten;
  const secondPromise = transcribeTimed({ ...options, audioPath: "/second.m4a" });
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(first.cues[0].text, "first invocation words");
  assert.equal(second.cues[0].text, "second invocation words");
  assert.notEqual(candidatePaths.get("/first.m4a"), candidatePaths.get("/second.m4a"));
  assert.match(
    await readFile(candidatePaths.get("/first.m4a"), "utf8"),
    /first invocation words/
  );
  assert.match(
    await readFile(candidatePaths.get("/second.m4a"), "utf8"),
    /second invocation words/
  );
  assert.equal(first.vttPath, path.join(dir, "transcript.vtt"));
  assert.equal(second.vttPath, path.join(dir, "transcript.vtt"));
  const authoritative = await readFile(path.join(dir, "transcript.vtt"), "utf8");
  assert.match(authoritative, /(?:first|second) invocation words/);
  assert.doesNotMatch(authoritative, /caption poison/i);
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
