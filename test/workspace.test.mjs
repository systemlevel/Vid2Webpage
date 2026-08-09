import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OutputConflictError } from "../src/errors.mjs";
import { openWorkspace, workspaceCacheDir } from "../src/workspace.mjs";

const source = {
  kind: "local",
  input: "clip.mp4",
  fingerprint: "fingerprint-a",
  title: "clip",
  durationMs: 10000,
  width: 640,
  height: 360,
};

function capture({
  filename = "000004000-primary.jpg",
  requestedMs = 4000,
  timestampMs = 4000,
  reasons = ["primary"],
  associations = [{ segmentIndex: 0, requestedMs: 4000, reasons: ["primary"] }],
} = {}) {
  return { filename, requestedMs, timestampMs, reasons, associations, width: 640, height: 360 };
}

async function createWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return openWorkspace({
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  });
}

test("creates cache, output, images, and an atomic building manifest", async (t) => {
  const workspace = await createWorkspace(t);
  const manifest = await workspace.loadManifest();

  assert.equal(workspace.cacheDir, workspaceCacheDir(path.dirname(workspace.cacheDir), source.fingerprint));
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    status: "building",
    source,
    transcript: null,
    segments: [],
    images: [],
    createdAt: manifest.createdAt,
    completedAt: null,
  });
  assert.match(manifest.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  await assert.doesNotReject(access(workspace.imagesDir));
});

test("resumes a matching manifest and rejects a different source without changing it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  };
  const first = await openWorkspace(options);
  const manifestBeforeConflict = await readFile(first.manifestPath, "utf8");

  assert.equal((await openWorkspace(options)).outputDir, first.outputDir);
  await assert.rejects(
    openWorkspace({
      ...options,
      fingerprint: "fingerprint-b",
      source: { ...source, fingerprint: "fingerprint-b" },
    }),
    OutputConflictError,
  );
  assert.equal(await readFile(first.manifestPath, "utf8"), manifestBeforeConflict);
});

test("rejects an inconsistent source fingerprint before creating output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-inconsistent-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");

  await assert.rejects(
    openWorkspace({
      cacheRoot: path.join(root, "cache"),
      fingerprint: source.fingerprint,
      outputDir,
      source: { ...source, fingerprint: "other-fingerprint" },
    }),
    OutputConflictError,
  );
  await assert.rejects(access(outputDir));
});

test("rejects a nonempty output without a v2w manifest and preserves its contents", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-foreign-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");
  const userFile = path.join(outputDir, "user-file.txt");
  await mkdir(outputDir);
  await writeFile(userFile, "keep");

  await assert.rejects(
    openWorkspace({
      cacheRoot: path.join(root, "cache"),
      fingerprint: source.fingerprint,
      outputDir,
      source,
    }),
    OutputConflictError,
  );
  assert.equal(await readFile(userFile, "utf8"), "keep");
});

test("rejects malformed and incompatible manifests without replacing them", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-invalid-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");
  const manifestPath = path.join(outputDir, "manifest.json");
  await mkdir(outputDir);
  await writeFile(manifestPath, "not json");

  await assert.rejects(
    openWorkspace({
      cacheRoot: path.join(root, "cache"),
      fingerprint: source.fingerprint,
      outputDir,
      source,
    }),
    OutputConflictError,
  );
  assert.equal(await readFile(manifestPath, "utf8"), "not json");

  const incompatible = JSON.stringify({ schemaVersion: 2, source, images: [] });
  await writeFile(manifestPath, incompatible);
  await assert.rejects(
    openWorkspace({
      cacheRoot: path.join(root, "cache"),
      fingerprint: source.fingerprint,
      outputDir,
      source,
    }),
    OutputConflictError,
  );
  assert.equal(await readFile(manifestPath, "utf8"), incompatible);
});

test("records association-aware physical frames by filename in timestamp order", async (t) => {
  const workspace = await createWorkspace(t);
  let manifest = await workspace.loadManifest();
  const later = capture({ filename: "000008000-scene.jpg", requestedMs: 7750, timestampMs: 8000, reasons: ["scene"], associations: [{ segmentIndex: 1, requestedMs: 7750, reasons: ["scene"] }] });
  const shared = capture({
    reasons: ["caption", "primary"],
    associations: [
      { segmentIndex: 1, requestedMs: 4100, reasons: ["primary"] },
      { segmentIndex: 0, requestedMs: 4000, reasons: ["caption", "primary"] },
    ],
  });
  const expectedShared = {
    ...shared,
    reasons: ["primary", "caption"],
    associations: [
      { segmentIndex: 0, requestedMs: 4000, reasons: ["primary", "caption"] },
      { segmentIndex: 1, requestedMs: 4100, reasons: ["primary"] },
    ],
    width: 1280,
    height: 720,
  };

  manifest = await workspace.recordFrame(manifest, later);
  manifest = await workspace.recordFrame(manifest, shared);
  manifest = await workspace.recordFrame(manifest, { ...shared, width: 1280, height: 720 });

  assert.deepEqual(manifest.images, [
    expectedShared,
    later,
  ]);
  assert.deepEqual(JSON.parse(await readFile(workspace.manifestPath, "utf8")).images, manifest.images);
  assert.equal("segmentIndex" in manifest.images[0], false);
});

