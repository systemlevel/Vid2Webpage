import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { TranscriptQualityError, TranscriptionError } from "./errors.mjs";
import { copyFileAtomic, isNonEmptyFile } from "./fs.mjs";
import { runCommand } from "./process.mjs";
import { inspectTranscript } from "./quality.mjs";
import { parseVtt } from "./vtt.mjs";

const MLX_MODELS = new Map([
  ["large-v3-turbo", "mlx-community/whisper-large-v3-turbo"],
  ["mlx-community/whisper-large-v3-turbo", "mlx-community/whisper-large-v3-turbo"],
]);

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
  const resolvedModel = MLX_MODELS.get(model);
  if (!resolvedModel) {
    throw new TranscriptionError(`Unsupported MLX model: ${model}`);
  }
  const args = [
    audioPath,
    "--model", resolvedModel,
    "--output-dir", cacheDir,
    "--output-name", outputName,
    "--output-format", "vtt",
  ];
  if (vocabPrompt) args.push("--initial-prompt", vocabPrompt);
  return args;
}

export function buildWhisperCppArgs({
  wavPath,
  cacheDir,
  modelPath,
  outputName = "transcript-cpp",
  tools,
}) {
  return [
    "-m", modelPath ?? tools?.whisperModelPath,
    "-f", wavPath,
    "-ovtt",
    "-of", path.join(cacheDir, outputName),
    "-np",
  ];
}

async function inspectVtt(filePath) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { usable: false, reason: `missing VTT: ${filePath}` };
    }
    return { usable: false, reason: `unreadable VTT ${filePath}: ${error.message}` };
  }
  if (contents.length === 0) {
    return { usable: false, reason: `empty VTT: ${filePath}` };
  }
  const cues = parseVtt(contents);
  if (!cues.some((cue) => cue.text.trim())) {
    return {
      usable: false,
      reason: `VTT has no parseable nonempty cues: ${filePath}`,
    };
  }
  return { usable: true, cues, quality: inspectTranscript(cues) };
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
  const invocationId = randomUUID();
  const diagnostics = [];
  let firstRunnerError = null;

  if (tools.mlx) {
    const firstOutputName = `transcript-first-${invocationId}`;
    const firstPath = path.join(cacheDir, firstOutputName + ".vtt");
    const firstOutcome = await runSafely(
      run,
      "mlx_whisper",
      buildMlxArgs({
        audioPath,
        cacheDir,
        outputName: firstOutputName,
        model,
        vocabPrompt,
      })
    );
    firstRunnerError = firstOutcome.error;
    const firstSucceeded = firstOutcome.result?.code === 0 && !firstOutcome.error;
    const first = firstSucceeded ? await inspectVtt(firstPath) : null;

    if (first?.usable && first.quality.clean) {
      return publishCandidate(firstPath, canonicalPath, "mlx-whisper", first);
    }

    if (first?.usable) {
      const retryOutputName = `transcript-retry-${invocationId}`;
      const retryPath = path.join(cacheDir, retryOutputName + ".vtt");
      const retryOutcome = await runSafely(
        run,
        "mlx_whisper",
        [
          ...buildMlxArgs({
            audioPath,
            cacheDir,
            outputName: retryOutputName,
            model,
            vocabPrompt,
          }),
          "--condition-on-previous-text", "False",
        ]
      );
      if (!firstRunnerError) firstRunnerError = retryOutcome.error;
      const retrySucceeded = retryOutcome.result?.code === 0 && !retryOutcome.error;
      const retry = retrySucceeded ? await inspectVtt(retryPath) : null;
      if (retry?.usable && retry.quality.clean) {
        return publishCandidate(retryPath, canonicalPath, "mlx-whisper", retry);
      }
      if (retry?.usable) {
        throw new TranscriptQualityError(
          "MLX transcript quality failed: first=" + JSON.stringify(first.quality) +
            "; retry=" + JSON.stringify(retry.quality)
        );
      }
      diagnostics.push(
        "MLX first transcript was degraded: " + JSON.stringify(first.quality)
      );
      diagnostics.push(
        retry ? `MLX retry ${retry.reason}` : commandDiagnostic("MLX retry", retryOutcome)
      );
    }

    if (!firstSucceeded) {
      diagnostics.push(commandDiagnostic("MLX", firstOutcome));
    } else if (!first.usable) {
      diagnostics.push(`MLX ${first.reason}`);
    }
  }

  if (tools.whisperCpp) {
    const wavPath = path.join(cacheDir, `transcript-${invocationId}.wav`);
    const cppOutputName = `transcript-cpp-${invocationId}`;
    const cppPath = path.join(cacheDir, cppOutputName + ".vtt");

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
        outputName: cppOutputName,
      })
    );
    const cppSucceeded = cppOutcome.result?.code === 0 && !cppOutcome.error;
    const cpp = cppSucceeded ? await inspectVtt(cppPath) : null;
    if (cpp?.usable && cpp.quality.clean) {
      return publishCandidate(cppPath, canonicalPath, "whisper-cpp", cpp);
    }
    diagnostics.push(
      cpp?.usable
        ? "whisper.cpp transcript was degraded: " + JSON.stringify(cpp.quality)
        : cpp
          ? `whisper.cpp ${cpp.reason}`
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
