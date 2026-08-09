import { randomUUID } from "node:crypto";
import { copyFile, open, rename, rm, stat, writeFile } from "node:fs/promises";

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