test("reuses only a matching association-aware entry with a nonempty image", async (t) => {
  const workspace = await createWorkspace(t);
  let manifest = await workspace.loadManifest();
  const shared = capture({
    reasons: ["primary", "caption"],
    associations: [
      { segmentIndex: 0, requestedMs: 4000, reasons: ["primary", "caption"] },
      { segmentIndex: 1, requestedMs: 4100, reasons: ["primary"] },
    ],
  });
  manifest = await workspace.recordFrame(manifest, shared);
  assert.equal(await workspace.canReuseFrame(shared), false);
  await writeFile(path.join(workspace.imagesDir, shared.filename), "jpeg-bytes");

  assert.equal(await workspace.canReuseFrame(shared), true);
  assert.equal(await workspace.canReuseFrame({ ...shared, timestampMs: 4001 }), false);
  assert.equal(await workspace.canReuseFrame({ ...shared, reasons: ["caption", "primary"] }), false);
  assert.equal(await workspace.canReuseFrame({
    ...shared,
    associations: [...shared.associations].reverse(),
  }), false);
  await writeFile(path.join(workspace.imagesDir, shared.filename), "");
  assert.equal(await workspace.canReuseFrame(shared), false);
});

test("marks completion only when explicitly requested and persists it atomically", async (t) => {
  const workspace = await createWorkspace(t);
  let manifest = await workspace.loadManifest();
  manifest = await workspace.recordFrame(manifest, capture());
  assert.equal(JSON.parse(await readFile(workspace.manifestPath, "utf8")).status, "building");

  manifest = await workspace.markComplete(manifest);

  assert.equal(manifest.status, "complete");
  assert.match(manifest.completedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(JSON.parse(await readFile(workspace.manifestPath, "utf8")), manifest);
});

test("keeps completed workspaces readable and terminal across every mutation API", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-terminal-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  };
  const first = await openWorkspace(options);
  const building = await first.loadManifest();
  const complete = await first.markComplete(building);
  const completedBytes = await readFile(first.manifestPath, "utf8");
  const resumed = await openWorkspace(options);

  assert.deepEqual(await resumed.loadManifest(), complete);
  for (const mutate of [
    () => resumed.saveManifest(building),
    () => resumed.saveManifest(complete),
    () => resumed.recordFrame(building, capture()),
    () => resumed.recordFrame(complete, capture()),
    () => resumed.markComplete(building),
    () => resumed.markComplete(complete),
  ]) {
    await assert.rejects(mutate(), OutputConflictError);
    assert.equal(await readFile(resumed.manifestPath, "utf8"), completedBytes);
  }
});

test("rejects traversal and malformed physical frame records without persisting them", async (t) => {
  const workspace = await createWorkspace(t);
  const manifest = await workspace.loadManifest();
  const originalBytes = await readFile(workspace.manifestPath, "utf8");
  const invalidFrames = [
    capture({ filename: "../outside.jpg" }),
    capture({ filename: "/tmp/outside.jpg" }),
    { ...capture(), segmentIndex: 0 },
    (() => {
      const frame = capture();
      delete frame.height;
      return frame;
    })(),
    capture({ associations: [] }),
    { ...capture(), width: 0 },
  ];

  for (const frame of invalidFrames) {
    await assert.rejects(workspace.recordFrame(manifest, frame), OutputConflictError);
    assert.equal(await readFile(workspace.manifestPath, "utf8"), originalBytes);
  }
  await assert.rejects(
    workspace.canReuseFrame(capture({ filename: "nested/frame.jpg" })),
    OutputConflictError,
  );
});

test("rejects contradictory completed lifecycle state without replacing it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-contradictory-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir,
    source,
  };
  const workspace = await openWorkspace(options);
  const manifest = await workspace.loadManifest();
  const contradictory = JSON.stringify({ ...manifest, status: "complete", completedAt: null });
  await writeFile(workspace.manifestPath, contradictory);

  await assert.rejects(openWorkspace(options), OutputConflictError);
  assert.equal(await readFile(workspace.manifestPath, "utf8"), contradictory);
});
