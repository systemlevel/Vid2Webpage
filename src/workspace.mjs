import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { OutputConflictError } from "./errors.mjs";
import {
  isNonEmptyFile,
  pathsReferToSameFile,
  writeFileAtomic,
} from "./fs.mjs";
import {
  cleanupFrameStageSync,
  FrameStageConflictError,
  publishFrameSync,
  recoverFrameStagesSync,
  resolveFrameFileOps,
  rollbackFramePublicationSync,
} from "./frame-stage.mjs";

const manifestFilename = "manifest.json";
const manifestLockFilename = ".v2w-manifest.lock";
const lockCandidateFilenamePattern = /^\.v2w-manifest\.lock\.candidate-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const lockOwnerFilenamePattern = /^owner-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
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

function lockOwnerFilename(token) {
  return `owner-${token}.json`;
}

function parseLockMetadata(lockText, expectedToken) {
  try {
    const metadata = JSON.parse(lockText);
    if (isPlainObject(metadata)
      && hasExactKeys(metadata, ["token", "pid", "acquiredAt"])
      && metadata.token === expectedToken
      && Number.isSafeInteger(metadata.pid) && metadata.pid > 0
      && isValidTimestamp(metadata.acquiredAt)) {
      return metadata;
    }
  } catch {
    // Canonical lock metadata is published complete, so malformed state is never stolen.
  }
  return null;
}

function isProcessAlive(pid, killProcess) {
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    return true;
  }
}

async function removeEmptyDirectoryOnce(directoryPath) {
  try {
    await rmdir(directoryPath);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) return false;
    throw error;
  }
}

// Owner filenames are per-acquisition identities and are never reused. A stale
// actor can therefore unlink only its observed generation. It then attempts one
// nonrecursive rmdir: any replacement generation is nonempty, so it survives.
async function removeOwnerIdentity(directoryPath, filename, afterUnlink) {
  let unlinked = false;
  try {
    await unlink(path.join(directoryPath, filename));
    unlinked = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (unlinked) await afterUnlink?.();
  await removeEmptyDirectoryOnce(directoryPath);
}

async function prepareLockCandidate(lockPath, token, hooks) {
  const candidatePath = `${lockPath}.candidate-${token}`;
  const filename = lockOwnerFilename(token);
  const metadata = lockMetadata(token);
  const metadataPath = path.join(candidatePath, filename);
  const owner = {
    candidatePath,
    lockPath,
    ownerFilename: filename,
    metadata,
  };
  let handle;
  await mkdir(candidatePath);
  try {
    handle = await open(metadataPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(metadata));
    await handle.sync();
    if (hooks.closeLockMetadata) {
      await hooks.closeLockMetadata(handle, owner);
    } else {
      await handle.close();
    }
    handle = undefined;
    return owner;
  } catch (error) {
    const cleanupErrors = [];
    try {
      await handle?.close();
    } catch (closeError) {
      cleanupErrors.push(closeError);
    }
    try {
      await removeOwnerIdentity(candidatePath, filename);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0 && error && typeof error === "object" && error.cause === undefined) {
      error.cause = cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, "Lock candidate cleanup failed");
    }
    throw error;
  }
}

async function readLockOwner(lockPath) {
  const lockInfo = await statOrNull(lockPath);
  if (!lockInfo) return { state: "absent" };
  if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink()) {
    throw conflict(`Workspace manifest is busy: ${lockPath}`);
  }

  let entries;
  try {
    entries = await readdir(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return { state: "absent" };
    throw error;
  }
  if (entries.length === 0) return { state: "empty" };
  if (entries.length !== 1) {
    throw conflict(`Workspace manifest is busy: ${lockPath}`);
  }

  const [filename] = entries;
  const token = lockOwnerFilenamePattern.exec(filename)?.[1];
  if (!token) throw conflict(`Workspace manifest is busy: ${lockPath}`);
  const metadataPath = path.join(lockPath, filename);
  const metadataInfo = await statOrNull(metadataPath);
  if (!metadataInfo) return { state: "changed" };
  if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) {
    throw conflict(`Workspace manifest is busy: ${lockPath}`);
  }

  let lockText;
  try {
    lockText = await readFile(metadataPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { state: "changed" };
    throw error;
  }
  const metadata = parseLockMetadata(lockText, token);
  if (!metadata) throw conflict(`Workspace manifest is busy: ${lockPath}`);
  return {
    state: "owned",
    lockPath,
    ownerFilename: filename,
    metadata,
  };
}

