import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { OutputConflictError } from "./errors.mjs";
import { isNonEmptyFile, writeFileAtomic } from "./fs.mjs";

const manifestFilename = "manifest.json";
const reasonPriority = new Map([
  ["primary", 0],
  ["scene", 1],
  ["caption", 2],
]);

function conflict(message) {
  return new OutputConflictError(message);
}

function compareReasons(left, right) {
  return (reasonPriority.get(left) ?? Infinity) - (reasonPriority.get(right) ?? Infinity)
    || left.localeCompare(right);
}

function sortReasons(reasons) {
  return [...reasons].sort(compareReasons);
}

function sortAssociations(associations) {
  return associations
    .map((association) => ({ ...association, reasons: sortReasons(association.reasons) }))
    .sort((left, right) => left.segmentIndex - right.segmentIndex
      || left.requestedMs - right.requestedMs);
}

function normalizeFrame(frame) {
  return {
    ...frame,
    reasons: sortReasons(frame.reasons),
    associations: sortAssociations(frame.associations),
  };
}

function isExpectedManifest(manifest, fingerprint) {
  return manifest
    && typeof manifest === "object"
    && manifest.schemaVersion === 1
    && (manifest.status === "building" || manifest.status === "complete")
    && manifest.source
    && typeof manifest.source === "object"
    && manifest.source.fingerprint === fingerprint
    && Array.isArray(manifest.segments)
    && Array.isArray(manifest.images)
    && typeof manifest.createdAt === "string"
    && (manifest.completedAt === null || typeof manifest.completedAt === "string");
}

async function statOrNull(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureDirectory(directoryPath, description) {
  const existing = await statOrNull(directoryPath);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw conflict(`${description} is not a safe directory: ${directoryPath}`);
  }
  await mkdir(directoryPath, { recursive: true });
}

async function readManifest(manifestPath, fingerprint) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw conflict(`Output manifest is malformed: ${manifestPath}`);
  }
  if (!isExpectedManifest(manifest, fingerprint)) {
    throw conflict(`Output manifest is incompatible with this source: ${manifestPath}`);
  }
  return manifest;
}

function initialManifest(source) {
  return {
    schemaVersion: 1,
    status: "building",
    source,
    transcript: null,
    segments: [],
    images: [],
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
}

export function workspaceCacheDir(cacheRoot, fingerprint) {
  return path.join(cacheRoot, fingerprint);
}

export async function openWorkspace({ cacheRoot, fingerprint, outputDir, source }) {
  if (!source || source.fingerprint !== fingerprint) {
    throw conflict("Workspace fingerprint must match the source fingerprint");
  }
  const cacheDir = workspaceCacheDir(cacheRoot, fingerprint);
  const manifestPath = path.join(outputDir, manifestFilename);
  const imagesDir = path.join(outputDir, "images");
  await ensureDirectory(cacheDir, "Cache workspace");
  await ensureDirectory(outputDir, "Output path");

  const manifestInfo = await statOrNull(manifestPath);
  if (manifestInfo && (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())) {
    throw conflict(`Output manifest is not a safe file: ${manifestPath}`);
  }

  if (manifestInfo) {
    await readManifest(manifestPath, fingerprint);
  } else if ((await readdir(outputDir)).length > 0) {
    throw conflict(`Refusing to overwrite nonempty output without a v2w manifest: ${outputDir}`);
  } else {
    await writeFileAtomic(manifestPath, `${JSON.stringify(initialManifest(source), null, 2)}\n`);
  }

  await ensureDirectory(imagesDir, "Output images path");

  async function loadManifest() {
    return readManifest(manifestPath, fingerprint);
  }

  async function saveManifest(manifest) {
    if (!isExpectedManifest(manifest, fingerprint)) {
      throw conflict(`Refusing to save an incompatible manifest: ${manifestPath}`);
    }
    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  return {
    cacheDir,
    outputDir,
    imagesDir,
    manifestPath,
    loadManifest,
    saveManifest,
    async recordFrame(manifest, frame) {
      const replacement = normalizeFrame(frame);
      const images = [
        ...manifest.images.filter((image) => image.filename !== replacement.filename),
        replacement,
      ].sort((left, right) => left.timestampMs - right.timestampMs
        || left.filename.localeCompare(right.filename));
      return saveManifest({ ...manifest, images });
    },
    async markComplete(manifest) {
      return saveManifest({
        ...manifest,
        status: "complete",
        completedAt: new Date().toISOString(),
      });
    },
    async canReuseFrame(capture) {
      const manifest = await loadManifest();
      const image = manifest.images.find((entry) => entry.filename === capture.filename);
      return Boolean(image)
        && image.timestampMs === capture.timestampMs
        && isDeepStrictEqual(image.reasons, capture.reasons)
        && isDeepStrictEqual(image.associations, capture.associations)
        && isNonEmptyFile(path.join(imagesDir, capture.filename));
    },
  };
}
