import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const auditorPath = path.join(repositoryRoot, "scripts", "verify-output.mjs");

function sharedFrameManifest() {
  return {
    schemaVersion: 1,
    status: "complete",
    transcript: { engine: "mlx-whisper", filename: "transcript.vtt" },
    segments: [
      { startMs: 0, endMs: 1_000, text: "Whisper first" },
      { startMs: 1_000, endMs: 2_000, text: "Whisper second" },
    ],
    images: [{
      requestedMs: 500,
      timestampMs: 500,
      reasons: ["primary"],
      associations: [
        { segmentIndex: 0, requestedMs: 500, reasons: ["primary"] },
        { segmentIndex: 1, requestedMs: 1_500, reasons: ["primary"] },
      ],
      filename: "000000500-primary.jpg",
      width: 320,
      height: 180,
    }],
  };
}

function pageHtml(references = [
  "images/000000500-primary.jpg",
  "images/000000500-primary.jpg",
]) {
  return `<!doctype html><html><body>${references
    .map((reference) => `<img src="${reference}">`)
    .join("")}</body></html>\n`;
}

async function createOutput(t, {
  manifest = sharedFrameManifest(),
  references,
  imageFiles = { "000000500-primary.jpg": "jpeg-bytes" },
  extraFiles = {},
  transcriptText = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nWhisper first\n",
  stylesheetText = "body { color: black; }\n",
  html = pageHtml(references),
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-auditor-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");
  await mkdir(path.join(outputDir, "images"), { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest)}\n`),
    writeFile(path.join(outputDir, "transcript.vtt"), transcriptText),
    writeFile(path.join(outputDir, "styles.css"), stylesheetText),
    writeFile(path.join(outputDir, "index.html"), html),
  ]);
  for (const [filename, contents] of Object.entries(imageFiles)) {
    await writeFile(path.join(outputDir, "images", filename), contents);
  }
  for (const [relativePath, contents] of Object.entries(extraFiles)) {
    const destination = path.join(outputDir, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  return outputDir;
}

function manifestWithFilename(filename) {
  const manifest = sharedFrameManifest();
  manifest.images[0].filename = filename;
  return manifest;
}

function audit(...outputDirs) {
  return spawnSync(process.execPath, [auditorPath, ...outputDirs], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function assertAuditFails(result, messagePattern) {
  assert.notEqual(result.status, 0, `auditor unexpectedly passed:\n${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, messagePattern);
}

test("accepts association-aware primary coverage and shared physical frames", async (t) => {
  const first = await createOutput(t);
  const second = await createOutput(t);

  const result = audit(first, second);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /output: PASS \(2 logical references, 1 physical JPEG\)/);
  assert.equal(result.stdout.match(/: PASS/g)?.length, 2);
});

test("rejects a segment without a primary association", async (t) => {
  const manifest = sharedFrameManifest();
  manifest.images[0].associations[1].reasons = ["caption"];
  manifest.images[0].reasons = ["primary", "caption"];
  const outputDir = await createOutput(t, { manifest });

  assertAuditFails(audit(outputDir), /segment 1 has no primary screenshot/i);
});

for (const invalidFrame of [
  {
    name: "legacy top-level segmentIndex",
    mutate: (image) => { image.segmentIndex = 0; },
  },
  {
    name: "missing requestedMs",
    mutate: (image) => { delete image.requestedMs; },
  },
  {
    name: "an extra durable key",
    mutate: (image) => { image.extra = true; },
  },
  {
    name: "a fractional requestedMs",
    mutate: (image) => { image.requestedMs = 0.5; },
  },
  {
    name: "a negative timestampMs",
    mutate: (image) => { image.timestampMs = -1; },
  },
  {
    name: "a fractional timestampMs",
    mutate: (image) => { image.timestampMs = 499.5; },
  },
  {
    name: "a fractional width",
    mutate: (image) => { image.width = 319.5; },
  },
  {
    name: "a zero width",
    mutate: (image) => { image.width = 0; },
  },
  {
    name: "a negative height",
    mutate: (image) => { image.height = -1; },
  },
]) {
  test(`rejects a physical frame record with ${invalidFrame.name}`, async (t) => {
    const manifest = sharedFrameManifest();
    invalidFrame.mutate(manifest.images[0]);
    const outputDir = await createOutput(t, { manifest });

    assertAuditFails(audit(outputDir), /frame|image|dimension|timestamp|shape/i);
  });
}

