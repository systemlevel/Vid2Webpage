import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { OutputConflictError } from "./errors.mjs";
import { isNonEmptyFile, writeFileAtomic } from "./fs.mjs";

const manifestFilename = "manifest.json";
const manifestLockFilename = ".v2w-manifest.lock";
const incompleteLockRecoveryAgeMs = 1000;
const reasonPriority = new Map([
  ["primary", 0],
  ["scene", 1],
  ["caption", 2],
]);
const frameKeys = [
  "requestedMs",
  "timestampMs",
  "reasons",
  "associations",
  "filename",
  "width",
  "height",
];
const associationKeys = ["segmentIndex", "requestedMs", "reasons"];

function conflict(message) {
  return new OutputConflictError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isValidTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function compareReasons(left, right) {
  return (reasonPriority.get(left) ?? Infinity) - (reasonPriority.get(right) ?? Infinity)
    || left.localeCompare(right);
}

function compareStringArrays(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function validateReasons(reasons, description) {
  if (!Array.isArray(reasons) || reasons.length === 0
    || reasons.some((reason) => typeof reason !== "string" || !reasonPriority.has(reason))
    || new Set(reasons).size !== reasons.length) {
    throw conflict(`${description} must contain unique known reasons`);
  }
  return [...reasons].sort(compareReasons);
}

function compareAssociations(left, right) {
  return left.segmentIndex - right.segmentIndex
    || left.requestedMs - right.requestedMs
    || compareStringArrays(left.reasons, right.reasons);
}

function assertSafeFilename(filename, imagesDir) {
  if (typeof filename !== "string" || filename.length === 0
    || path.isAbsolute(filename)
    || filename !== path.basename(filename)
    || filename.includes("/")
    || filename.includes("\\")) {
    throw conflict(`Frame filename is not a safe basename: ${filename}`);
  }
  const resolvedImagesDir = path.resolve(imagesDir);
  const resolvedImagePath = path.resolve(imagesDir, filename);
  if (!resolvedImagePath.startsWith(`${resolvedImagesDir}${path.sep}`)) {
    throw conflict(`Frame filename escapes the images directory: ${filename}`);
  }
  return resolvedImagePath;
}

function validateFrame(frame, imagesDir, { canonical = false } = {}) {
  if (!isPlainObject(frame) || !hasExactKeys(frame, frameKeys)) {
    throw conflict("Frame record has an invalid shape");
  }
  if (!isNonNegativeInteger(frame.requestedMs) || !isNonNegativeInteger(frame.timestampMs)
    || !Number.isSafeInteger(frame.width) || frame.width <= 0
    || !Number.isSafeInteger(frame.height) || frame.height <= 0) {
    throw conflict("Frame record has invalid timestamps or dimensions");
  }
  assertSafeFilename(frame.filename, imagesDir);
  const sortedReasons = validateReasons(frame.reasons, "Frame reasons");
  if (!Array.isArray(frame.associations) || frame.associations.length === 0) {
    throw conflict("Frame record must include associations");
  }
  const associations = frame.associations.map((association) => {
    if (!isPlainObject(association) || !hasExactKeys(association, associationKeys)
      || !isNonNegativeInteger(association.segmentIndex)
      || !isNonNegativeInteger(association.requestedMs)) {
      throw conflict("Frame association has an invalid shape");
    }
    return {
      segmentIndex: association.segmentIndex,
      requestedMs: association.requestedMs,
      reasons: validateReasons(association.reasons, "Frame association reasons"),
    };
  });
  const associationReasons = [...new Set(associations.flatMap((association) => association.reasons))]
    .sort(compareReasons);
  if (!isDeepStrictEqual(sortedReasons, associationReasons)) {
    throw conflict("Frame reasons must match the association reason union");
  }

  return {
    requestedMs: frame.requestedMs,
    timestampMs: frame.timestampMs,
    reasons: canonical ? sortedReasons : [...frame.reasons],
    associations: canonical ? associations.sort(compareAssociations) : frame.associations.map((association) => ({
      segmentIndex: association.segmentIndex,
      requestedMs: association.requestedMs,
      reasons: [...association.reasons],
    })),
    filename: frame.filename,
    width: frame.width,
    height: frame.height,
  };
}

function validateManifest(manifest, fingerprint, imagesDir) {
  if (!isPlainObject(manifest)
    || manifest.schemaVersion !== 1
    || !isPlainObject(manifest.source)
    || typeof manifest.source.fingerprint !== "string"
    || manifest.source.fingerprint !== fingerprint
    || !Object.hasOwn(manifest, "transcript")
    || !(manifest.transcript === null || isPlainObject(manifest.transcript))
    || !Array.isArray(manifest.segments)
    || !Array.isArray(manifest.images)
    || !isNonNegativeInteger(manifest.revision)
    || !isValidTimestamp(manifest.createdAt)
    || !((manifest.status === "building" && manifest.completedAt === null)
      || (manifest.status === "complete" && isValidTimestamp(manifest.completedAt)))) {
    throw conflict("Output manifest is incompatible with this source");
  }
  for (const image of manifest.images) {
    if (!isDeepStrictEqual(image, validateFrame(image, imagesDir, { canonical: true }))) {
      throw conflict("Output manifest contains a noncanonical frame record");
    }
  }
  return manifest;
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

function lockMetadata(token) {
  return {
    token,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
}

function parseLockMetadata(lockText) {
  try {
    const metadata = JSON.parse(lockText);
    if (isPlainObject(metadata)
      && typeof metadata.token === "string" && metadata.token.length > 0
      && Number.isSafeInteger(metadata.pid) && metadata.pid > 0
      && isValidTimestamp(metadata.acquiredAt)) {
      return metadata;
    }
  } catch {
    // Malformed lock contents are recoverable only after the conservative age threshold.
  }
  return null;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    return true;
  }
}

async function removeLockIfUnchanged(lockPath, expectedText, expectedInfo) {
  const currentInfo = await statOrNull(lockPath);
  if (!currentInfo || !currentInfo.isFile() || currentInfo.isSymbolicLink()
    || currentInfo.dev !== expectedInfo.dev || currentInfo.ino !== expectedInfo.ino) {
    return false;
  }
  const currentText = await readFile(lockPath, "utf8");
  if (currentText !== expectedText) return false;
  await rm(lockPath);
  return true;
}

async function recoverOrRejectExistingLock(lockPath) {
  const lockInfo = await statOrNull(lockPath);
  if (!lockInfo || !lockInfo.isFile() || lockInfo.isSymbolicLink()) {
    throw conflict(`Workspace manifest is busy: ${lockPath}`);
  }
  const lockText = await readFile(lockPath, "utf8");
  const metadata = parseLockMetadata(lockText);
  if (metadata) {
    if (isProcessAlive(metadata.pid)) {
      throw conflict(`Workspace manifest is busy: ${lockPath}`);
    }
  } else if (Date.now() - lockInfo.mtimeMs < incompleteLockRecoveryAgeMs) {
    throw conflict(`Workspace manifest is busy: ${lockPath}`);
  }
  if (!await removeLockIfUnchanged(lockPath, lockText, lockInfo)) {
    throw conflict(`Workspace manifest is busy: ${lockPath}`);
  }
}

async function releaseOwnedLock(lockPath, token) {
  const lockInfo = await statOrNull(lockPath);
  if (!lockInfo || !lockInfo.isFile() || lockInfo.isSymbolicLink()) return;
  const lockText = await readFile(lockPath, "utf8");
  if (parseLockMetadata(lockText)?.token === token) {
    await removeLockIfUnchanged(lockPath, lockText, lockInfo);
  }
}

async function acquireMutationLock(lockPath) {
  const token = randomUUID();
  const metadata = JSON.stringify(lockMetadata(token));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    let ownsLock = false;
    try {
      handle = await open(lockPath, "wx");
      ownsLock = true;
      await handle.writeFile(metadata);
      await handle.close();
      return async () => {
        await releaseOwnedLock(lockPath, token);
      };
    } catch (error) {
      await handle?.close();
      if (ownsLock) {
        try {
          await rm(lockPath);
        } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT") throw cleanupError;
        }
      }
      if (error.code !== "EEXIST") throw error;
      await recoverOrRejectExistingLock(lockPath);
    }
  }
  throw conflict(`Workspace manifest is busy: ${lockPath}`);
}

async function withMutationLock(lockPath, operation) {
  const release = await acquireMutationLock(lockPath);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function readManifest(manifestPath, fingerprint, imagesDir) {
  const manifestText = await readFile(manifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw conflict(`Output manifest is malformed: ${manifestPath}`);
    }
    throw error;
  }
  return validateManifest(manifest, fingerprint, imagesDir);
}

function initialManifest(source) {
  return {
    schemaVersion: 1,
    status: "building",
    source,
    transcript: null,
    segments: [],
    images: [],
    revision: 0,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
}

export function workspaceCacheDir(cacheRoot, fingerprint) {
  return path.join(cacheRoot, fingerprint);
}

export async function openWorkspace({ cacheRoot, fingerprint, outputDir, source, hooks = {} }) {
  if (typeof fingerprint !== "string" || fingerprint.length === 0
    || !isPlainObject(source)
    || typeof source.fingerprint !== "string" || source.fingerprint.length === 0
    || source.fingerprint !== fingerprint) {
    throw conflict("Workspace fingerprint must match the source fingerprint");
  }
  const cacheDir = workspaceCacheDir(cacheRoot, fingerprint);
  const manifestPath = path.join(outputDir, manifestFilename);
  const manifestLockPath = path.join(outputDir, manifestLockFilename);
  const imagesDir = path.join(outputDir, "images");
  await ensureDirectory(cacheDir, "Cache workspace");
  await ensureDirectory(outputDir, "Output path");

  await hooks.beforeInitializationLock?.();
  const manifest = await withMutationLock(manifestLockPath, async () => {
    const manifestInfo = await statOrNull(manifestPath);
    if (manifestInfo && (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())) {
      throw conflict(`Output manifest is not a safe file: ${manifestPath}`);
    }
    if (manifestInfo) {
      return readManifest(manifestPath, fingerprint, imagesDir);
    }
    const outputEntries = (await readdir(outputDir))
      .filter((entry) => entry !== manifestLockFilename);
    if (outputEntries.length > 0) {
      throw conflict(`Refusing to overwrite nonempty output without a v2w manifest: ${outputDir}`);
    }
    const createdManifest = initialManifest(source);
    await writeFileAtomic(manifestPath, `${JSON.stringify(createdManifest, null, 2)}\n`);
    return createdManifest;
  });

  if (manifest.status === "complete") {
    const imagesInfo = await statOrNull(imagesDir);
    if (!imagesInfo || !imagesInfo.isDirectory() || imagesInfo.isSymbolicLink()) {
      throw conflict(`Completed output images path is not a safe directory: ${imagesDir}`);
    }
  } else {
    await ensureDirectory(imagesDir, "Output images path");
  }

  async function loadManifest() {
    return readManifest(manifestPath, fingerprint, imagesDir);
  }

  async function writeManifest(nextManifest) {
    validateManifest(nextManifest, fingerprint, imagesDir);
    await writeFileAtomic(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
    return nextManifest;
  }

  async function saveManifest(nextManifest) {
    validateManifest(nextManifest, fingerprint, imagesDir);
    if (nextManifest.status !== "building") {
      throw conflict("saveManifest only persists building manifests");
    }
    return mutateManifest(nextManifest, () => nextManifest, "building");
  }

  async function mutateManifest(callerManifest, createNextManifest, expectedStatus) {
    validateManifest(callerManifest, fingerprint, imagesDir);
    if (callerManifest.status !== "building") {
      throw conflict("Completed output manifests are immutable");
    }
    return withMutationLock(manifestLockPath, async () => {
      const current = await loadManifest();
      if (current.status !== "building") {
        throw conflict("Completed output manifests are immutable");
      }
      if (callerManifest.revision !== current.revision) {
        throw conflict("Workspace manifest revision is stale");
      }
      const nextManifest = createNextManifest();
      validateManifest(nextManifest, fingerprint, imagesDir);
      if (nextManifest.status !== expectedStatus) {
        throw conflict("Workspace mutation has an invalid lifecycle transition");
      }
      return writeManifest({ ...nextManifest, revision: current.revision + 1 });
    });
  }

  return {
    cacheDir,
    outputDir,
    imagesDir,
    manifestPath,
    loadManifest,
    saveManifest,
    async recordFrame(manifestToUpdate, frame) {
      validateManifest(manifestToUpdate, fingerprint, imagesDir);
      if (manifestToUpdate.status !== "building") {
        throw conflict("Cannot record frames in a completed manifest");
      }
      const replacement = validateFrame(frame, imagesDir, { canonical: true });
      const images = [
        ...manifestToUpdate.images.filter((image) => image.filename !== replacement.filename),
        replacement,
      ].sort((left, right) => left.timestampMs - right.timestampMs
        || left.filename.localeCompare(right.filename));
      return mutateManifest(manifestToUpdate, () => ({ ...manifestToUpdate, images }), "building");
    },
    async markComplete(manifestToComplete) {
      validateManifest(manifestToComplete, fingerprint, imagesDir);
      if (manifestToComplete.status !== "building") {
        throw conflict("Completed output manifests are immutable");
      }
      return mutateManifest(manifestToComplete, () => ({
        ...manifestToComplete,
        status: "complete",
        completedAt: new Date().toISOString(),
      }), "complete");
    },
    async canReuseFrame(capture) {
      const requested = validateFrame(capture, imagesDir);
      const manifestToCheck = await loadManifest();
      const image = manifestToCheck.images.find((entry) => entry.filename === requested.filename);
      return Boolean(image)
        && image.timestampMs === requested.timestampMs
        && isDeepStrictEqual(image.reasons, requested.reasons)
        && isDeepStrictEqual(image.associations, requested.associations)
        && isNonEmptyFile(assertSafeFilename(requested.filename, imagesDir));
    },
  };
}