async function recoverOrRejectExistingLock(lockPath, hooks) {
  const owner = await readLockOwner(lockPath);
  if (owner.state === "absent" || owner.state === "changed") return;
  if (owner.state === "empty") {
    await removeEmptyDirectoryOnce(lockPath);
    return;
  }
  const killProcess = hooks.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  if (isProcessAlive(owner.metadata.pid, killProcess)) {
    throw conflict(`Workspace manifest is busy: ${lockPath}`);
  }
  await hooks.beforeStaleOwnerUnlink?.(owner);
  await removeOwnerIdentity(lockPath, owner.ownerFilename, async () => {
    await hooks.afterStaleOwnerUnlink?.(owner);
  });
}

async function releaseOwnedLock(owner) {
  await removeOwnerIdentity(owner.lockPath, owner.ownerFilename);
}

function isLockPublicationConflict(error) {
  return ["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR", "EPERM"].includes(error.code);
}

async function acquireMutationLock(lockPath, hooks) {
  const token = randomUUID();
  const owner = await prepareLockCandidate(lockPath, token, hooks);
  let published = false;
  try {
    await hooks.afterLockCandidatePrepared?.(owner);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rename(owner.candidatePath, lockPath);
      } catch (error) {
        if (!isLockPublicationConflict(error)) throw error;
        await recoverOrRejectExistingLock(lockPath, hooks);
        continue;
      }

      published = true;
      try {
        await hooks.afterLockPublished?.(owner);
      } catch (error) {
        try {
          await releaseOwnedLock(owner);
        } catch (cleanupError) {
          error.cause = cleanupError;
        }
        throw error;
      }
      return async () => {
        await releaseOwnedLock(owner);
      };
    }
    throw conflict(`Workspace manifest is busy: ${lockPath}`);
  } finally {
    if (!published) {
      await removeOwnerIdentity(owner.candidatePath, owner.ownerFilename);
    }
  }
}

