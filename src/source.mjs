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
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !YOUTUBE_HOSTS.has(url.hostname)
    ) {
      throw new SourceError("Only YouTube URLs are supported as remote sources");
    }
    return { kind: "youtube", input, url: url.toString() };
  }

  const resolved = path.resolve(cwd, input);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    throw new SourceError("Local video does not exist: " + resolved, {
      cause: error,
    });
  }
  if (!info.isFile()) {
    throw new SourceError("Local source is not a regular file: " + resolved);
  }
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
