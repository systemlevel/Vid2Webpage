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
