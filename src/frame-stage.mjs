import {
  fstatSync,
  linkSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { fileIdentity, hasFileIdentity } from "./fs.mjs";

const generationPattern = /^\.v2w-frame-stage-([0-9a-f-]+)$/u;
const backupStateSchemaVersion = 1;

const nativeFrameFileOps = {
  fstat: fstatSync,
  link: linkSync,
  lstat: lstatSync,
  readFile: readFileSync,
  readdir: readdirSync,
  rmdir: rmdirSync,
  stat: statSync,
  unlink: unlinkSync,
  writeFile: writeFileSync,
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
  let backupRemoved = true;
  if (stage.backupPath && stage.backupIdentity && !stage.preserveBackup) {
    backupRemoved = unlinkOwnedRegularFile(
      stage.backupPath,
      stage.backupIdentity,
      fileOps,
      errors,
    );
  }
  if (backupRemoved
    && stage.backupStatePath
    && stage.backupStateIdentity
    && !stage.preserveBackup) {
    unlinkOwnedRegularFile(
      stage.backupStatePath,
      stage.backupStateIdentity,
      fileOps,
      errors,
    );
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

function currentManifestFrame(manifest, filename) {
  return manifest.images.find((frame) => frame.filename === filename) ?? null;
}

function readPriorBackupState(snapshot, imagesDir, fileOps) {
  const stateName = backupStateFilename(snapshot.token);
  const backupName = `previous-${snapshot.token}`;
  const stateMember = snapshot.members.find((member) => member.name === stateName);
  const backupMember = snapshot.members.find((member) => member.name === backupName);
  if (!stateMember && !backupMember) return null;
  if (!stateMember) return false;

  let state;
  try {
    state = JSON.parse(fileOps.readFile(stateMember.path, "utf8"));
  } catch {
    return false;
  }
  let currentStateInfo;
  try {
    currentStateInfo = lstatOrNull(stateMember.path, fileOps);
  } catch {
    return false;
  }
  const finalPath = typeof state?.filename === "string"
    ? path.resolve(imagesDir, state.filename)
    : "";
  if (!isOwnedRegularFile(currentStateInfo, stateMember.identity)
    || state?.schemaVersion !== backupStateSchemaVersion
    || state.token !== snapshot.token
    || typeof state.filename !== "string"
    || state.filename !== path.basename(state.filename)
    || path.extname(state.filename).toLowerCase() !== ".jpg"
    || path.dirname(finalPath) !== path.resolve(imagesDir)
    || !Number.isSafeInteger(state.priorRevision)
    || state.priorRevision < 0
    || state.nextRevision !== state.priorRevision + 1
    || !(state.priorFrame === null || typeof state.priorFrame === "object")
    || !state.nextFrame || typeof state.nextFrame !== "object"
    || state.nextFrame.filename !== state.filename
    || (state.priorFrame !== null && state.priorFrame.filename !== state.filename)
    || !isSafeIdentity(state.tempIdentity)
    || !isSafeIdentity(state.backupIdentity)
    || !(state.sourceIdentity === null || isSafeIdentity(state.sourceIdentity))
    || (backupMember
      && !hasFileIdentity(backupMember.identity, state.backupIdentity))) {
    return false;
  }
  return { backupMember, finalPath, state };
}

function recoverPriorBackup(snapshot, imagesDir, manifest, fileOps) {
  const recovery = readPriorBackupState(snapshot, imagesDir, fileOps);
  if (recovery === null) return null;
  if (recovery === false || !manifest) return false;
  const { backupMember, finalPath, state } = recovery;
  const currentFrame = currentManifestFrame(manifest, state.filename);
  let finalInfo;
  try {
    finalInfo = lstatOrNull(finalPath, fileOps);
  } catch {
    return false;
  }

  const committed = manifest.revision === state.nextRevision
    && isDeepStrictEqual(currentFrame, state.nextFrame);
  if (committed) {
    if (!isOwnedRegularFile(finalInfo, state.tempIdentity)) return false;
    return removeCapturedGeneration(snapshot, fileOps);
  }

  const priorManifest = state.priorFrame !== null
    && manifest.revision === state.priorRevision
    && isDeepStrictEqual(currentFrame, state.priorFrame);
  if (!priorManifest) return false;
  if (state.sourceIdentity
    && hasFileIdentity(state.backupIdentity, state.sourceIdentity)) return false;

  if (!isOwnedRegularFile(finalInfo, state.backupIdentity)) {
    if (!backupMember
      || !hasFileIdentity(backupMember.identity, state.backupIdentity)) return false;
    if (finalInfo) {
      const removablePublished = isOwnedRegularFile(finalInfo, state.tempIdentity);
      const removableAnchored = finalInfo.isFile()
        && !finalInfo.isSymbolicLink()
        && Number.isSafeInteger(finalInfo.nlink)
        && finalInfo.nlink > 1;
      if (!removablePublished && !removableAnchored) return false;
      try {
        fileOps.unlink(finalPath);
      } catch {
        return false;
      }
    }
    try {
      fileOps.link(backupMember.path, finalPath);
      finalInfo = lstatOrNull(finalPath, fileOps);
    } catch {
      return false;
    }
    if (!isOwnedRegularFile(finalInfo, state.backupIdentity)) return false;
  }
  return removeCapturedGeneration(snapshot, fileOps);
}

export function recoverFrameStagesSync(
  imagesDir,
  fileOps,
  { preserveGeneration, manifest } = {},
) {
  const blocked = [];
  const entries = fileOps.readdir(imagesDir, { withFileTypes: true });
  for (const entry of entries) {
    const token = generationPattern.exec(entry.name)?.[1];
    if (!token || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const generationPath = path.join(imagesDir, entry.name);
    if (preserveGeneration
      && path.resolve(preserveGeneration) === path.resolve(generationPath)) continue;
    const snapshot = captureGeneration(generationPath, token, fileOps);
    if (!snapshot) {
      blocked.push(generationPath);
      continue;
    }
    const priorRecovery = recoverPriorBackup(snapshot, imagesDir, manifest, fileOps);
    if (priorRecovery === true) continue;
    if (priorRecovery === false || !removeCapturedGeneration(snapshot, fileOps)) {
      blocked.push(generationPath);
    }
  }
  return blocked;
}

function frameConflict(message, cause) {
  return new FrameStageConflictError(message, cause ? { cause } : undefined);
}

function backupStateFilename(token) {
  return `prior-${token}.json`;
}

function isSafeIdentity(identity) {
  return identity !== null
    && typeof identity === "object"
    && Number.isSafeInteger(identity.dev)
    && identity.dev >= 0
    && Number.isSafeInteger(identity.ino)
    && identity.ino >= 0;
}

function writePriorBackupState(prepared, fileOps) {
  const statePath = path.join(
    prepared.generationPath,
    backupStateFilename(prepared.token),
  );
  const state = {
    schemaVersion: backupStateSchemaVersion,
    token: prepared.token,
    filename: prepared.frame.filename,
    priorRevision: prepared.priorRevision,
    priorFrame: prepared.priorFrame,
    nextRevision: prepared.priorRevision + 1,
    nextFrame: prepared.frame,
    tempIdentity: prepared.tempIdentity,
    backupIdentity: prepared.backupIdentity,
    sourceIdentity: prepared.sourceIdentity,
  };
  fileOps.writeFile(statePath, `${JSON.stringify(state)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const stateInfo = lstatOrNull(statePath, fileOps);
  if (!stateInfo || !stateInfo.isFile() || stateInfo.isSymbolicLink()) {
    throw frameConflict("Existing frame backup state identity changed");
  }
  prepared.backupStatePath = statePath;
  prepared.backupStateIdentity = fileIdentity(stateInfo);
}

function restoreBackupAfterPublishFailure(prepared, finalPath, fileOps, failure) {
  if (!prepared.backupIdentity) return;
  prepared.preserveBackup = true;
  try {
    const finalInfo = lstatOrNull(finalPath, fileOps);
    if (!finalInfo) {
      fileOps.link(prepared.backupPath, finalPath);
    }
    const restored = lstatOrNull(finalPath, fileOps);
    if (isOwnedRegularFile(restored, prepared.backupIdentity)) {
      prepared.preserveBackup = false;
      return;
    }
  } catch (restoreError) {
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
    prepared.preserveBackup = true;
    writePriorBackupState(prepared, fileOps);

    if (sameFile(prepared.sourcePath, backupPath, fileOps)) {
      throw frameConflict("Existing frame output changed or aliases the local video");
    }
    const currentFinal = lstatOrNull(finalPath, fileOps);
    if (!isOwnedRegularFile(currentFinal, fileIdentity(priorFinal))) {
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
  prepared.preserveBackup = true;
  const backupInfo = lstatOrNull(prepared.backupPath, fileOps);
  if (!isOwnedRegularFile(backupInfo, prepared.backupIdentity)) {
    return;
  }
  const finalInfo = lstatOrNull(finalPath, fileOps);
  if (isOwnedRegularFile(finalInfo, prepared.tempIdentity)) {
    fileOps.unlink(finalPath);
    fileOps.link(prepared.backupPath, finalPath);
  } else if (!finalInfo) {
    fileOps.link(prepared.backupPath, finalPath);
  }
  const restored = lstatOrNull(finalPath, fileOps);
  if (isOwnedRegularFile(restored, prepared.backupIdentity)) {
    prepared.preserveBackup = false;
  }
}