for (const invalidAssociation of [
  {
    name: "a missing requestedMs",
    mutate: (image) => { delete image.associations[0].requestedMs; },
  },
  {
    name: "an extra key",
    mutate: (image) => { image.associations[0].extra = true; },
  },
  {
    name: "a fractional requestedMs",
    mutate: (image) => { image.associations[0].requestedMs = 0.5; },
  },
  {
    name: "a negative requestedMs",
    mutate: (image) => { image.associations[0].requestedMs = -1; },
  },
  {
    name: "an out-of-range segment index",
    mutate: (image) => {
      image.associations.push({ segmentIndex: 2, requestedMs: 1_900, reasons: ["scene"] });
      image.reasons = ["primary", "scene"];
    },
  },
  {
    name: "a duplicate segment association",
    mutate: (image) => {
      image.associations.push({ segmentIndex: 0, requestedMs: 750, reasons: ["scene"] });
      image.reasons = ["primary", "scene"];
    },
  },
  {
    name: "a malformed extra association",
    mutate: (image) => {
      image.associations.push({ segmentIndex: "bad", requestedMs: 750, reasons: ["scene"] });
      image.reasons = ["primary", "scene"];
    },
  },
  {
    name: "an empty association array",
    mutate: (image) => { image.associations = []; },
  },
  {
    name: "noncanonical association order",
    mutate: (image) => { image.associations.reverse(); },
  },
]) {
  test(`rejects ${invalidAssociation.name}`, async (t) => {
    const manifest = sharedFrameManifest();
    invalidAssociation.mutate(manifest.images[0]);
    const outputDir = await createOutput(t, { manifest });

    assertAuditFails(audit(outputDir), /association|frame|segment/i);
  });
}

for (const invalidReasons of [
  {
    name: "non-array frame reasons",
    mutate: (image) => { image.reasons = "primary"; },
  },
  {
    name: "empty frame reasons",
    mutate: (image) => { image.reasons = []; },
  },
  {
    name: "duplicate frame reasons",
    mutate: (image) => { image.reasons = ["primary", "primary"]; },
  },
  {
    name: "unknown frame reasons",
    mutate: (image) => { image.reasons = ["primary", "legacy"]; },
  },
  {
    name: "a frame reason union mismatch",
    mutate: (image) => { image.reasons = ["primary", "scene"]; },
  },
  {
    name: "non-array association reasons",
    mutate: (image) => { image.associations[0].reasons = "primary"; },
  },
  {
    name: "empty association reasons",
    mutate: (image) => { image.associations[0].reasons = []; },
  },
  {
    name: "duplicate association reasons",
    mutate: (image) => { image.associations[0].reasons = ["primary", "primary"]; },
  },
  {
    name: "unknown association reasons",
    mutate: (image) => { image.associations[0].reasons = ["primary", "legacy"]; },
  },
  {
    name: "noncanonical reason order",
    mutate: (image) => {
      image.reasons = ["caption", "primary"];
      image.associations[0].reasons = ["caption", "primary"];
    },
  },
]) {
  test(`rejects ${invalidReasons.name}`, async (t) => {
    const manifest = sharedFrameManifest();
    invalidReasons.mutate(manifest.images[0]);
    const outputDir = await createOutput(t, { manifest });

    assertAuditFails(audit(outputDir), /reason|frame|association/i);
  });
}

for (const invalidSegment of [
  {
    name: "a missing text key",
    mutate: (segment) => { delete segment.text; },
  },
  {
    name: "an extra key",
    mutate: (segment) => { segment.extra = true; },
  },
  {
    name: "a fractional start",
    mutate: (segment) => { segment.startMs = 0.5; },
  },
  {
    name: "a nonpositive duration",
    mutate: (segment) => { segment.endMs = segment.startMs; },
  },
  {
    name: "non-string text",
    mutate: (segment) => { segment.text = 42; },
  },
]) {
  test(`rejects a transcript segment with ${invalidSegment.name}`, async (t) => {
    const manifest = sharedFrameManifest();
    invalidSegment.mutate(manifest.segments[0]);
    const outputDir = await createOutput(t, { manifest });

    assertAuditFails(audit(outputDir), /segment|transcript/i);
  });
}

test("rejects a missing physical JPEG", async (t) => {
  const outputDir = await createOutput(t, { imageFiles: {} });

  assertAuditFails(audit(outputDir), /physical JPEG inventory/i);
});

test("rejects an extra physical JPEG", async (t) => {
  const outputDir = await createOutput(t, {
    imageFiles: {
      "000000500-primary.jpg": "jpeg-bytes",
      "unexpected.jpg": "jpeg-bytes",
    },
  });

  assertAuditFails(audit(outputDir), /physical JPEG inventory/i);
});

test("rejects duplicate manifest filenames", async (t) => {
  const manifest = sharedFrameManifest();
  manifest.images.push({
    ...structuredClone(manifest.images[0]),
    associations: [{ segmentIndex: 0, requestedMs: 750, reasons: ["scene"] }],
    reasons: ["scene"],
  });
  const outputDir = await createOutput(t, { manifest });

  assertAuditFails(audit(outputDir), /duplicate manifest image filename/i);
});

test("rejects a manifest filename that escapes the images directory", async (t) => {
  const manifest = sharedFrameManifest();
  manifest.images[0].filename = "../escaped.jpg";
  const outputDir = await createOutput(t, { manifest });

  assertAuditFails(audit(outputDir), /safe (?:JPEG )?basename|escapes/i);
});

