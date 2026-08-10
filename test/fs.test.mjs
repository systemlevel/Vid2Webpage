import assert from "node:assert/strict";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalPath,
  captureFileIdentity,
  copyFileAtomic,
  isNonEmptyFile,
  pathMatchesFileIdentity,
  writeFileAtomic,
} from "../src/fs.mjs";

test("atomic helpers publish complete files", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-fs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const one = path.join(dir, "one.txt");
  const two = path.join(dir, "two.txt");
  await writeFileAtomic(one, "complete");
  await copyFileAtomic(one, two);
  assert.equal(await readFile(two, "utf8"), "complete");
  assert.equal(await isNonEmptyFile(two), true);
});

test("concurrent atomic publications to one target all succeed", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-fs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "shared.txt");
  const payloads = Array.from(
    { length: 8 },
    (_, index) => `publication-${index}-${"x".repeat(1024 * 128)}`
  );

  await Promise.all(payloads.map((payload) => writeFileAtomic(target, payload)));

  assert.ok(payloads.includes(await readFile(target, "utf8")));
});

test("atomic helpers remove their temporary sibling when publication fails", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-fs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const temporary = `${dir}.part-${process.pid}`;

  await assert.rejects(writeFileAtomic(dir, "complete"));
  await assert.rejects(access(temporary));
  await assert.rejects(copyFileAtomic(import.meta.filename, dir));
  await assert.rejects(access(temporary));
});

test("isNonEmptyFile rejects empty and missing paths", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-fs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const empty = path.join(dir, "empty.txt");
  await writeFileAtomic(empty, "");

  assert.equal(await isNonEmptyFile(empty), false);
  assert.equal(await isNonEmptyFile(path.join(dir, "missing.txt")), false);
});

test("canonicalPath resolves symlinked existing ancestors of missing descendants", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-canonical-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const actual = path.join(dir, "actual");
  const alias = path.join(dir, "alias");
  await mkdir(actual);
  await symlink(actual, alias);

  assert.equal(
    await canonicalPath(path.join(alias, "missing", "output")),
    path.join(await realpath(actual), "missing", "output"),
  );
});

test("captured file identity recognizes direct, symlink, and hard-link aliases", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2w-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = path.join(dir, "caption.vtt");
  const symbolic = path.join(dir, "caption-symbolic.vtt");
  const hard = path.join(dir, "caption-hard.vtt");
  await writeFile(original, "caption");
  await symlink(original, symbolic);
  await link(original, hard);
  const captured = await captureFileIdentity(original);

  assert.equal(await pathMatchesFileIdentity(original, captured), true);
  assert.equal(await pathMatchesFileIdentity(symbolic, captured), true);
  assert.equal(await pathMatchesFileIdentity(hard, captured), true);
  assert.equal(await pathMatchesFileIdentity(path.join(dir, "missing.vtt"), captured), false);
});
