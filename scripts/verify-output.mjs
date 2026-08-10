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
const frameKeys = [
  "associations",
  "filename",
  "height",
  "reasons",
  "requestedMs",
  "timestampMs",
  "width",
];
const associationKeys = ["reasons", "requestedMs", "segmentIndex"];
const segmentKeys = ["endMs", "startMs", "text"];
const reasonPriority = new Map([
  ["primary", 0],
  ["scene", 1],
  ["caption", 2],
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actualKeys = Object.keys(value).sort();
  return sameSortedValues(actualKeys, [...expectedKeys].sort());
}

function compareReasons(left, right) {
  return reasonPriority.get(left) - reasonPriority.get(right)
    || left.localeCompare(right);
}

function compareReasonArrays(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function compareAssociations(left, right) {
  return left.segmentIndex - right.segmentIndex
    || left.requestedMs - right.requestedMs
    || compareReasonArrays(left.reasons, right.reasons);
}

function validateReasons(reasons, description) {
  assert.ok(
    Array.isArray(reasons)
      && reasons.length > 0
      && reasons.every((reason) => typeof reason === "string" && reasonPriority.has(reason))
      && new Set(reasons).size === reasons.length,
    `${description} must contain unique known reasons`,
  );
  const canonical = [...reasons].sort(compareReasons);
  assert.deepEqual(reasons, canonical, `${description} must use canonical reason order`);
  return canonical;
}

function validateSegments(segments) {
  assert.ok(Array.isArray(segments) && segments.length > 0, "Transcript segments must be a nonempty array");
  for (const [index, segment] of segments.entries()) {
    assert.ok(hasExactKeys(segment, segmentKeys), `Transcript segment ${index} has an invalid shape`);
    assert.ok(
      Number.isSafeInteger(segment.startMs)
        && segment.startMs >= 0
        && Number.isSafeInteger(segment.endMs)
        && segment.endMs > segment.startMs
        && typeof segment.text === "string",
      `Transcript segment ${index} has invalid bounds or text`,
    );
  }
}

function assertSafeImageFilename(filename) {
  assert.ok(
    typeof filename === "string"
      && filename.length > 0
      && filename !== "."
      && filename !== ".."
      && filename === path.basename(filename)
      && !filename.includes("/")
      && !filename.includes("\\")
      && filename.toLowerCase().endsWith(".jpg"),
    `Manifest image filename must be a safe JPEG basename: ${filename}`,
  );
}

function validateManifestImages(images, segmentCount) {
  assert.ok(Array.isArray(images), "Manifest images must be an array");
  const filenames = [];
  const filenameSet = new Set();
  for (const [imageIndex, image] of images.entries()) {
    assert.ok(hasExactKeys(image, frameKeys), `Frame record ${imageIndex} has an invalid shape`);
    assert.ok(
      Number.isSafeInteger(image.requestedMs) && image.requestedMs >= 0
        && Number.isSafeInteger(image.timestampMs) && image.timestampMs >= 0
        && Number.isSafeInteger(image.width) && image.width > 0
        && Number.isSafeInteger(image.height) && image.height > 0,
      `Frame record ${imageIndex} has invalid timestamps or dimensions`,
    );
    assertSafeImageFilename(image.filename);
    const frameReasons = validateReasons(image.reasons, `Frame record ${imageIndex} reasons`);
    assert.ok(
      Array.isArray(image.associations) && image.associations.length > 0,
      `Frame record ${imageIndex} must include associations`,
    );

    const associatedSegments = new Set();
    const associations = image.associations.map((association, associationIndex) => {
      assert.ok(
        hasExactKeys(association, associationKeys),
        `Frame association ${imageIndex}:${associationIndex} has an invalid shape`,
      );
      assert.ok(
        Number.isSafeInteger(association.segmentIndex)
          && association.segmentIndex >= 0
          && association.segmentIndex < segmentCount
          && Number.isSafeInteger(association.requestedMs)
          && association.requestedMs >= 0,
        `Frame association ${imageIndex}:${associationIndex} has invalid bounds`,
      );
      assert.ok(
        !associatedSegments.has(association.segmentIndex),
        `Frame ${imageIndex} associations must contain each segment only once`,
      );
      associatedSegments.add(association.segmentIndex);
      return {
        segmentIndex: association.segmentIndex,
        requestedMs: association.requestedMs,
        reasons: validateReasons(
          association.reasons,
          `Frame association ${imageIndex}:${associationIndex} reasons`,
        ),
      };
    });

    assert.deepEqual(
      associations,
      [...associations].sort(compareAssociations),
      `Frame ${imageIndex} associations must use canonical order`,
    );
    const associationReasonUnion = [...new Set(
      associations.flatMap((association) => association.reasons),
    )].sort(compareReasons);
    assert.deepEqual(
      frameReasons,
      associationReasonUnion,
      `Frame ${imageIndex} reasons must exactly match the association reason union`,
    );
    assert.ok(
      !filenameSet.has(image.filename),
      `Duplicate manifest image filename: ${image.filename}`,
    );
    filenameSet.add(image.filename);
    filenames.push(image.filename);
  }
  return filenames;
}

function tokenizeImageAttributes(tag, imageIndex) {
  const attributes = [];
  const end = tag.length - 1;
  let cursor = 4;

  while (cursor < end) {
    const separatorStart = cursor;
    while (cursor < end && /\s/u.test(tag[cursor])) cursor += 1;
    if (cursor >= end) break;
    if (tag[cursor] === "/" && cursor === end - 1) {
      cursor += 1;
      break;
    }
    assert.ok(
      cursor > separatorStart,
      `HTML img ${imageIndex} has malformed attribute separation`,
    );

    const nameMatch = /^[A-Za-z_:][A-Za-z0-9_.:-]*/u.exec(tag.slice(cursor, end));
    assert.ok(nameMatch, `HTML img ${imageIndex} has malformed attribute syntax`);
    const name = nameMatch[0].toLowerCase();
    cursor += nameMatch[0].length;

    const afterName = cursor;
    while (cursor < end && /\s/u.test(tag[cursor])) cursor += 1;
    if (tag[cursor] !== "=") {
      attributes.push({ name, hasValue: false, quoted: false, value: null });
      cursor = afterName;
      continue;
    }

    cursor += 1;
    while (cursor < end && /\s/u.test(tag[cursor])) cursor += 1;
    assert.ok(cursor < end, `HTML img ${imageIndex} attribute ${name} has no value`);
    const quote = tag[cursor];
    if (quote === "\"" || quote === "'") {
      cursor += 1;
      const valueStart = cursor;
      while (cursor < end && tag[cursor] !== quote) cursor += 1;
      assert.ok(
        cursor < end,
        `HTML img ${imageIndex} attribute ${name} has an unterminated quoted value`,
      );
      attributes.push({
        name,
        hasValue: true,
        quoted: true,
        value: tag.slice(valueStart, cursor),
      });
      cursor += 1;
      continue;
    }

    const valueStart = cursor;
    while (cursor < end && !/\s/u.test(tag[cursor])) cursor += 1;
    const value = tag.slice(valueStart, cursor);
    assert.ok(
      value.length > 0 && !/["'`=<>]/u.test(value),
      `HTML img ${imageIndex} attribute ${name} has a malformed unquoted value`,
    );
    attributes.push({ name, hasValue: true, quoted: false, value });
  }

  assert.equal(cursor, end, `HTML img ${imageIndex} has malformed trailing syntax`);
  return attributes;
}

function parseImageReferences(html) {
  const tags = [...html.matchAll(/<img\b[^>]*>/giu)].map((match) => match[0]);
  return tags.map((tag, index) => {
    const attributes = tokenizeImageAttributes(tag, index);
    const sources = attributes.filter((attribute) => attribute.name === "src");
    assert.equal(
      sources.length,
      1,
      `HTML img ${index} must contain exactly one src attribute`,
    );
    assert.ok(
      sources[0].hasValue && sources[0].quoted,
      `HTML img ${index} src attribute must have exactly one quoted value`,
    );
    const rawReference = sources[0].value;
    assert.ok(!rawReference.includes("&"), `HTML img ${index} src must not contain an HTML entity`);
    assert.ok(
      !rawReference.includes("?") && !rawReference.includes("#"),
      `HTML img ${index} src must not contain a raw query or fragment`,
    );
    assert.ok(
      rawReference.startsWith("images/"),
      `HTML img ${index} src must be a relative images path`,
    );

    let decodedReference;
    try {
      decodedReference = decodeURIComponent(rawReference);
    } catch (error) {
      throw new URIError(`HTML img ${index} src has malformed percent encoding`, { cause: error });
    }
    const decodedParts = decodedReference.split("/");
    assert.ok(
      decodedParts.length === 2
        && decodedParts[0] === "images"
        && decodedParts[1].length > 0
        && decodedParts[1] !== "."
        && decodedParts[1] !== ".."
        && !decodedParts[1].includes("\\"),
      `HTML img ${index} decoded src is not exactly one contained image path: ${decodedReference}`,
    );
    assertSafeImageFilename(decodedParts[1]);
    return decodedReference;
  });
}

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
  validateSegments(manifest.segments);
  const manifestFilenames = validateManifestImages(
    manifest.images,
    manifest.segments.length,
  );

  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    assert.ok(
      manifest.images.some((image) => image.associations?.some((association) =>
        association.segmentIndex === segmentIndex
          && association.reasons?.includes("primary"))),
      `segment ${segmentIndex} has no primary screenshot association`,
    );
  }

  const physicalFilenames = await inspectInventory(outputDir);
  const expectedPhysicalFilenames = [...manifestFilenames].sort();
  assert.ok(
    sameSortedValues(physicalFilenames, expectedPhysicalFilenames),
    `Physical JPEG inventory does not match manifest: actual=${physicalFilenames.join(",")} expected=${expectedPhysicalFilenames.join(",")}`,
  );

  const references = parseImageReferences(html);
  for (const reference of references) {
    const referencedPath = path.resolve(outputDir, reference);
    assert.ok(
      containedPath(outputDir, referencedPath),
      `HTML image reference escapes output: ${reference}`,
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
