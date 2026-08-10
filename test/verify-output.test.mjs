import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-auditor-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");
  await mkdir(path.join(outputDir, "images"), { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest)}\n`),
    writeFile(path.join(outputDir, "transcript.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nWhisper first\n"),
    writeFile(path.join(outputDir, "styles.css"), "body { color: black; }\n"),
    writeFile(path.join(outputDir, "index.html"), pageHtml(references)),
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

  assertAuditFails(audit(outputDir), /reference escapes output|contained image path/i);
});

test("allows logical duplicate references while comparing unique physical paths", async (t) => {
  const outputDir = await createOutput(t, {
    references: Array(4).fill("images/000000500-primary.jpg"),
  });

  const result = audit(outputDir);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /4 logical references, 1 physical JPEG/);
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
