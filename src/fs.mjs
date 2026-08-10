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
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

function temporaryPath(filePath) {
  return `${filePath}.part-${process.pid}-${randomUUID()}`;
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
  rename: renameSync,
  stat: statSync,
};

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

function publishProtectedOwnedTempSync({
  filePath,
  temporary,
  identity,
  protectedFiles,
  fileOps: overrides,
}) {
  const fileOps = { ...nativePublicationOps, ...overrides };
  const current = publicationInfoOrNull(temporary, fileOps.lstat);
  if (!current
    || !current.isFile()
    || current.isSymbolicLink()
    || !hasFileIdentity(current, identity)) {
    throw new Error(`Owned publication temp identity changed: ${temporary}`);
  }
  if (pathIsProtected(filePath, protectedFiles)) {
    throw new Error(`Publication destination is a protected path: ${filePath}`);
  }

  const capturedPath = `${filePath}.retained-${process.pid}-${randomUUID()}`;
  let captured = false;
  try {
    fileOps.rename(filePath, capturedPath);
    captured = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (captured) {
    const capturedInfo = publicationInfoOrNull(capturedPath, fileOps.stat);
    if (capturedInfo) restoreCapturedNoOverwrite(capturedPath, filePath, fileOps);
    throw new Error(`Captured publication destination is protected, foreign, or uncertain: ${filePath}`);
  }

  try {
    fileOps.link(temporary, filePath);
  } catch (error) {
    if (captured) restoreCapturedNoOverwrite(capturedPath, filePath, fileOps);
    throw error;
  }
  const published = publicationInfoOrNull(filePath, fileOps.lstat);
  if (!published
    || !published.isFile()
    || published.isSymbolicLink()
    || !hasFileIdentity(published, identity)) {
    throw new Error(`Published file identity changed: ${filePath}`);
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

async function reserveOwnedTemp(filePath) {
  const temporary = temporaryPath(filePath);
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
  fileOps,
} = {}) {
  const reservation = await reserveOwnedTemp(filePath);
  let published = false;
  try {
    await publish(reservation.handle);
    await verifyOwnedHandle(reservation);
    if (protectedFiles.length > 0) {
      publishProtectedOwnedTempSync({ ...reservation, protectedFiles, fileOps });
    } else {
      publishOwnedTempSync({ ...reservation, protectedFiles });
    }
    published = true;
  } finally {
    try {
      await reservation.handle.close();
    } finally {
      if (!published && protectedFiles.length === 0) {
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

export async function reserveOwnedArtifact(filePath, { protectedFiles = [] } = {}) {
  const reservation = await reserveOwnedTemp(filePath);
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
    async publish({ protectedFiles = [] } = {}) {
      if (published || closed) throw new Error("Owned artifact reservation is no longer active");
      await verifyOwnedHandle(reservation, { requireNonEmpty: true });
      protectedMode = protectedFiles.length > 0;
      if (protectedMode) {
        publishProtectedOwnedTempSync({ ...reservation, protectedFiles });
      } else {
        publishOwnedTempSync({ ...reservation, protectedFiles });
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
