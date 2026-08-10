import {
  fstatSync,
  linkSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import { fileIdentity, hasFileIdentity } from "./fs.mjs";

const generationPattern = /^\.v2w-frame-stage-([0-9a-f-]+)$/u;

const nativeFrameFileOps = {
  fstat: fstatSync,
  link: linkSync,
  lstat: lstatSync,
  readFile: readFileSync,
  readdir: readdirSync,
  rmdir: rmdirSync,
  stat: statSync,
  unlink: unlinkSync,
};

export class FrameStageConflictError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "FrameStageConflictError";
  }
}

export function resolveFrameFileOps(overrides = {}) {
  return { ...nativeFrameFileOps, ...overrides };
}

function lstatOrNull(filePath, fileOps) {
  try {
    return fileOps.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function statOrNull(filePath, fileOps) {
  try {
    return fileOps.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isOwnedDirectory(info, expectedIdentity) {
  return Boolean(info)
    && info.isDirectory()
    && !info.isSymbolicLink()
    && hasFileIdentity(info, expectedIdentity);
}

function isOwnedRegularFile(info, expectedIdentity) {
  return Boolean(info)
    && info.isFile()
    && !info.isSymbolicLink()
    && hasFileIdentity(info, expectedIdentity);
}

function stageToken(generationPath) {
  return generationPattern.exec(path.basename(generationPath))?.[1] ?? null;
}

function ownerTextMatches(ownerPath, token, fileOps) {
  try {
    return fileOps.readFile(ownerPath, "utf8") === token;
  } catch {
    return false;
  }
}

function sameFile(firstPath, secondPath, fileOps) {
  const first = statOrNull(firstPath, fileOps);
  const second = statOrNull(secondPath, fileOps);
  return Boolean(first && second && first.dev === second.dev && first.ino === second.ino);
}

function verifyStageShell(stage, fileOps) {
  const token = stageToken(stage.generationPath);
  if (!token
    || path.dirname(stage.ownerPath) !== stage.generationPath
    || path.basename(stage.ownerPath) !== `owner-${token}`
    || !isOwnedDirectory(lstatOrNull(stage.generationPath, fileOps), stage.generationIdentity)
    || !isOwnedRegularFile(lstatOrNull(stage.ownerPath, fileOps), stage.ownerIdentity)
    || !ownerTextMatches(stage.ownerPath, token, fileOps)) {
    return false;
  }
  return true;
}

export function verifyOpenFrameStageSync(stage, fileOps, { requireNonEmpty = false } = {}) {
  let handleInfo;
  try {
    handleInfo = fileOps.fstat(stage.tempFd);
  } catch {
    return false;
  }
  if (!isOwnedRegularFile(handleInfo, stage.tempIdentity)
    || (requireNonEmpty && handleInfo.size <= 0)
    || !verifyStageShell(stage, fileOps)
    || !isOwnedRegularFile(lstatOrNull(stage.tempPath, fileOps), stage.tempIdentity)) {
    return false;
  }
  return true;
}

function pushCleanupError(errors, operation) {
  try {
    operation();
    return true;
  } catch (error) {
    errors.push(error);
    return false;
  }
}

function unlinkOwnedRegularFile(filePath, expectedIdentity, fileOps, errors) {
  let current;
  try {
    current = lstatOrNull(filePath, fileOps);
  } catch (error) {
    errors.push(error);
    return false;
  }
  if (!current) return true;
  if (!isOwnedRegularFile(current, expectedIdentity)) return false;
  return pushCleanupError(errors, () => fileOps.unlink(filePath));
}

function removeOwnerLast(stage, fileOps, errors) {
  let generationInfo;
  let entries;
  try {
    generationInfo = lstatOrNull(stage.generationPath, fileOps);
    entries = generationInfo ? fileOps.readdir(stage.generationPath) : [];
  } catch (error) {
    errors.push(error);
    return;
  }
  if (!generationInfo) return;
  if (!isOwnedDirectory(generationInfo, stage.generationIdentity)
    || entries.length !== 1
    || entries[0] !== path.basename(stage.ownerPath)
    || !isOwnedRegularFile(lstatOrNull(stage.ownerPath, fileOps), stage.ownerIdentity)) {
    return;
  }
  if (!pushCleanupError(errors, () => fileOps.unlink(stage.ownerPath))) return;
  pushCleanupError(errors, () => fileOps.rmdir(stage.generationPath));
}

export function cleanupFrameStageSync(stage, fileOps) {
  const errors = [];
  let shellOwned = false;
  try {
    shellOwned = verifyStageShell(stage, fileOps);
  } catch (error) {
    errors.push(error);
  }
  if (!shellOwned) {
    if (errors.length === 1) throw errors[0];
    return;
  }

  if (stage.tempIdentity) {
    unlinkOwnedRegularFile(stage.tempPath, stage.tempIdentity, fileOps, errors);
  }
  if (stage.backupPath && stage.backupIdentity && !stage.preserveBackup) {
    unlinkOwnedRegularFile(stage.backupPath, stage.backupIdentity, fileOps, errors);
  }
  removeOwnerLast(stage, fileOps, errors);

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Private frame generation cleanup failed");
  }
}

function captureGeneration(generationPath, token, fileOps) {
  const generationInfo = lstatOrNull(generationPath, fileOps);
  if (!generationInfo || !generationInfo.isDirectory() || generationInfo.isSymbolicLink()) {
    return null;
  }
  const entries = fileOps.readdir(generationPath, { withFileTypes: true });
  if (entries.length === 0) {
    return {
      generationPath,
      generationIdentity: fileIdentity(generationInfo),
      names: [],
      owner: null,
      members: [],
      token,
    };
  }
  const ownerName = `owner-${token}`;
  const ownerEntry = entries.find((entry) => entry.name === ownerName);
  if (!ownerEntry || !ownerEntry.isFile() || ownerEntry.isSymbolicLink()
    || entries.some((entry) => entry.name !== ownerName
      && (!entry.isFile() || entry.isSymbolicLink()))) {
    return null;
  }
  const ownerPath = path.join(generationPath, ownerName);
  const ownerInfo = lstatOrNull(ownerPath, fileOps);
  if (!ownerInfo || !ownerTextMatches(ownerPath, token, fileOps)) return null;
  const members = [];
  for (const entry of entries) {
    if (entry.name === ownerName) continue;
    const memberPath = path.join(generationPath, entry.name);
    const info = lstatOrNull(memberPath, fileOps);
    if (!info || !info.isFile() || info.isSymbolicLink()) return null;
    members.push({
      path: memberPath,
      identity: fileIdentity(info),
      name: entry.name,
    });
  }
  return {
    generationPath,
    generationIdentity: fileIdentity(generationInfo),
    names: entries.map((entry) => entry.name).sort(),
    owner: {
      path: ownerPath,
      identity: fileIdentity(ownerInfo),
      name: ownerName,
    },
    members,
    token,
  };
}

function generationSnapshotIsCurrent(snapshot, fileOps) {
  const generationInfo = lstatOrNull(snapshot.generationPath, fileOps);
  if (!isOwnedDirectory(generationInfo, snapshot.generationIdentity)) return false;
  const names = fileOps.readdir(snapshot.generationPath).sort();
  if (names.length !== snapshot.names.length
    || names.some((name, index) => name !== snapshot.names[index])) return false;
  if (!snapshot.owner) return names.length === 0;
  if (!isOwnedRegularFile(lstatOrNull(snapshot.owner.path, fileOps), snapshot.owner.identity)
    || !ownerTextMatches(snapshot.owner.path, snapshot.token, fileOps)) return false;
  return snapshot.members.every((member) =>
    isOwnedRegularFile(lstatOrNull(member.path, fileOps), member.identity));
}

function removeCapturedGeneration(snapshot, fileOps) {
  if (!generationSnapshotIsCurrent(snapshot, fileOps)) return false;
  if (!snapshot.owner) {
    fileOps.rmdir(snapshot.generationPath);
    return true;
  }
  for (const member of snapshot.members) {
    const current = lstatOrNull(member.path, fileOps);
    if (!isOwnedRegularFile(current, member.identity)) return false;
    fileOps.unlink(member.path);
  }
  const stage = {
    generationPath: snapshot.generationPath,
    generationIdentity: snapshot.generationIdentity,
    ownerPath: snapshot.owner.path,
    ownerIdentity: snapshot.owner.identity,
  };
  const errors = [];
  removeOwnerLast(stage, fileOps, errors);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Abandoned frame generation cleanup failed");
  }
  return lstatOrNull(snapshot.generationPath, fileOps) === null;
}

export function recoverFrameStagesSync(imagesDir, fileOps, { preserveGeneration } = {}) {
  const blocked = [];
  const entries = fileOps.readdir(imagesDir, { withFileTypes: true });
  for (const entry of entries) {
    const token = generationPattern.exec(entry.name)?.[1];
    if (!token || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const generationPath = path.join(imagesDir, entry.name);
    if (preserveGeneration
      && path.resolve(preserveGeneration) === path.resolve(generationPath)) continue;
    const snapshot = captureGeneration(generationPath, token, fileOps);
    if (!snapshot || !removeCapturedGeneration(snapshot, fileOps)) blocked.push(generationPath);
  }
  return blocked;
}

function frameConflict(message, cause) {
  return new FrameStageConflictError(message, cause ? { cause } : undefined);
}

function restoreBackupAfterPublishFailure(prepared, finalPath, fileOps, failure) {
  if (!prepared.backupIdentity) return;
  try {
    const finalInfo = lstatOrNull(finalPath, fileOps);
    if (!finalInfo) {
      fileOps.link(prepared.backupPath, finalPath);
      prepared.preserveBackup = false;
      return;
    }
    if (hasFileIdentity(finalInfo, prepared.backupIdentity)) {
      prepared.preserveBackup = false;
      return;
    }
    prepared.preserveBackup = true;
  } catch (restoreError) {
    prepared.preserveBackup = true;
    if (failure && typeof failure === "object" && failure.cause === undefined) {
      failure.cause = restoreError;
    }
  }
}

export function publishFrameSync(prepared, finalPath, fileOps) {
  if (!verifyOpenFrameStageSync(prepared, fileOps, { requireNonEmpty: true })) {
    throw frameConflict("Prepared frame temp is no longer the owned nonempty file");
  }
  if (prepared.sourceIdentity) {
    const sourceInfo = statOrNull(prepared.sourcePath, fileOps);
    if (!sourceInfo || !hasFileIdentity(sourceInfo, prepared.sourceIdentity)) {
      throw frameConflict("Local video identity changed before frame publication");
    }
  }
  if (sameFile(prepared.sourcePath, finalPath, fileOps)) {
    throw frameConflict("Frame output must not alias the local video");
  }

  const priorFinal = lstatOrNull(finalPath, fileOps);
  if (priorFinal) {
    if (!priorFinal.isFile() || priorFinal.isSymbolicLink()) {
      throw frameConflict("Existing frame output is not a safe regular file");
    }
    const backupPath = path.join(prepared.generationPath, `previous-${prepared.token}`);
    fileOps.link(finalPath, backupPath);
    const backupInfo = lstatOrNull(backupPath, fileOps);
    if (!isOwnedRegularFile(backupInfo, fileIdentity(priorFinal))) {
      throw frameConflict("Existing frame backup identity changed");
    }
    prepared.backupPath = backupPath;
    prepared.backupIdentity = fileIdentity(backupInfo);

    if (sameFile(prepared.sourcePath, backupPath, fileOps)) {
      prepared.preserveBackup = true;
      throw frameConflict("Existing frame output changed or aliases the local video");
    }
    const currentFinal = lstatOrNull(finalPath, fileOps);
    if (!isOwnedRegularFile(currentFinal, fileIdentity(priorFinal))) {
      prepared.preserveBackup = true;
      throw frameConflict("Existing frame output changed or aliases the local video");
    }
    fileOps.unlink(finalPath);
  }

  const currentTemp = lstatOrNull(prepared.tempPath, fileOps);
  if (!isOwnedRegularFile(currentTemp, prepared.tempIdentity)) {
    const failure = frameConflict("Prepared frame temp changed immediately before publication");
    restoreBackupAfterPublishFailure(prepared, finalPath, fileOps, failure);
    throw failure;
  }
  try {
    fileOps.link(prepared.tempPath, finalPath);
  } catch (error) {
    restoreBackupAfterPublishFailure(prepared, finalPath, fileOps, error);
    if (error.code === "EEXIST") {
      throw frameConflict("Frame final appeared during no-overwrite publication", error);
    }
    throw error;
  }
  const published = lstatOrNull(finalPath, fileOps);
  if (!isOwnedRegularFile(published, prepared.tempIdentity)) {
    const failure = frameConflict("Published frame identity changed");
    restoreBackupAfterPublishFailure(prepared, finalPath, fileOps, failure);
    throw failure;
  }
}

export function rollbackFramePublicationSync(prepared, finalPath, fileOps) {
  if (!prepared.backupIdentity) return;
  const backupInfo = lstatOrNull(prepared.backupPath, fileOps);
  if (!isOwnedRegularFile(backupInfo, prepared.backupIdentity)) {
    prepared.preserveBackup = true;
    return;
  }
  const finalInfo = lstatOrNull(finalPath, fileOps);
  if (isOwnedRegularFile(finalInfo, prepared.tempIdentity)) {
    fileOps.unlink(finalPath);
    fileOps.link(prepared.backupPath, finalPath);
    prepared.preserveBackup = false;
    return;
  }
  if (!finalInfo) {
    fileOps.link(prepared.backupPath, finalPath);
    prepared.preserveBackup = false;
    return;
  }
  if (hasFileIdentity(finalInfo, prepared.backupIdentity)) {
    prepared.preserveBackup = false;
    return;
  }
  prepared.preserveBackup = true;
}