test("rejects every HTML image reference that escapes the output", async (t) => {
  const outputDir = await createOutput(t, {
    references: [
      "images/000000500-primary.jpg",
      "images/000000500-primary.jpg",
      "../escaped.png",
    ],
  });

  assertAuditFails(
    audit(outputDir),
    /reference escapes output|contained image path|relative images path/i,
  );
});

test("accepts correctly encoded renderer filenames and logical duplicates", async (t) => {
  const filename = "frame name #100%?.jpg";
  const encodedReference = `images/${encodeURIComponent(filename)}`;
  const outputDir = await createOutput(t, {
    manifest: manifestWithFilename(filename),
    references: [encodedReference, encodedReference],
    imageFiles: { [filename]: "jpeg-bytes" },
  });

  const result = audit(outputDir);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 logical references, 1 physical JPEG/);
});

for (const invalidReference of [
  {
    name: "malformed percent encoding",
    filename: "bad%ZZ.jpg",
    reference: "images/bad%ZZ.jpg",
  },
  {
    name: "encoded traversal",
    filename: "%2e%2e%2Fescaped.jpg",
    reference: "images/%2e%2e%2Fescaped.jpg",
  },
  {
    name: "an encoded slash",
    filename: "nested%2Fframe.jpg",
    reference: "images/nested%2Fframe.jpg",
  },
  {
    name: "an encoded backslash",
    filename: "nested%5Cframe.jpg",
    reference: "images/nested%5Cframe.jpg",
  },
  {
    name: "a raw query",
    filename: "frame?query.jpg",
    reference: "images/frame?query.jpg",
  },
  {
    name: "a raw fragment",
    filename: "frame#fragment.jpg",
    reference: "images/frame#fragment.jpg",
  },
  {
    name: "an HTML entity",
    filename: "frame&amp;.jpg",
    reference: "images/frame&amp;.jpg",
  },
]) {
  test(`rejects ${invalidReference.name} in an HTML image source`, async (t) => {
    const outputDir = await createOutput(t, {
      manifest: manifestWithFilename(invalidReference.filename),
      references: [invalidReference.reference, invalidReference.reference],
      imageFiles: { [invalidReference.filename]: "jpeg-bytes" },
    });

    assertAuditFails(audit(outputDir), /encoding|reference|image path|query|fragment|entity/i);
  });
}

for (const malformedTag of [
  {
    name: "an unquoted source",
    tag: '<img src=../escaped.jpg>',
  },
  {
    name: "a missing source",
    tag: '<img alt="missing source">',
  },
  {
    name: "duplicate sources",
    tag: '<img src="images/000000500-primary.jpg" src="../escaped.jpg">',
  },
  {
    name: "an absolute source URL",
    tag: '<img src="https://example.com/escaped.jpg">',
  },
]) {
  test(`rejects an img tag with ${malformedTag.name}`, async (t) => {
    const html = pageHtml() + malformedTag.tag;
    const outputDir = await createOutput(t, { html });

    assertAuditFails(audit(outputDir), /img|src|source|quoted/i);
  });
}

test("allows logical duplicate references while comparing unique physical paths", async (t) => {
  const outputDir = await createOutput(t, {
    references: Array(4).fill("images/000000500-primary.jpg"),
  });

  const result = audit(outputDir);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /4 logical references, 1 physical JPEG/);
});

for (const emptyAsset of [
  { name: "HTML", options: { html: "" } },
  { name: "CSS", options: { stylesheetText: "" } },
  { name: "VTT", options: { transcriptText: "" } },
  { name: "JPEG", options: { imageFiles: { "000000500-primary.jpg": "" } } },
]) {
  test(`rejects an empty required ${emptyAsset.name}`, async (t) => {
    const outputDir = await createOutput(t, emptyAsset.options);

    assertAuditFails(audit(outputDir), /nonempty|inventory|reference/i);
  });
}

test("rejects a symlinked required page asset", async (t) => {
  const outputDir = await createOutput(t);
  await rm(path.join(outputDir, "styles.css"));
  await symlink("manifest.json", path.join(outputDir, "styles.css"));

  assertAuditFails(audit(outputDir), /regular file|symlink|styles/i);
});

test("rejects a symlinked physical JPEG", async (t) => {
  const outputDir = await createOutput(t);
  const imagePath = path.join(outputDir, "images", "000000500-primary.jpg");
  await rm(imagePath);
  await symlink("../transcript.vtt", imagePath);

  assertAuditFails(audit(outputDir), /forbidden output inventory|regular file|symlink/i);
});

for (const forbiddenPath of [
  "source.webm",
  "nested/audio.m4a",
  "download.part",
  "images/frame.stage-123.jpg",
  ".retention/owned-file",
]) {
  test(`rejects forbidden output inventory ${forbiddenPath}`, async (t) => {
    const outputDir = await createOutput(t, {
      extraFiles: { [forbiddenPath]: "forbidden" },
    });

    assertAuditFails(audit(outputDir), /forbidden output inventory/i);
  });
}