async function withMutationLock(lockPath, hooks, operation) {
  const release = await acquireMutationLock(lockPath, hooks);
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

export async function openWorkspace({
  cacheRoot,
  fingerprint,
  outputDir,
  source,
  hooks = {},
  frameFileOps = {},
}) {
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
  const resolvedFrameFileOps = resolveFrameFileOps(frameFileOps);
  await ensureDirectory(cacheDir, "Cache workspace");
  await ensureDirectory(outputDir, "Output path");

  await hooks.beforeInitializationLock?.();
  const manifest = await withMutationLock(manifestLockPath, hooks, async () => {
    const manifestInfo = await statOrNull(manifestPath);
    if (manifestInfo && (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())) {
      throw conflict(`Output manifest is not a safe file: ${manifestPath}`);
    }
    if (manifestInfo) {
      return readManifest(manifestPath, fingerprint, imagesDir);
    }
    const outputEntries = (await readdir(outputDir))
      .filter((entry) => entry !== manifestLockFilename
        && !lockCandidateFilenamePattern.test(entry));
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
    return withMutationLock(manifestLockPath, hooks, async () => {
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

  function isValidIdentity(identity) {
    return isPlainObject(identity)
      && hasExactKeys(identity, ["dev", "ino"])
      && isNonNegativeInteger(identity.dev)
      && isNonNegativeInteger(identity.ino);
  }

  function validatePreparedFrame(preparedFrame) {
    if (!isPlainObject(preparedFrame)) {
      throw conflict("Prepared frame transaction is invalid");
    }
    const {
      generationPath,
      generationIdentity,
      ownerPath,
      ownerIdentity,
      tempPath,
      tempIdentity,
      tempFd,
      sourcePath,
      sourceIdentity,
      frame,
    } = preparedFrame;
    const replacement = validateFrame(frame, imagesDir, { canonical: true });
    const resolvedImagesDir = path.resolve(imagesDir);
    const resolvedGenerationPath = typeof generationPath === "string"
      ? path.resolve(generationPath)
      : "";
    const resolvedOwnerPath = typeof ownerPath === "string" ? path.resolve(ownerPath) : "";
    const resolvedTempPath = typeof tempPath === "string" ? path.resolve(tempPath) : "";
    const generationBasename = path.basename(resolvedGenerationPath);
    const token = generationBasename.startsWith(".v2w-frame-stage-")
      ? generationBasename.slice(".v2w-frame-stage-".length)
      : "";
    if (!token || !/^[0-9a-f-]+$/u.test(token)
      || path.dirname(resolvedGenerationPath) !== resolvedImagesDir
      || path.dirname(resolvedOwnerPath) !== resolvedGenerationPath
      || path.basename(resolvedOwnerPath) !== `owner-${token}`
      || path.dirname(resolvedTempPath) !== resolvedGenerationPath
      || path.basename(resolvedTempPath) !== replacement.filename
      || !isValidIdentity(generationIdentity)
      || !isValidIdentity(ownerIdentity)
      || !isValidIdentity(tempIdentity)
      || !Number.isSafeInteger(tempFd) || tempFd < 0
      || typeof sourcePath !== "string" || sourcePath.length === 0
      || !(sourceIdentity === null || isValidIdentity(sourceIdentity))) {
      throw conflict("Prepared frame temp path or identity is invalid");
    }
    return {
      generationPath: resolvedGenerationPath,
      generationIdentity,
      ownerPath: resolvedOwnerPath,
      ownerIdentity,
      tempPath: resolvedTempPath,
      tempIdentity,
      tempFd,
      sourcePath,
      sourceIdentity,
      frame: replacement,
      token,
    };
  }

  function validateFrameStageCleanup(stage) {
    if (!isPlainObject(stage)) throw conflict("Frame stage cleanup is invalid");
    const generationPath = typeof stage.generationPath === "string"
      ? path.resolve(stage.generationPath)
      : "";
    const ownerPath = typeof stage.ownerPath === "string" ? path.resolve(stage.ownerPath) : "";
    const tempPath = typeof stage.tempPath === "string" ? path.resolve(stage.tempPath) : "";
    const token = path.basename(generationPath).startsWith(".v2w-frame-stage-")
      ? path.basename(generationPath).slice(".v2w-frame-stage-".length)
      : "";
    const backupPath = typeof stage.backupPath === "string"
      ? path.resolve(stage.backupPath)
      : undefined;
    if (!token || !/^[0-9a-f-]+$/u.test(token)
      || path.dirname(generationPath) !== path.resolve(imagesDir)
      || path.dirname(ownerPath) !== generationPath
      || path.basename(ownerPath) !== `owner-${token}`
      || path.dirname(tempPath) !== generationPath
      || !isValidIdentity(stage.generationIdentity)
      || !isValidIdentity(stage.ownerIdentity)
      || !(stage.tempIdentity === undefined || isValidIdentity(stage.tempIdentity))
      || (backupPath !== undefined
        && (path.dirname(backupPath) !== generationPath
          || path.basename(backupPath) !== `previous-${token}`
          || !isValidIdentity(stage.backupIdentity)))) {
      throw conflict("Frame stage cleanup path or identity is invalid");
    }
    return {
      ...stage,
      generationPath,
      ownerPath,
      tempPath,
      backupPath,
    };
  }

  async function validateCompleteInventory(manifestToComplete) {
    const entries = await readdir(imagesDir, { withFileTypes: true });
    const expected = manifestToComplete.images.map((image) => image.filename).sort();
    const actual = entries.map((entry) => entry.name).sort();
    if (!isDeepStrictEqual(actual, expected)) {
      throw conflict("Output images inventory does not exactly match the manifest");
    }
    for (const entry of entries) {
      const info = await lstat(path.join(imagesDir, entry.name));
      if (!entry.isFile() || entry.isSymbolicLink() || !info.isFile()
        || info.isSymbolicLink() || info.size <= 0) {
        throw conflict("Output images inventory contains an invalid or empty image");
      }
      if (manifestToComplete.source.kind === "local"
        && await pathsReferToSameFile(
          manifestToComplete.source.input,
          path.join(imagesDir, entry.name),
        )) {
        throw conflict("Output image inventory aliases the local video");
      }
    }
  }

  async function reuseFrameFromManifest(manifestToCheck, capture) {
    const requested = validateFrame(capture, imagesDir);
    const image = manifestToCheck.images.find((entry) => entry.filename === requested.filename);
    return Boolean(image)
      && image.timestampMs === requested.timestampMs
      && isDeepStrictEqual(image.reasons, requested.reasons)
      && isDeepStrictEqual(image.associations, requested.associations)
      && isNonEmptyFile(assertSafeFilename(requested.filename, imagesDir));
  }

  async function commitPreparedFrame(current, preparedFrame) {
    const prepared = validatePreparedFrame(preparedFrame);
    const finalPath = assertSafeFilename(prepared.frame.filename, imagesDir);
    const images = [
      ...current.images.filter((image) => image.filename !== prepared.frame.filename),
      prepared.frame,
    ].sort((left, right) => left.timestampMs - right.timestampMs
      || left.filename.localeCompare(right.filename));
    const nextManifest = {
      ...current,
      images,
      revision: current.revision + 1,
    };
    validateManifest(nextManifest, fingerprint, imagesDir);

    try {
      publishFrameSync(prepared, finalPath, resolvedFrameFileOps);
    } catch (error) {
      preparedFrame.backupPath = prepared.backupPath;
      preparedFrame.backupIdentity = prepared.backupIdentity;
      preparedFrame.preserveBackup = prepared.preserveBackup;
      if (error instanceof FrameStageConflictError) throw conflict(error.message);
      throw error;
    }

    let writtenManifest;
    try {
      const hookResult = hooks.beforeFrameManifestWrite?.({
        tempPath: prepared.tempPath,
        finalPath,
        frame: prepared.frame,
        manifest: nextManifest,
      });
      if (hookResult && typeof hookResult.then === "function") {
        throw conflict("Frame manifest failure injection must be synchronous");
      }
      writtenManifest = await writeManifest(nextManifest);
    } catch (error) {
      try {
        rollbackFramePublicationSync(prepared, finalPath, resolvedFrameFileOps);
      } catch (rollbackError) {
        if (error && typeof error === "object" && error.cause === undefined) {
          error.cause = rollbackError;
        }
      }
      preparedFrame.backupPath = prepared.backupPath;
      preparedFrame.backupIdentity = prepared.backupIdentity;
      preparedFrame.preserveBackup = prepared.preserveBackup;
      throw error;
    }

    preparedFrame.backupPath = prepared.backupPath;
    preparedFrame.backupIdentity = prepared.backupIdentity;
    preparedFrame.preserveBackup = prepared.preserveBackup;
    return writtenManifest;
  }

  async function withFrameLease(manifestToUpdate, operation, { preserveGeneration } = {}) {
    validateManifest(manifestToUpdate, fingerprint, imagesDir);
    if (manifestToUpdate.status !== "building") {
      throw conflict("Cannot lease frames in a completed manifest");
    }
    return withMutationLock(manifestLockPath, hooks, async () => {
      const current = await loadManifest();
      if (current.status !== "building") {
        throw conflict("Completed output manifests are immutable");
      }
      if (manifestToUpdate.revision !== current.revision) {
        throw conflict("Workspace manifest revision is stale");
      }
      const blockedStages = recoverFrameStagesSync(imagesDir, resolvedFrameFileOps, {
        preserveGeneration,
      });
      if (blockedStages.length > 0) {
        throw conflict(`Abandoned frame generation changed during recovery: ${blockedStages[0]}`);
      }
      let committed = false;
      return operation({
        manifest: current,
        canReuseFrame: (capture) => reuseFrameFromManifest(current, capture),
        cleanupFrame(stage) {
          cleanupFrameStageSync(validateFrameStageCleanup(stage), resolvedFrameFileOps);
        },
        async commitFrame(preparedFrame) {
          if (committed) throw conflict("Frame lease already committed");
          committed = true;
          return commitPreparedFrame(current, preparedFrame);
        },
      });
    });
  }

  return {
    cacheDir,
    outputDir,
    imagesDir,
    manifestPath,
    loadManifest,
    saveManifest,
    withFrameLease,
    async commitFrame(manifestToUpdate, preparedFrame) {
      return withFrameLease(
        manifestToUpdate,
        (lease) => lease.commitFrame(preparedFrame),
        { preserveGeneration: preparedFrame?.generationPath },
      );
    },
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
      return withMutationLock(manifestLockPath, hooks, async () => {
        const current = await loadManifest();
        if (current.status !== "building") {
          throw conflict("Completed output manifests are immutable");
        }
        if (manifestToComplete.revision !== current.revision) {
          throw conflict("Workspace manifest revision is stale");
        }
        await hooks.beforeCompletionInventory?.({ manifest: current, imagesDir });
        await validateCompleteInventory(current);
        return writeManifest({
          ...current,
          status: "complete",
          revision: current.revision + 1,
          completedAt: new Date().toISOString(),
        });
      });
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
