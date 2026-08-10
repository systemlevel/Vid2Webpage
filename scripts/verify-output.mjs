#!/usr/bin/env node
import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const requiredFiles = [
  "index.html",
  "manifest.json",
  "styles.css",
  "transcript.vtt",
];

function containedPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`));
}

function sameSortedValues(actual, expected) {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function forbiddenArtifact(relativePath) {
  const parts = relativePath.split(path.sep);
  const basename = parts.at(-1).toLowerCase();
  return parts.some((part) => /retention/iu.test(part))
    || /(?:^|[.-])stage(?:[.-]|$)/iu.test(basename)
    || /(?:^|[.-])part(?:[.-]|$)/iu.test(basename)
    || /\.(?:aac|flac|m4a|m4v|mkv|mov|mp3|mp4|mpeg|mpg|ogg|opus|wav|webm)$/iu.test(basename);
}

async function assertNonemptyRegularFile(filePath, description) {
  const info = await lstat(filePath);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size > 0,
    `${description} must be a nonempty regular file: ${filePath}`,
  );
}

async function inspectInventory(outputDir) {
  const rootEntries = await readdir(outputDir, { withFileTypes: true });
  const allowedRoot = new Set([...requiredFiles, "images"]);
  for (const entry of rootEntries) {
    if (!allowedRoot.has(entry.name)) {
      throw new Error(`Forbidden output inventory: ${entry.name}`);
    }
    if (entry.name === "images") {
      assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), "images must be a real directory");
    } else {
      assert.ok(entry.isFile() && !entry.isSymbolicLink(), `${entry.name} must be a regular file`);
    }
  }

  const actualRoot = rootEntries.map((entry) => entry.name).sort();
  const expectedRoot = [...allowedRoot].sort();
  assert.ok(
    sameSortedValues(actualRoot, expectedRoot),
    `Final output inventory is incomplete: ${actualRoot.join(", ")}`,
  );

  const imageEntries = await readdir(path.join(outputDir, "images"), {
    withFileTypes: true,
  });
  for (const entry of imageEntries) {
    const relativePath = path.join("images", entry.name);
    if (forbiddenArtifact(relativePath)
      || !entry.isFile()
      || entry.isSymbolicLink()
      || !entry.name.toLowerCase().endsWith(".jpg")) {
      throw new Error(`Forbidden output inventory: ${relativePath}`);
    }
  }
  return imageEntries.map((entry) => entry.name).sort();
}

assert.ok(
  process.argv.length > 2,
  "Usage: node scripts/verify-output.mjs <output-directory> [...]",
);

for (const argument of process.argv.slice(2)) {
  const outputDir = path.resolve(argument);
  const [manifestText, transcriptText, stylesheet, html] = await Promise.all([
    readFile(path.join(outputDir, "manifest.json"), "utf8"),
    readFile(path.join(outputDir, "transcript.vtt"), "utf8"),
    readFile(path.join(outputDir, "styles.css"), "utf8"),
    readFile(path.join(outputDir, "index.html"), "utf8"),
  ]);
  assert.ok(manifestText.length > 0, "manifest.json must be nonempty");
  assert.ok(transcriptText.length > 0, "transcript.vtt must be nonempty");
  assert.ok(stylesheet.length > 0, "styles.css must be nonempty");
  assert.ok(html.length > 0, "index.html must be nonempty");
  await Promise.all(requiredFiles.map((filename) => assertNonemptyRegularFile(
    path.join(outputDir, filename),
    filename,
  )));

  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.status, "complete", "manifest status must be complete");
  assert.ok(Array.isArray(manifest.segments), "manifest segments must be an array");
  assert.ok(Array.isArray(manifest.images), "manifest images must be an array");

  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    assert.ok(
      manifest.images.some((image) => image.associations?.some((association) =>
        association.segmentIndex === segmentIndex
          && association.reasons?.includes("primary"))),
      `segment ${segmentIndex} has no primary screenshot association`,
    );
  }

  const manifestFilenames = [];
  const filenameSet = new Set();
  for (const image of manifest.images) {
    assert.ok(
      Number.isFinite(image.width) && image.width > 0
        && Number.isFinite(image.height) && image.height > 0,
      `Manifest image has invalid dimensions: ${image.filename}`,
    );
    assert.ok(
      typeof image.filename === "string"
        && image.filename.length > 0
        && image.filename === path.basename(image.filename)
        && !image.filename.includes("/")
        && !image.filename.includes("\\")
        && image.filename.toLowerCase().endsWith(".jpg"),
      `Manifest image filename must be a safe JPEG basename: ${image.filename}`,
    );
    assert.ok(
      !filenameSet.has(image.filename),
      `Duplicate manifest image filename: ${image.filename}`,
    );
    filenameSet.add(image.filename);
    manifestFilenames.push(image.filename);
  }

  const physicalFilenames = await inspectInventory(outputDir);
  const expectedPhysicalFilenames = [...manifestFilenames].sort();
  assert.ok(
    sameSortedValues(physicalFilenames, expectedPhysicalFilenames),
    `Physical JPEG inventory does not match manifest: actual=${physicalFilenames.join(",")} expected=${expectedPhysicalFilenames.join(",")}`,
  );

  const references = [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu)]
    .map((match) => match[1]);
  for (const reference of references) {
    const referencedPath = path.resolve(outputDir, reference);
    assert.ok(
      containedPath(outputDir, referencedPath),
      `HTML image reference escapes output: ${reference}`,
    );
    assert.ok(
      reference === path.posix.join("images", path.posix.basename(reference)),
      `HTML image reference is not a contained image path: ${reference}`,
    );
  }
  const uniqueReferences = [...new Set(references)].sort();
  const expectedReferences = manifestFilenames
    .map((filename) => path.posix.join("images", filename))
    .sort();
  assert.ok(
    sameSortedValues(uniqueReferences, expectedReferences),
    `Unique HTML image references do not match manifest physical filenames: actual=${uniqueReferences.join(",")} expected=${expectedReferences.join(",")}`,
  );
  await Promise.all(uniqueReferences.map((reference) => assertNonemptyRegularFile(
    path.resolve(outputDir, reference),
    `Referenced JPEG ${reference}`,
  )));

  const physicalLabel = manifestFilenames.length === 1 ? "JPEG" : "JPEGs";
  process.stdout.write(
    `${path.basename(outputDir)}: PASS (${references.length} logical references, ${manifestFilenames.length} physical ${physicalLabel})\n`,
  );
}
