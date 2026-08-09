import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { TranscriptQualityError, TranscriptionError } from "./errors.mjs";
import { copyFileAtomic, isNonEmptyFile } from "./fs.mjs";
import { runCommand } from "./process.mjs";
import { inspectTranscript } from "./quality.mjs";
import { parseVtt } from "./vtt.mjs";

const MLX_MODELS = {
  "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
};

const DEFAULT_VOCAB_PATH = new URL("./vocab.txt", import.meta.url);

export async function loadVocabPrompt(filePath = DEFAULT_VOCAB_PATH) {
  return (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join(", ");
}

export function buildMlxArgs({
  audioPath,
  cacheDir,
  outputName,
  model,
  vocabPrompt,
}) {
  const args = [
    audioPath,
    "--model", MLX_MODELS[model] ?? model,
    "--output-dir", cacheDir,
    "--output-name", outputName,
    "--output-format", "vtt",
  ];
  if (vocabPrompt) args.push("--initial-prompt", vocabPrompt);
  return args;
}

export function buildWhisperCppArgs({ wavPath, cacheDir, modelPath, tools }) {
  return [
    "-m", modelPath ?? tools?.whisperModelPath,
    "-f", wavPath,
    "-ovtt",
    "-of", path.join(cacheDir, "transcript-cpp"),
    "-np",
  ];
}

async function inspectVtt(filePath) {
  if (!(await isNonEmptyFile(filePath))) return null;
  const cues = parseVtt(await readFile(filePath, "utf8"));
  if (!cues.some((cue) => cue.text.trim())) return null;
  return { cues, quality: inspectTranscript(cues) };
}

async function runSafely(run, command, args) {
  try {
    return { result: await run(command, args), error: null };
  } catch (error) {
    return { result: null, error };
  }
}

function commandDiagnostic(label, outcome) {
  if (outcome.error) return `${label} failed: ${outcome.error.message}`;
  const stderr = outcome.result?.stderr?.trim();
  return `${label} exited ${outcome.result?.code ?? "without a status"}` +
    (stderr ? `: ${stderr}` : "");
}

async function publishCandidate(candidatePath, canonicalPath, engine, inspected) {
  await copyFileAtomic(candidatePath, canonicalPath);
  return { engine, vttPath: canonicalPath, cues: inspected.cues };
}

export async function transcribeTimed({
  audioPath,
  cacheDir,
  tools,
  run = runCommand,
  model = "large-v3-turbo",
  vocabPrompt = "",
}) {
  const canonicalPath = path.join(cacheDir, "transcript.vtt");
  const diagnostics = [];
  let firstRunnerError = null;

  if (tools.mlx) {
    const firstPath = path.join(cacheDir, "transcript-first.vtt");
    await rm(firstPath, { force: true });
    const firstOutcome = await runSafely(
      run,
      "mlx_whisper",
      buildMlxArgs({
        audioPath,
        cacheDir,
        outputName: "transcript-first",
        model,
        vocabPrompt,
      })
    );
    firstRunnerError = firstOutcome.error;
    const first = await inspectVtt(firstPath);

    if (first?.quality.clean) {
      return publishCandidate(firstPath, canonicalPath, "mlx-whisper", first);
    }

    if (first) {
      const retryPath = path.join(cacheDir, "transcript-retry.vtt");
      await rm(retryPath, { force: true });
      const retryOutcome = await runSafely(
        run,
        "mlx_whisper",
        [
          ...buildMlxArgs({
            audioPath,
            cacheDir,
            outputName: "transcript-retry",
            model,
            vocabPrompt,
          }),
          "--condition-on-previous-text", "False",
        ]
      );
      if (!firstRunnerError) firstRunnerError = retryOutcome.error;
      const retry = await inspectVtt(retryPath);
      if (retry?.quality.clean) {
        return publishCandidate(retryPath, canonicalPath, "mlx-whisper", retry);
      }
      if (retry) {
        throw new TranscriptQualityError(
          "MLX transcript quality failed: first=" + JSON.stringify(first.quality) +
            "; retry=" + JSON.stringify(retry.quality)
        );
      }
      diagnostics.push(commandDiagnostic("MLX retry", retryOutcome));
    }

    diagnostics.push(commandDiagnostic("MLX", firstOutcome));
  }

  if (tools.whisperCpp) {
    const wavPath = path.join(cacheDir, "transcript.wav");
    const cppPath = path.join(cacheDir, "transcript-cpp.vtt");
    await rm(wavPath, { force: true });
    await rm(cppPath, { force: true });

    const ffmpegOutcome = await runSafely(run, "ffmpeg", [
      "-y", "-i", audioPath,
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "pcm_s16le",
      wavPath,
    ]);
    if (ffmpegOutcome.error || ffmpegOutcome.result?.code !== 0 ||
        !(await isNonEmptyFile(wavPath))) {
      const cause = ffmpegOutcome.error ?? firstRunnerError;
      throw new TranscriptionError(
        [
          ...diagnostics,
          commandDiagnostic("FFmpeg WAV conversion", ffmpegOutcome),
        ].join("; "),
        { cause }
      );
    }

    const cppOutcome = await runSafely(
      run,
      "whisper-cli",
      buildWhisperCppArgs({
        wavPath,
        cacheDir,
        modelPath: tools.whisperModelPath,
      })
    );
    const cpp = await inspectVtt(cppPath);
    if (cpp?.quality.clean) {
      return publishCandidate(cppPath, canonicalPath, "whisper-cpp", cpp);
    }
    diagnostics.push(
      cpp
        ? "whisper.cpp transcript was degraded: " + JSON.stringify(cpp.quality)
        : commandDiagnostic("whisper.cpp", cppOutcome)
    );
    throw new TranscriptionError(diagnostics.join("; "), {
      cause: cppOutcome.error ?? firstRunnerError,
    });
  }

  throw new TranscriptionError(
    diagnostics.join("; ") || "No timed Whisper engine produced a nonempty clean VTT",
    { cause: firstRunnerError }
  );
}
