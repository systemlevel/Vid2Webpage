import { parseCliArgs } from "./args.mjs";
import { runPipeline } from "./app.mjs";
import { UsageError, V2wError } from "./errors.mjs";

export const USAGE = "Usage: v2w <youtube-url-or-local-file> [--output <directory>]\n";

function errorText(error, debug) {
  if (debug && typeof error?.stack === "string") return `${error.stack}\n`;
  const message = typeof error?.message === "string" && error.message
    ? error.message
    : String(error);
  return `${message}\n`;
}

export async function runCli(
  argv,
  io = {},
  runPipelineFn = runPipeline,
) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();

  try {
    const options = parseCliArgs(argv);
    if (options.help) {
      stdout.write(USAGE);
      return 0;
    }
    await runPipelineFn({
      input: options.input,
      output: options.output,
      cwd,
      env,
      onWarning: (message) => stderr.write(`Warning: ${message}\n`),
    });
    return 0;
  } catch (error) {
    stderr.write(errorText(error, env.V2W_DEBUG === "1"));
    if (error instanceof UsageError) stderr.write(USAGE);
    return error instanceof V2wError ? error.exitCode : 1;
  }
}
