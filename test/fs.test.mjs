import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { copyFileAtomic, isNonEmptyFile, writeFileAtomic } from "../src/fs.mjs";

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
