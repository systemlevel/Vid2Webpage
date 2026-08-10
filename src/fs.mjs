import { randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

function temporaryPath(filePath) {
  return `${filePath}.part-${process.pid}-${randomUUID()}`;
}

function retainedTemporaryPath(filePath, retentionDir) {
  return path.join(
    retentionDir,
    `part-${path.basename(filePath)}-${process.pid}-${randomUUID()}`,
  );
}

function infoIsProtected(info, protectedFiles) {
  return protectedFiles.some((protectedFile) =>
    hasFileIdentity(info, protectedFile?.identity));
}

function pathIsProtected(filePath, protectedFiles) {
  const resolved = path.resolve(filePath);
  return protectedFiles.some((protectedFile) =>
    (typeof protectedFile?.path === "string" && path.resolve(protectedFile.path) === resolved)
      || (typeof protectedFile?.canonicalPath === "string"
        && path.resolve(protectedFile.canonicalPath) === resolved));
}

function statOrNullSync(filePath) {
  try {
    return statSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function lstatOrNullSync(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const nativePublicationOps = {
  link: linkSync,
  lstat: lstatSync,
  mkdir: mkdirSync,
  rename: renameSync,
  stat: statSync,
};

export class AtomicPublicationConflictError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "AtomicPublicationConflictError";
  }
}

function publicationInfoOrNull(filePath, operation) {
  try {
    return operation(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertUnprotectedDestination(filePath, protectedFiles) {
  const protectedInfo = statOrNullSync(filePath);
  if (pathIsProtected(filePath, protectedFiles)
    || (protectedInfo && infoIsProtected(protectedInfo, protectedFiles))) {
    throw new Error(`Publication destination aliases a protected file: ${filePath}`);
  }
}

function publishOwnedTempSync({ filePath, temporary, identity, protectedFiles }) {
  const current = lstatOrNullSync(temporary);
  if (!current
    || !current.isFile()
    || current.isSymbolicLink()
    || !hasFileIdentity(current, identity)) {
    throw new Error(`Owned publication temp identity changed: ${temporary}`);
  }
  assertUnprotectedDestination(filePath, protectedFiles);
  renameSync(temporary, filePath);
  const published = lstatOrNullSync(filePath);
  if (!published
    || !published.isFile()
    || published.isSymbolicLink()
    || !hasFileIdentity(published, identity)) {
    throw new Error(`Published file identity changed: ${filePath}`);
  }
}

function restoreCapturedNoOverwrite(capturedPath, filePath, fileOps) {
  try {
    fileOps.link(capturedPath, filePath);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

function retainedSlot(retentionDir, purpose, fileOps) {
  const slotPath = path.join(
    retentionDir,
    `${purpose}-${process.pid}-${randomUUID()}`,
  );
  fileOps.mkdir(slotPath, { mode: 0o700 });
  const slotInfo = publicationInfoOrNull(slotPath, fileOps.lstat);
  if (!slotInfo || !slotInfo.isDirectory() || slotInfo.isSymbolicLink()) {
    throw new AtomicPublicationConflictError(
      `Publication retention slot is not a private directory: ${slotPath}`,
    );
  }
  return slotPath;
}

function validateRetentionDirectory(filePath, retentionDir, fileOps) {
  if (typeof retentionDir !== "string" || retentionDir.length === 0) {
    throw new AtomicPublicationConflictError(
      `Protected publication requires a retention directory: ${filePath}`,
    );
  }
  const retentionInfo = publicationInfoOrNull(retentionDir, fileOps.lstat);
  const destinationParentInfo = publicationInfoOrNull(
    path.dirname(filePath),
    fileOps.lstat,
  );
  if (!retentionInfo
    || !retentionInfo.isDirectory()
    || retentionInfo.isSymbolicLink()
    || !destinationParentInfo
    || !destinationParentInfo.isDirectory()
    || destinationParentInfo.isSymbolicLink()
    || retentionInfo.dev !== destinationParentInfo.dev) {
    throw new AtomicPublicationConflictError(
      `Publication retention must be a safe same-filesystem directory: ${retentionDir}`,
    );
  }
}

function sameEntry(left, right) {
  return Boolean(left && right)
    && left.isFile() === right.isFile()
    && left.isDirectory() === right.isDirectory()
    && left.isSymbolicLink() === right.isSymbolicLink()
    && hasFileIdentity(left, fileIdentity(right));
}

function captureDestination(filePath, retentionDir, fileOps) {
  const observed = publicationInfoOrNull(filePath, fileOps.lstat);
  const slotPath = retainedSlot(retentionDir, "publication", fileOps);
  const capturedPath = path.join(slotPath, "prior");
  let captured = false;
  try {
    fileOps.rename(filePath, capturedPath);
    captured = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const capturedInfo = captured
    ? publicationInfoOrNull(capturedPath, fileOps.lstat)
    : null;
  return { captured, capturedInfo, capturedPath, observed, slotPath };
}

function restoreSafeCaptured(capture, filePath, fileOps) {
  if (!capture.capturedInfo
    || !capture.capturedInfo.isFile()
    || capture.capturedInfo.isSymbolicLink()) return false;
  return restoreCapturedNoOverwrite(capture.capturedPath, filePath, fileOps);
}

function retainFailedDestination(filePath, retentionDir, fileOps) {
  const slotPath = retainedSlot(retentionDir, "failed-publication", fileOps);
  const retainedPath = path.join(slotPath, "destination");
  try {
    fileOps.rename(filePath, retainedPath);
    return retainedPath;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function publishProtectedOwnedTempSync({
  filePath,
  temporary,
  identity,
  protectedFiles,
  retentionDir,
  fileOps: overrides,
}) {
  const fileOps = { ...nativePublicationOps, ...overrides };
  validateRetentionDirectory(filePath, retentionDir, fileOps);
  const current = publicationInfoOrNull(temporary, fileOps.lstat);
  if (!current
    || !current.isFile()
    || current.isSymbolicLink()
    || !hasFileIdentity(current, identity)) {
    throw new Error(`Owned publication temp identity changed: ${temporary}`);
  }
  if (pathIsProtected(filePath, protectedFiles)) {
    throw new AtomicPublicationConflictError(
      `Publication destination is a protected path: ${filePath}`,
    );
  }

  const capture = captureDestination(filePath, retentionDir, fileOps);
  if (capture.captured) {
    const safePrior = capture.observed
      && capture.capturedInfo
      && sameEntry(capture.observed, capture.capturedInfo)
      && capture.capturedInfo.isFile()
      && !capture.capturedInfo.isSymbolicLink()
      && !infoIsProtected(capture.capturedInfo, protectedFiles);
    if (!safePrior) {
      restoreSafeCaptured(capture, filePath, fileOps);
      throw new AtomicPublicationConflictError(
        `Captured publication destination is protected, foreign, or uncertain: ${filePath}`,
      );
    }
  } else if (capture.observed) {
    throw new AtomicPublicationConflictError(
      `Publication destination changed during atomic capture: ${filePath}`,
    );
  }

  let linked = false;
  try {
    fileOps.link(temporary, filePath);
    linked = true;
    const published = publicationInfoOrNull(filePath, fileOps.lstat);
    if (!published
      || !published.isFile()
      || published.isSymbolicLink()
      || !hasFileIdentity(published, identity)) {
      throw new AtomicPublicationConflictError(
        `Published file identity changed: ${filePath}`,
      );
    }
  } catch (error) {
    if (linked) retainFailedDestination(filePath, retentionDir, fileOps);
    restoreSafeCaptured(capture, filePath, fileOps);
    throw error;
  }
}

function cleanupOwnedTempSync(temporary, identity) {
  const current = lstatOrNullSync(temporary);
  if (current
    && current.isFile()
    && !current.isSymbolicLink()
    && hasFileIdentity(current, identity)) {
    unlinkSync(temporary);
  }
}

async function reserveOwnedTemp(filePath, { retentionDir } = {}) {
  const temporary = retentionDir
    ? retainedTemporaryPath(filePath, retentionDir)
    : temporaryPath(filePath);
  const handle = await open(temporary, "wx", 0o600);
  let info;
  try {
    info = await handle.stat();
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      if (error && typeof error === "object" && error.cause === undefined) {
        error.cause = closeError;
      }
    }
    throw error;
  }
  if (!info.isFile()) {
    await handle.close();
    cleanupOwnedTempSync(temporary, fileIdentity(info));
    throw new Error(`Owned publication temp is not a regular file: ${temporary}`);
  }
  return {
    filePath,
    temporary,
    handle,
    identity: fileIdentity(info),
  };
}

async function verifyOwnedHandle(reservation, { requireNonEmpty = false } = {}) {
  const info = await reservation.handle.stat();
  if (!info.isFile()
    || !hasFileIdentity(info, reservation.identity)
    || (requireNonEmpty && info.size <= 0)) {
    throw new Error(`Owned publication handle identity changed: ${reservation.filePath}`);
  }
}

async function publishAtomically(filePath, publish, {
  protectedFiles = [],
  retentionDir,
  fileOps,
} = {}) {
  const protectedMode = protectedFiles.length > 0;
  const reservation = await reserveOwnedTemp(filePath, {
    retentionDir: protectedMode ? retentionDir : undefined,
  });
  let published = false;
  try {
    await publish(reservation.handle);
    await verifyOwnedHandle(reservation);
    if (protectedMode) {
      publishProtectedOwnedTempSync({
        ...reservation,
        protectedFiles,
        retentionDir,
        fileOps,
      });
    } else {
      publishOwnedTempSync({ ...reservation, protectedFiles });
    }
    published = true;
  } finally {
    try {
      await reservation.handle.close();
    } finally {
      if (!published && !protectedMode) {
        cleanupOwnedTempSync(reservation.temporary, reservation.identity);
      }
    }
  }
}

export async function writeFileAtomic(filePath, data, options) {
  await publishAtomically(filePath, (handle) => handle.writeFile(data), options);
}

export async function copyFileAtomic(from, to, options) {
  await publishAtomically(to, async (handle) => handle.writeFile(await readFile(from)), options);
}

export async function reserveOwnedArtifact(filePath, {
  protectedFiles = [],
  retentionDir,
} = {}) {
  const initialProtectedFiles = protectedFiles;
  const initialRetentionDir = retentionDir;
  const reservation = await reserveOwnedTemp(filePath, {
    retentionDir: protectedFiles.length > 0 ? retentionDir : undefined,
  });
  let closed = false;
  let published = false;
  let protectedMode = protectedFiles.length > 0;
  const close = async () => {
    if (closed) return;
    closed = true;
    await reservation.handle.close();
  };
  return Object.freeze({
    writer: Object.freeze({ fd: reservation.handle.fd }),
    async publish({
      protectedFiles: publicationProtectedFiles = initialProtectedFiles,
      retentionDir: publicationRetentionDir = initialRetentionDir,
    } = {}) {
      if (published || closed) throw new Error("Owned artifact reservation is no longer active");
      await verifyOwnedHandle(reservation, { requireNonEmpty: true });
      protectedMode = publicationProtectedFiles.length > 0;
      if (protectedMode) {
        publishProtectedOwnedTempSync({
          ...reservation,
          protectedFiles: publicationProtectedFiles,
          retentionDir: publicationRetentionDir,
        });
      } else {
        publishOwnedTempSync({
          ...reservation,
          protectedFiles: publicationProtectedFiles,
        });
      }
      published = true;
      await close();
      return { path: filePath, identity: reservation.identity };
    },
    async discard() {
      try {
        await close();
      } finally {
        if (!published && !protectedMode) {
          cleanupOwnedTempSync(reservation.temporary, reservation.identity);
        }
      }
    },
  });
}

export function removeOwnedFile(filePath, {
  expectedIdentity,
  protectedFiles = [],
} = {}) {
  if (protectedFiles.length > 0) {
    throw new Error("owned removal is unavailable in protected mode");
  }
  const current = lstatOrNullSync(filePath);
  if (!current) return false;
  if (!current.isFile()
    || current.isSymbolicLink()
    || !hasFileIdentity(current, expectedIdentity)) {
    throw new Error("temporary file ownership changed before removal");
  }
  if (pathIsProtected(filePath, protectedFiles)
    || infoIsProtected(current, protectedFiles)) {
    throw new Error("temporary file aliases a protected file before removal");
  }
  unlinkSync(filePath);
  return true;
}

export async function isNonEmptyFile(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export async function canonicalPath(filePath) {
  let candidate = path.resolve(filePath);
  const missingSegments = [];
  for (;;) {
    try {
      const existingPath = await realpath(candidate);
      return path.join(existingPath, ...missingSegments);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

export async function captureFileIdentity(filePath) {
  const before = await stat(filePath);
  const canonical = await canonicalPath(filePath);
  const after = await stat(filePath);
  if (!before.isFile() || !after.isFile()) {
    throw new TypeError(`Protected path is not a file: ${filePath}`);
  }
  if (!hasFileIdentity(after, fileIdentity(before))) {
    throw new Error(`Protected file identity changed while inspecting: ${filePath}`);
  }
  return {
    canonicalPath: canonical,
    identity: fileIdentity(after),
  };
}

export async function pathMatchesFileIdentity(filePath, protectedFile) {
  if (await canonicalPath(filePath) === protectedFile?.canonicalPath) return true;
  try {
    return hasFileIdentity(await stat(filePath), protectedFile?.identity);
  } catch {
    return false;
  }
}

export async function pathsReferToSameFile(firstPath, secondPath) {
  const [firstCanonicalPath, secondCanonicalPath] = await Promise.all([
    canonicalPath(firstPath),
    canonicalPath(secondPath),
  ]);
  if (firstCanonicalPath === secondCanonicalPath) return true;

  try {
    const [firstInfo, secondInfo] = await Promise.all([stat(firstPath), stat(secondPath)]);
    return firstInfo.dev === secondInfo.dev && firstInfo.ino === secondInfo.ino;
  } catch {
    return false;
  }
}

export function fileIdentity(info) {
  return { dev: info.dev, ino: info.ino };
}

export function hasFileIdentity(info, identity) {
  return info.dev === identity?.dev && info.ino === identity?.ino;
}

export async function pathIsOwnedRegularFile(filePath, identity, { inspect = lstat } = {}) {
  try {
    const info = await inspect(filePath);
    return info.isFile() && !info.isSymbolicLink() && hasFileIdentity(info, identity);
  } catch {
    return false;
  }
}
