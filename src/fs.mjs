import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  open,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

function temporaryPath(filePath) {
  return `${filePath}.part-${process.pid}-${randomUUID()}`;
}

async function publishAtomically(filePath, publish) {
  const temporary = temporaryPath(filePath);
  let created = false;
  let published = false;
  try {
    const handle = await open(temporary, "wx");
    created = true;
    await handle.close();
    await publish(temporary);
    await rename(temporary, filePath);
    published = true;
  } finally {
    if (created && !published) await rm(temporary, { force: true });
  }
}

export async function writeFileAtomic(filePath, data) {
  await publishAtomically(filePath, (temporary) => writeFile(temporary, data));
}

export async function copyFileAtomic(from, to) {
  await publishAtomically(to, (temporary) => copyFile(from, temporary));
}

export async function isNonEmptyFile(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function canonicalPath(filePath) {
  try {
    return await realpath(filePath);
  } catch {
    let parentPath;
    try {
      parentPath = await realpath(path.dirname(filePath));
    } catch {
      parentPath = path.resolve(path.dirname(filePath));
    }
    return path.join(parentPath, path.basename(filePath));
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
