import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OutputConflictError, SourceError } from "../src/errors.mjs";
import { extractFrames } from "../src/frames.mjs";
import {
  openWorkspace as openWorkspaceProduction,
  workspaceCacheDir,
} from "../src/workspace.mjs";

const source = {
  kind: "local",
  input: "clip.mp4",
  fingerprint: "fingerprint-a",
  title: "clip",
  durationMs: 10000,
  width: 640,
  height: 360,
};

const sourceSegments = [
  { startMs: 0, endMs: 5_000, text: "first" },
  { startMs: 5_000, endMs: 10_000, text: "second" },
];

async function openWorkspace({ seedSegments = true, ...options }) {
  const workspace = await openWorkspaceProduction(options);
  if (seedSegments) {
    const manifest = await workspace.loadManifest();
    if (manifest.status === "building" && manifest.segments.length === 0) {
      await workspace.saveManifest({ ...manifest, segments: sourceSegments });
    }
  }
  return workspace;
}

const manifestLockFilename = ".v2w-manifest.lock";
const deadOwnerPid = 2147483000;
const deadOwnerToken = "00000000-0000-4000-8000-000000000001";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function processError(code) {
  return Object.assign(new Error(`process probe failed with ${code}`), { code });
}

function ownerFilename(token) {
  return `owner-${token}.json`;
}

async function createOwnerLock(outputDir, {
  token = deadOwnerToken,
  pid = deadOwnerPid,
  acquiredAt = "2026-08-09T00:00:00.000Z",
} = {}) {
  const lockPath = path.join(outputDir, manifestLockFilename);
  const metadata = { token, pid, acquiredAt };
  const filename = ownerFilename(token);
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, filename), JSON.stringify(metadata));
  return { lockPath, ownerFilename: filename, metadata };
}

async function readOwnerLock(lockPath) {
  const entries = await readdir(lockPath);
  assert.equal(entries.length, 1);
  const [filename] = entries;
  return {
    ownerFilename: filename,
    metadata: JSON.parse(await readFile(path.join(lockPath, filename), "utf8")),
  };
}

function probeOnlyDeadOwner(pid, signal) {
  assert.equal(signal, 0);
  if (pid === deadOwnerPid) throw processError("ESRCH");
}

function capture({
  filename = "000004000-primary.jpg",
  requestedMs = 4000,
  timestampMs = 4000,
  reasons = ["primary"],
  associations = [{ segmentIndex: 0, requestedMs: 4000, reasons: ["primary"] }],
} = {}) {
  return { filename, requestedMs, timestampMs, reasons, associations, width: 640, height: 360 };
}

async function createWorkspace(t, {
  hooks = {},
  workspaceSource = source,
  seedSegments = true,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await openWorkspace({
    cacheRoot: path.join(root, "cache"),
    fingerprint: workspaceSource.fingerprint,
    outputDir: path.join(root, "output"),
    source: workspaceSource,
    hooks,
    seedSegments,
  });
  return workspace;
}

async function createRenderLeaseWorkspace(t, options) {
  const workspace = await createWorkspace(t, options);
  const manifest = await workspace.saveManifest({
    ...(await workspace.loadManifest()),
    transcript: { engine: "mlx-whisper", filename: "transcript.vtt" },
    segments: [{ startMs: 0, endMs: 8_000, text: "Whisper segment" }],
  });
  return { workspace, manifest };
}

async function preparedFrame(workspace, t, frame = capture()) {
  const token = randomUUID();
  const generationPath = path.join(workspace.imagesDir, `.v2w-frame-stage-${token}`);
  await mkdir(generationPath, { mode: 0o700 });
  const generationInfo = await lstat(generationPath);
  const ownerPath = path.join(generationPath, `owner-${token}`);
  await writeFile(ownerPath, token);
  const ownerInfo = await lstat(ownerPath);
  const tempPath = path.join(generationPath, frame.filename);
  await writeFile(tempPath, "prepared-jpeg");
  const info = await lstat(tempPath);
  const tempHandle = await open(tempPath, "r");
  t.after(async () => {
    await tempHandle.close();
  });
  const sourcePath = path.join(workspace.cacheDir, "source-video.mov");
  await writeFile(sourcePath, "source-video-bytes");
  const sourceInfo = await lstat(sourcePath);
  return {
    generationPath,
    generationIdentity: { dev: generationInfo.dev, ino: generationInfo.ino },
    ownerPath,
    ownerIdentity: { dev: ownerInfo.dev, ino: ownerInfo.ino },
    tempPath,
    tempIdentity: { dev: info.dev, ino: info.ino },
    tempFd: tempHandle.fd,
    tempHandle,
    sourcePath,
    sourceIdentity: { dev: sourceInfo.dev, ino: sourceInfo.ino },
    frame,
  };
}

async function cleanupPreparedGeneration(prepared) {
  await prepared.tempHandle?.close();
  try {
    await unlink(prepared.tempPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await unlink(prepared.ownerPath);
  await rmdir(prepared.generationPath);
}

function frameRunner(bytes, { width = 640, height = 360 } = {}) {
  return async (command, args) => {
    if (command === "ffmpeg") {
      await writeFile(args.at(-1), bytes);
      return { code: 0, stdout: "", stderr: "" };
    }
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ width, height }] }),
      stderr: "",
    };
  };
}

function identity(info) {
  return { dev: info.dev, ino: info.ino };
}

async function frameStageNames(imagesDir) {
  return (await readdir(imagesDir)).filter((entry) => entry.startsWith(".v2w-frame-stage-"));
}

async function assertProtectedPriorBackup(imagesDir, expectedBytes) {
  const [stageName, ...extraStages] = await frameStageNames(imagesDir);
  assert.ok(stageName);
  assert.deepEqual(extraStages, []);
  const stagePath = path.join(imagesDir, stageName);
  const token = stageName.slice(".v2w-frame-stage-".length);
  const entries = await readdir(stagePath);
  const ownerNames = entries.filter((entry) => entry === `owner-${token}`);
  const backupNames = entries.filter((entry) => entry === `previous-${token}`);
  assert.deepEqual(ownerNames, [`owner-${token}`]);
  assert.deepEqual(backupNames, [`previous-${token}`]);
  assert.equal(await readFile(path.join(stagePath, ownerNames[0]), "utf8"), token);
  assert.equal(await readFile(path.join(stagePath, backupNames[0]), "utf8"), expectedBytes);
  return { stagePath, token };
}

async function leaveProtectedPriorBackup({
  options,
  videoPath,
  manifest,
  planned,
  expectedBytes,
}) {
  const finalPath = path.join(options.outputDir, "images", planned.filename);
  const manifestFailure = new Error("injected frame manifest failure");
  const relinkFailure = Object.assign(new Error("injected rollback relink failure"), {
    code: "EIO",
  });
  let relinkFailed = false;
  const workspace = await openWorkspace({
    ...options,
    hooks: {
      beforeFrameManifestWrite() {
        throw manifestFailure;
      },
    },
    frameFileOps: {
      link(from, to) {
        if (!relinkFailed
          && to === finalPath
          && path.basename(from).startsWith("previous-")) {
          relinkFailed = true;
          throw relinkFailure;
        }
        linkSync(from, to);
      },
    },
  });
  const attempted = { ...planned, timestampMs: planned.timestampMs + 1 };
  await assert.rejects(extractFrames({
    videoPath,
    captures: [attempted],
    workspace,
    manifest,
    run: frameRunner("failed-new-jpeg"),
    log: { info() {} },
  }), SourceError);
  assert.equal(relinkFailed, true);
  assert.equal((await workspace.loadManifest()).revision, manifest.revision);
  await assert.rejects(access(finalPath));
  await assertProtectedPriorBackup(workspace.imagesDir, expectedBytes);
  return { attempted, finalPath };
}

test("creates cache, output, images, and an atomic building manifest", async (t) => {
  const workspace = await createWorkspace(t, { seedSegments: false });
  const manifest = await workspace.loadManifest();

  assert.equal(workspace.cacheDir, workspaceCacheDir(path.dirname(workspace.cacheDir), source.fingerprint));
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    status: "building",
    source,
    transcript: null,
    segments: [],
    images: [],
    revision: 0,
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
  await writeFile(path.join(workspace.imagesDir, capture().filename), "jpeg-bytes");

  manifest = await workspace.markComplete(manifest);

  assert.equal(manifest.status, "complete");
  assert.match(manifest.completedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(JSON.parse(await readFile(workspace.manifestPath, "utf8")), manifest);
});

test("completion requires an exact nonempty regular image inventory", async (t) => {
  const workspace = await createWorkspace(t);
  let manifest = await workspace.loadManifest();
  const frame = capture();
  manifest = await workspace.recordFrame(manifest, frame);
  const imagePath = path.join(workspace.imagesDir, frame.filename);

  await assert.rejects(workspace.markComplete(manifest), OutputConflictError);
  await writeFile(imagePath, "");
  await assert.rejects(workspace.markComplete(manifest), OutputConflictError);
  await writeFile(imagePath, "jpeg-bytes");
  const foreignPath = path.join(workspace.imagesDir, ".v2w-frame-backup-foreign.jpg");
  await writeFile(foreignPath, "foreign-backup");
  await assert.rejects(workspace.markComplete(manifest), OutputConflictError);
  assert.equal(await readFile(foreignPath, "utf8"), "foreign-backup");

  await unlink(foreignPath);
  const complete = await workspace.markComplete(manifest);
  assert.equal(complete.status, "complete");
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

test("rejects duplicate and out-of-range frame associations without persisting them", async (t) => {
  const workspace = await createWorkspace(t);
  let manifest = await workspace.loadManifest();
  manifest = await workspace.saveManifest({
    ...manifest,
    segments: [{ startMs: 0, endMs: 8_000, text: "Whisper segment" }],
  });
  const originalBytes = await readFile(workspace.manifestPath, "utf8");
  const invalidFrames = [
    capture({
      associations: [
        { segmentIndex: 0, requestedMs: 4_000, reasons: ["primary"] },
        { segmentIndex: 0, requestedMs: 4_001, reasons: ["primary"] },
      ],
    }),
    capture({ associations: [{ segmentIndex: 1, requestedMs: 4_000, reasons: ["primary"] }] }),
  ];

  for (const frame of invalidFrames) {
    await assert.rejects(workspace.recordFrame(manifest, frame), OutputConflictError);
    assert.equal(await readFile(workspace.manifestPath, "utf8"), originalBytes);
  }
});

test("durable manifest saves reject out-of-range associations", async (t) => {
  const { workspace, manifest } = await createRenderLeaseWorkspace(t);
  const originalBytes = await readFile(workspace.manifestPath, "utf8");
  await assert.rejects(
    workspace.saveManifest({
      ...manifest,
      images: [capture({
        associations: [{ segmentIndex: 1, requestedMs: 4_000, reasons: ["primary"] }],
      })],
    }),
    OutputConflictError,
  );
  assert.equal(await readFile(workspace.manifestPath, "utf8"), originalBytes);
});

test("durable manifests reject images when no transcript segments exist", async (t) => {
  const workspace = await createWorkspace(t, { seedSegments: false });
  const manifest = await workspace.loadManifest();
  const originalBytes = await readFile(workspace.manifestPath, "utf8");
  await assert.rejects(
    workspace.saveManifest({ ...manifest, images: [capture()] }),
    OutputConflictError,
  );
  assert.equal(await readFile(workspace.manifestPath, "utf8"), originalBytes);
});

test("render lease rejects escaped operations after its callback without writes", async (t) => {
  const { workspace, manifest } = await createRenderLeaseWorkspace(t);
  let escapedSave;
  await workspace.withRenderLease(manifest, (lease) => {
    escapedSave = lease.saveManifest;
  });
  const originalBytes = await readFile(workspace.manifestPath, "utf8");

  await assert.rejects(escapedSave(manifest), OutputConflictError);
  assert.equal(await readFile(workspace.manifestPath, "utf8"), originalBytes);
});

test("render lease closes synchronously before a queued escaped operation can start", async (t) => {
  const { workspace, manifest } = await createRenderLeaseWorkspace(t);
  let escapedSave;
  await workspace.withRenderLease(manifest, (lease) => {
    queueMicrotask(() => {
      escapedSave = lease.saveManifest(manifest);
      escapedSave.catch(() => {});
    });
  });
  const originalBytes = await readFile(workspace.manifestPath, "utf8");

  await assert.rejects(escapedSave, OutputConflictError);
  assert.equal(await readFile(workspace.manifestPath, "utf8"), originalBytes);
});

test("render lease serializes duplicate and out-of-order transitions", async (t) => {
  const { workspace, manifest } = await createRenderLeaseWorkspace(t);
  const complete = await workspace.withRenderLease(manifest, async (lease) => {
    await assert.rejects(lease.markComplete(manifest), OutputConflictError);
    const saved = await lease.saveManifest(manifest);
    const outcomes = await Promise.allSettled([
      lease.markComplete(saved),
      lease.markComplete(saved),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    return outcomes.find((outcome) => outcome.status === "fulfilled").value;
  });

  assert.equal(complete.status, "complete");
  assert.equal(complete.revision, manifest.revision + 2);
});

test("unawaited active lease failures reject the transaction without unhandled rejections", async (t) => {
  const enteredInventory = deferred();
  const releaseInventory = deferred();
  const failure = new Error("completion inventory failed");
  const { workspace, manifest } = await createRenderLeaseWorkspace(t, {
    hooks: {
      async beforeCompletionInventory() {
        enteredInventory.resolve();
        await releaseInventory.promise;
        throw failure;
      },
    },
  });
  const unhandled = [];
  const observeUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", observeUnhandled);
  try {
    const transaction = workspace.withRenderLease(manifest, async (lease) => {
      const saved = await lease.saveManifest(manifest);
      lease.markComplete(saved);
    });
    await enteredInventory.promise;
    releaseInventory.resolve();

    await assert.rejects(transaction, (error) => error === failure);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    const resumed = await workspace.loadManifest();
    await workspace.withRenderLease(resumed, () => undefined);
  } finally {
    process.off("unhandledRejection", observeUnhandled);
  }
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

test("serializes revisions and rejects stale save, record, and completion attempts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-stale-revision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  };
  const first = await openWorkspace(options);
  const second = await openWorkspace(options);
  const firstManifest = await first.loadManifest();
  const staleManifest = structuredClone(await second.loadManifest());

  assert.equal(firstManifest.revision, 1);
  const advanced = await first.recordFrame(firstManifest, capture());
  assert.equal(advanced.revision, 2);
  const advancedBytes = await readFile(first.manifestPath, "utf8");

  for (const mutate of [
    () => second.saveManifest(staleManifest),
    () => second.recordFrame(staleManifest, capture({ filename: "000005000-primary.jpg", requestedMs: 5000, timestampMs: 5000 })),
    () => second.markComplete(staleManifest),
  ]) {
    await assert.rejects(mutate(), OutputConflictError);
    assert.equal(await readFile(first.manifestPath, "utf8"), advancedBytes);
  }
});

test("concurrent output mutations leave exactly one terminal or building result", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-concurrent-revision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  };
  const first = await openWorkspace(options);
  const second = await openWorkspace(options);
  const firstManifest = await first.loadManifest();
  const secondManifest = structuredClone(await second.loadManifest());

  const results = await Promise.allSettled([
    first.recordFrame(firstManifest, capture()),
    second.markComplete(secondManifest),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.ok(results.some((result) => result.status === "rejected" && result.reason instanceof OutputConflictError));

  const manifest = await (await openWorkspace(options)).loadManifest();
  assert.equal(manifest.revision, 2);
  if (manifest.status === "complete") {
    assert.equal(manifest.images.length, 0);
  } else {
    assert.deepEqual(manifest.images.map((image) => image.filename), ["000004000-primary.jpg"]);
  }
});

test("completion inventory lease prevents a stale extractor from creating a stage after the scan starts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-completion-lease-first-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  await writeFile(videoPath, "source-video-bytes");
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const inventoryReached = deferred();
  const allowCompletion = deferred();
  const completing = await openWorkspace({
    ...options,
    hooks: {
      async beforeCompletionInventory() {
        inventoryReached.resolve();
        await allowCompletion.promise;
      },
    },
  });
  const extracting = await openWorkspace(options);
  const building = await completing.loadManifest();
  const stale = structuredClone(await extracting.loadManifest());
  const planned = capture();
  delete planned.width;
  delete planned.height;
  let runnerCalls = 0;

  const completion = completing.markComplete(building);
  await inventoryReached.promise;
  const extractionResult = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: extracting,
    manifest: stale,
    run: async () => {
      runnerCalls += 1;
      throw new Error("runner must not start after completion owns the lease");
    },
    log: { info() {} },
  }).then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  allowCompletion.resolve();
  const complete = await completion;
  assert.equal(extractionResult.status, "rejected");
  assert.equal(runnerCalls, 0);
  assert.deepEqual(await readdir(extracting.imagesDir), []);
  assert.equal(complete.status, "complete");
  await assert.rejects(extractFrames({
    videoPath,
    captures: [planned],
    workspace: extracting,
    manifest: stale,
    run: async () => {
      runnerCalls += 1;
      throw new Error("runner must not start after completion releases the lease");
    },
    log: { info() {} },
  }), OutputConflictError);
  assert.equal(runnerCalls, 0);
  assert.deepEqual(await readdir(extracting.imagesDir), []);
});

test("frame lease keeps completion inventory out until extraction and stage cleanup fully release", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-frame-lease-first-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  await writeFile(videoPath, "source-video-bytes");
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const extracting = await openWorkspace(options);
  let inventoryScans = 0;
  const completing = await openWorkspace({
    ...options,
    hooks: {
      beforeCompletionInventory() {
        inventoryScans += 1;
      },
    },
  });
  const frameManifest = await extracting.loadManifest();
  const staleCompletion = structuredClone(await completing.loadManifest());
  const planned = capture();
  delete planned.width;
  delete planned.height;
  const ffmpegReached = deferred();
  const allowFfmpeg = deferred();
  const extraction = extractFrames({
    videoPath,
    captures: [planned],
    workspace: extracting,
    manifest: frameManifest,
    run: async (command, args) => {
      if (command === "ffmpeg") {
        await writeFile(args.at(-1), "jpeg-bytes");
        ffmpegReached.resolve();
        await allowFfmpeg.promise;
        return { code: 0, stdout: "", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ streams: [{ width: 640, height: 360 }] }),
        stderr: "",
      };
    },
    log: { info() {} },
  });
  await ffmpegReached.promise;
  await assert.rejects(completing.markComplete(staleCompletion), OutputConflictError);
  const scansDuringFrameLease = inventoryScans;
  allowFfmpeg.resolve();
  const building = await extraction;
  assert.equal(scansDuringFrameLease, 0);
  assert.equal(building.revision, 2);
  assert.deepEqual(await readdir(extracting.imagesDir), [planned.filename]);
  const complete = await completing.markComplete(building);
  assert.equal(complete.status, "complete");
  assert.equal(inventoryScans, 1);
});

test("completion that acquires the lock first rejects a stale frame commit before JPEG rename", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-frame-complete-first-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  };
  const completing = await openWorkspace(options);
  const extracting = await openWorkspace(options);
  const completionManifest = await completing.loadManifest();
  const staleFrameManifest = structuredClone(await extracting.loadManifest());
  const complete = await completing.markComplete(completionManifest);
  const prepared = await preparedFrame(extracting, t);
  const finalPath = path.join(extracting.imagesDir, prepared.frame.filename);

  await assert.rejects(
    extracting.commitFrame(staleFrameManifest, prepared),
    OutputConflictError,
  );
  await assert.rejects(access(finalPath));
  assert.equal(await readFile(prepared.tempPath, "utf8"), "prepared-jpeg");
  assert.equal(complete.status, "complete");
  assert.deepEqual(complete.images, []);
  assert.deepEqual(await completing.loadManifest(), complete);
  await assert.rejects(access(finalPath));
});

test("frame commit that acquires the lock first makes concurrent stale completion reject", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-frame-commit-first-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  };
  const extracting = await openWorkspace(options);
  const completing = await openWorkspace(options);
  const frameManifest = await extracting.loadManifest();
  const staleCompletionManifest = structuredClone(await completing.loadManifest());
  const prepared = await preparedFrame(extracting, t);
  const finalPath = path.join(extracting.imagesDir, prepared.frame.filename);

  const building = await extracting.commitFrame(frameManifest, prepared);
  await cleanupPreparedGeneration(prepared);
  await assert.rejects(
    completing.markComplete(staleCompletionManifest),
    OutputConflictError,
  );
  assert.equal(building.status, "building");
  assert.equal(building.revision, 2);
  assert.equal(await readFile(finalPath, "utf8"), "prepared-jpeg");
  const complete = await completing.markComplete(building);
  assert.equal(complete.status, "complete");
  assert.deepEqual(complete.images, [prepared.frame]);
  assert.equal(await readFile(finalPath, "utf8"), "prepared-jpeg");
});

test("manifest publication failure after frame rename remains building and recoverable", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-frame-manifest-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const failure = new Error("injected manifest write failure");
  const videoPath = path.join(root, "source-video.mov");
  await writeFile(videoPath, "source-video-bytes");
  const localSource = { ...source, input: videoPath };
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: localSource,
  };
  const workspace = await openWorkspace({
    ...options,
    hooks: {
      beforeFrameManifestWrite() {
        throw failure;
      },
    },
  });
  const manifest = await workspace.loadManifest();
  const planned = capture();
  delete planned.width;
  delete planned.height;
  const finalPath = path.join(workspace.imagesDir, planned.filename);
  const run = async (command, args) => {
    if (command === "ffmpeg") {
      await writeFile(args.at(-1), "prepared-jpeg");
      return { code: 0, stdout: "", stderr: "" };
    }
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ width: 640, height: 360 }] }),
      stderr: "",
    };
  };

  await assert.rejects(
    extractFrames({
      videoPath,
      captures: [planned],
      workspace,
      manifest,
      run,
      log: { info() {} },
    }),
    (error) => error instanceof SourceError && error.cause === failure,
  );

  const persisted = await workspace.loadManifest();
  const persistedBytes = await readFile(workspace.manifestPath, "utf8");
  assert.equal(persisted.status, "building");
  assert.equal(persisted.revision, 1);
  assert.deepEqual(persisted.images, []);
  assert.equal(await readFile(finalPath, "utf8"), "prepared-jpeg");
  assert.deepEqual(await readdir(workspace.imagesDir), [planned.filename]);
  for (const candidate of [manifest, persisted]) {
    await assert.rejects(workspace.markComplete(candidate), OutputConflictError);
    assert.equal(await readFile(workspace.manifestPath, "utf8"), persistedBytes);
    assert.equal(await readFile(finalPath, "utf8"), "prepared-jpeg");
  }

  const resumed = await openWorkspace(options);
  const recovered = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: resumed,
    manifest: await resumed.loadManifest(),
    run: async (command, args) => {
      if (command === "ffmpeg") {
        await writeFile(args.at(-1), "recovered-jpeg");
        return { code: 0, stdout: "", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ streams: [{ width: 640, height: 360 }] }),
        stderr: "",
      };
    },
    log: { info() {} },
  });
  assert.equal(recovered.revision, 2);
  assert.equal(await readFile(finalPath, "utf8"), "recovered-jpeg");
  const complete = await resumed.markComplete(recovered);
  assert.equal(complete.status, "complete");
  assert.deepEqual(await readdir(resumed.imagesDir), [planned.filename]);
});

test("prior final is restored after no-overwrite publication failure and resumed extraction completes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-prior-final-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  await writeFile(videoPath, "source-video-bytes");
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const planned = capture();
  delete planned.width;
  delete planned.height;
  const runner = (bytes) => async (command, args) => {
    if (command === "ffmpeg") {
      await writeFile(args.at(-1), bytes);
      return { code: 0, stdout: "", stderr: "" };
    }
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ width: 640, height: 360 }] }),
      stderr: "",
    };
  };
  const firstWorkspace = await openWorkspace(options);
  const first = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: firstWorkspace,
    manifest: await firstWorkspace.loadManifest(),
    run: runner("prior-jpeg"),
    log: { info() {} },
  });
  const finalPath = path.join(firstWorkspace.imagesDir, planned.filename);
  assert.equal(await readFile(finalPath, "utf8"), "prior-jpeg");

  const publicationFailure = Object.assign(new Error("injected prepared publish failure"), {
    code: "EIO",
  });
  let failFinalPublication = true;
  const failingWorkspace = await openWorkspace({
    ...options,
    frameFileOps: {
      link(from, to) {
        if (to === finalPath && failFinalPublication) {
          failFinalPublication = false;
          throw publicationFailure;
        }
        linkSync(from, to);
      },
    },
  });
  const changed = { ...planned, timestampMs: planned.timestampMs + 1 };
  await assert.rejects(extractFrames({
    videoPath,
    captures: [changed],
    workspace: failingWorkspace,
    manifest: first,
    run: runner("failed-new-jpeg"),
    log: { info() {} },
  }), (error) => error instanceof SourceError && error.cause === publicationFailure);

  assert.equal((await failingWorkspace.loadManifest()).revision, 2);
  assert.equal(await readFile(finalPath, "utf8"), "prior-jpeg");
  await assertProtectedPriorBackup(failingWorkspace.imagesDir, "prior-jpeg");

  const resumed = await openWorkspace(options);
  const recovered = await extractFrames({
    videoPath,
    captures: [changed],
    workspace: resumed,
    manifest: await resumed.loadManifest(),
    run: runner("recovered-jpeg"),
    log: { info() {} },
  });
  assert.equal(recovered.revision, 3);
  assert.equal(await readFile(finalPath, "utf8"), "recovered-jpeg");
  assert.equal((await resumed.markComplete(recovered)).status, "complete");
});

test("prior backup survives a temp lstat failure after final unlink and real resume completes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-prior-temp-lstat-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  await writeFile(videoPath, "source-video-bytes");
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const planned = capture();
  delete planned.width;
  delete planned.height;
  const initialWorkspace = await openWorkspace(options);
  const initial = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: initialWorkspace,
    manifest: await initialWorkspace.loadManifest(),
    run: frameRunner("prior-jpeg"),
    log: { info() {} },
  });
  const finalPath = path.join(initialWorkspace.imagesDir, planned.filename);
  const lstatFailure = Object.assign(new Error("injected post-unlink temp lstat failure"), {
    code: "EIO",
  });
  let priorFinalUnlinked = false;
  let injected = false;
  const failingWorkspace = await openWorkspace({
    ...options,
    frameFileOps: {
      lstat(filePath) {
        if (priorFinalUnlinked
          && !injected
          && path.basename(filePath) === planned.filename
          && path.basename(path.dirname(filePath)).startsWith(".v2w-frame-stage-")) {
          injected = true;
          throw lstatFailure;
        }
        return lstatSync(filePath);
      },
      unlink(filePath) {
        unlinkSync(filePath);
        if (filePath === finalPath) priorFinalUnlinked = true;
      },
    },
  });
  const changed = { ...planned, timestampMs: planned.timestampMs + 1 };

  await assert.rejects(extractFrames({
    videoPath,
    captures: [changed],
    workspace: failingWorkspace,
    manifest: initial,
    run: frameRunner("failed-new-jpeg"),
    log: { info() {} },
  }), (error) => error instanceof SourceError && error.cause === lstatFailure);

  assert.equal(injected, true);
  assert.equal((await failingWorkspace.loadManifest()).revision, initial.revision);
  await assert.rejects(access(finalPath));
  await assertProtectedPriorBackup(failingWorkspace.imagesDir, "prior-jpeg");

  const resumed = await openWorkspace(options);
  const recovered = await extractFrames({
    videoPath,
    captures: [changed],
    workspace: resumed,
    manifest: await resumed.loadManifest(),
    run: async (command, args) => {
      if (command === "ffmpeg") {
        assert.equal(await readFile(finalPath, "utf8"), "prior-jpeg");
        await writeFile(args.at(-1), "recovered-jpeg");
        return { code: 0, stdout: "", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ streams: [{ width: 640, height: 360 }] }),
        stderr: "",
      };
    },
    log: { info() {} },
  });
  assert.equal(recovered.revision, initial.revision + 1);
  assert.equal(recovered.images[0].timestampMs, changed.timestampMs);
  assert.equal(await readFile(finalPath, "utf8"), "recovered-jpeg");
  assert.equal((await resumed.markComplete(recovered)).status, "complete");
  assert.deepEqual(await readdir(resumed.imagesDir), [planned.filename]);
});

test("rollback relink failure retains prior backup and real resume restores then completes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-prior-rollback-relink-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  await writeFile(videoPath, "source-video-bytes");
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const planned = capture();
  delete planned.width;
  delete planned.height;
  const initialWorkspace = await openWorkspace(options);
  const initial = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: initialWorkspace,
    manifest: await initialWorkspace.loadManifest(),
    run: frameRunner("prior-jpeg"),
    log: { info() {} },
  });
  const finalPath = path.join(initialWorkspace.imagesDir, planned.filename);
  const manifestFailure = new Error("injected frame manifest failure");
  const relinkFailure = Object.assign(new Error("injected rollback relink failure"), {
    code: "EIO",
  });
  let injected = false;
  const failingWorkspace = await openWorkspace({
    ...options,
    hooks: {
      beforeFrameManifestWrite() {
        throw manifestFailure;
      },
    },
    frameFileOps: {
      link(from, to) {
        if (!injected
          && to === finalPath
          && path.basename(from).startsWith("previous-")) {
          injected = true;
          throw relinkFailure;
        }
        linkSync(from, to);
      },
    },
  });
  const changed = { ...planned, timestampMs: planned.timestampMs + 1 };

  await assert.rejects(extractFrames({
    videoPath,
    captures: [changed],
    workspace: failingWorkspace,
    manifest: initial,
    run: frameRunner("failed-new-jpeg"),
    log: { info() {} },
  }), (error) => error instanceof SourceError
    && error.cause === manifestFailure
    && manifestFailure.cause === relinkFailure);

  assert.equal(injected, true);
  assert.equal((await failingWorkspace.loadManifest()).revision, initial.revision);
  await assert.rejects(access(finalPath));
  await assertProtectedPriorBackup(failingWorkspace.imagesDir, "prior-jpeg");

  const resumed = await openWorkspace(options);
  const recovered = await extractFrames({
    videoPath,
    captures: [changed],
    workspace: resumed,
    manifest: await resumed.loadManifest(),
    run: async (command, args) => {
      if (command === "ffmpeg") {
        assert.equal(await readFile(finalPath, "utf8"), "prior-jpeg");
        await writeFile(args.at(-1), "recovered-jpeg");
        return { code: 0, stdout: "", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ streams: [{ width: 640, height: 360 }] }),
        stderr: "",
      };
    },
    log: { info() {} },
  });
  assert.equal(recovered.revision, initial.revision + 1);
  assert.equal(recovered.images[0].timestampMs, changed.timestampMs);
  assert.equal(await readFile(finalPath, "utf8"), "recovered-jpeg");
  assert.equal((await resumed.markComplete(recovered)).status, "complete");
  assert.deepEqual(await readdir(resumed.imagesDir), [planned.filename]);
});

test("live rollback retains the prior backup when the restored final is replaced before cleanup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-live-rollback-final-replacement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  const foreignPath = path.join(root, "foreign-final.jpg");
  await writeFile(videoPath, "source-video-bytes");
  await writeFile(foreignPath, "foreign-final");
  const foreignIdentity = identity(await lstat(foreignPath));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const planned = capture();
  delete planned.width;
  delete planned.height;
  const initialWorkspace = await openWorkspace(options);
  const initial = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: initialWorkspace,
    manifest: await initialWorkspace.loadManifest(),
    run: frameRunner("prior-jpeg"),
    log: { info() {} },
  });
  const finalPath = path.join(initialWorkspace.imagesDir, planned.filename);
  const manifestFailure = new Error("injected frame manifest failure");
  const failingWorkspace = await openWorkspace({
    ...options,
    hooks: {
      beforeFrameManifestWrite() {
        throw manifestFailure;
      },
    },
  });
  const changed = { ...planned, timestampMs: planned.timestampMs + 1 };
  let replacedAfterRollback = false;

  await assert.rejects(extractFrames({
    videoPath,
    captures: [changed],
    workspace: failingWorkspace,
    manifest: initial,
    run: frameRunner("failed-new-jpeg"),
    log: { info() {} },
    fileOps: {
      async open(filePath, flags, mode) {
        const handle = await open(filePath, flags, mode);
        if (path.basename(filePath) !== planned.filename) return handle;
        return {
          get fd() {
            return handle.fd;
          },
          stat: (...args) => handle.stat(...args),
          async close() {
            if (!replacedAfterRollback) {
              replacedAfterRollback = true;
              unlinkSync(finalPath);
              linkSync(foreignPath, finalPath);
            }
            await handle.close();
          },
        };
      },
    },
  }), (error) => error instanceof SourceError && error.cause === manifestFailure);

  assert.equal(replacedAfterRollback, true);
  assert.equal((await failingWorkspace.loadManifest()).revision, initial.revision);
  assert.deepEqual(identity(await lstat(finalPath)), foreignIdentity);
  assert.equal(await readFile(finalPath, "utf8"), "foreign-final");
  await assertProtectedPriorBackup(failingWorkspace.imagesDir, "prior-jpeg");
});

test("restart recovery retains the prior backup when its verified final is replaced before cleanup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-recovery-final-replacement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  const foreignPath = path.join(root, "foreign-final.jpg");
  await writeFile(videoPath, "source-video-bytes");
  await writeFile(foreignPath, "foreign-final");
  const foreignIdentity = identity(await lstat(foreignPath));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const planned = capture();
  delete planned.width;
  delete planned.height;
  const initialWorkspace = await openWorkspace(options);
  const initial = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: initialWorkspace,
    manifest: await initialWorkspace.loadManifest(),
    run: frameRunner("prior-jpeg"),
    log: { info() {} },
  });
  const finalPath = path.join(initialWorkspace.imagesDir, planned.filename);
  const manifestFailure = new Error("injected frame manifest failure");
  const relinkFailure = Object.assign(new Error("injected rollback relink failure"), {
    code: "EIO",
  });
  let relinkFailed = false;
  const interruptedWorkspace = await openWorkspace({
    ...options,
    hooks: {
      beforeFrameManifestWrite() {
        throw manifestFailure;
      },
    },
    frameFileOps: {
      link(from, to) {
        if (!relinkFailed
          && to === finalPath
          && path.basename(from).startsWith("previous-")) {
          relinkFailed = true;
          throw relinkFailure;
        }
        linkSync(from, to);
      },
    },
  });
  const changed = { ...planned, timestampMs: planned.timestampMs + 1 };
  await assert.rejects(extractFrames({
    videoPath,
    captures: [changed],
    workspace: interruptedWorkspace,
    manifest: initial,
    run: frameRunner("failed-new-jpeg"),
    log: { info() {} },
  }), SourceError);
  assert.equal(relinkFailed, true);
  await assert.rejects(access(finalPath));
  await assertProtectedPriorBackup(interruptedWorkspace.imagesDir, "prior-jpeg");

  let restored = false;
  let replacedAfterVerification = false;
  const recoveryWorkspace = await openWorkspace({
    ...options,
    frameFileOps: {
      link(from, to) {
        linkSync(from, to);
        if (to === finalPath && path.basename(from).startsWith("previous-")) {
          restored = true;
        }
      },
      lstat(filePath) {
        const info = lstatSync(filePath);
        if (filePath === finalPath && restored && !replacedAfterVerification) {
          replacedAfterVerification = true;
          unlinkSync(finalPath);
          linkSync(foreignPath, finalPath);
        }
        return info;
      },
    },
  });
  const stopAfterRecovery = new Error("stop after recovery");
  await assert.rejects(extractFrames({
    videoPath,
    captures: [changed],
    workspace: recoveryWorkspace,
    manifest: await recoveryWorkspace.loadManifest(),
    run: async () => { throw stopAfterRecovery; },
    log: { info() {} },
  }), (error) => error instanceof SourceError && error.cause === stopAfterRecovery);

  assert.equal(replacedAfterVerification, true);
  assert.equal((await recoveryWorkspace.loadManifest()).revision, initial.revision);
  assert.deepEqual(identity(await lstat(finalPath)), foreignIdentity);
  assert.equal(await readFile(finalPath, "utf8"), "foreign-final");
  await assertProtectedPriorBackup(recoveryWorkspace.imagesDir, "prior-jpeg");

  let ffmpegCalls = 0;
  const resumed = await openWorkspace(options);
  const recovered = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: resumed,
    manifest: await resumed.loadManifest(),
    run: async (command, args) => {
      if (command === "ffmpeg") ffmpegCalls += 1;
      return frameRunner("republished-jpeg")(command, args);
    },
    log: { info() {} },
  });
  assert.equal(ffmpegCalls, 1);
  assert.equal(recovered.revision, initial.revision + 1);
  assert.equal(await readFile(finalPath, "utf8"), "republished-jpeg");
  assert.equal((await resumed.markComplete(recovered)).status, "complete");
  assert.deepEqual(await readdir(resumed.imagesDir), [planned.filename]);
});

test("an unrelated frame commit carries a protected frame forward until its own republish", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-protected-unrelated-revision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  await writeFile(videoPath, "source-video-bytes");
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const frameA = capture({
    filename: "000001000-primary.jpg",
    requestedMs: 1000,
    timestampMs: 1000,
    associations: [{ segmentIndex: 0, requestedMs: 1000, reasons: ["primary"] }],
  });
  const frameB = capture({
    filename: "000002000-primary.jpg",
    requestedMs: 2000,
    timestampMs: 2000,
    associations: [{ segmentIndex: 1, requestedMs: 2000, reasons: ["primary"] }],
  });
  delete frameA.width;
  delete frameA.height;
  delete frameB.width;
  delete frameB.height;
  const initialWorkspace = await openWorkspace(options);
  const initial = await extractFrames({
    videoPath,
    captures: [frameA, frameB],
    workspace: initialWorkspace,
    manifest: await initialWorkspace.loadManifest(),
    run: frameRunner("prior-jpeg"),
    log: { info() {} },
  });
  const { finalPath: finalAPath } = await leaveProtectedPriorBackup({
    options,
    videoPath,
    manifest: initial,
    planned: frameA,
    expectedBytes: "prior-jpeg",
  });

  const finalBPath = path.join(initialWorkspace.imagesDir, frameB.filename);
  const changedB = { ...frameB, timestampMs: frameB.timestampMs + 1 };
  const bWorkspace = await openWorkspace(options);
  const afterB = await extractFrames({
    videoPath,
    captures: [changedB],
    workspace: bWorkspace,
    manifest: await bWorkspace.loadManifest(),
    run: frameRunner("updated-b"),
    log: { info() {} },
  });
  assert.equal(afterB.revision, initial.revision + 1);
  assert.equal(await readFile(finalAPath, "utf8"), "prior-jpeg");
  assert.equal(await readFile(finalBPath, "utf8"), "updated-b");
  await assertProtectedPriorBackup(bWorkspace.imagesDir, "prior-jpeg");

  let aFfmpegCalls = 0;
  const aWorkspace = await openWorkspace(options);
  const afterA = await extractFrames({
    videoPath,
    captures: [frameA],
    workspace: aWorkspace,
    manifest: afterB,
    run: async (command, args) => {
      if (command === "ffmpeg") aFfmpegCalls += 1;
      return frameRunner("republished-a")(command, args);
    },
    log: { info() {} },
  });
  assert.equal(aFfmpegCalls, 1);
  assert.equal(afterA.revision, initial.revision + 2);
  assert.equal(await readFile(finalAPath, "utf8"), "republished-a");
  assert.equal(await readFile(finalBPath, "utf8"), "updated-b");
  assert.equal((await aWorkspace.markComplete(afterA)).status, "complete");
  assert.deepEqual(
    (await readdir(aWorkspace.imagesDir)).sort(),
    [frameA.filename, frameB.filename].sort(),
  );
});

test("a changed protected frame manifest identity blocks stale recovery and preserves its backup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-protected-frame-identity-change-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  await writeFile(videoPath, "source-video-bytes");
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const planned = capture();
  delete planned.width;
  delete planned.height;
  const initialWorkspace = await openWorkspace(options);
  const initial = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: initialWorkspace,
    manifest: await initialWorkspace.loadManifest(),
    run: frameRunner("prior-jpeg"),
    log: { info() {} },
  });
  const { finalPath } = await leaveProtectedPriorBackup({
    options,
    videoPath,
    manifest: initial,
    planned,
    expectedBytes: "prior-jpeg",
  });

  const mutatingWorkspace = await openWorkspace(options);
  const beforeMutation = await mutatingWorkspace.loadManifest();
  const changedFrame = {
    ...beforeMutation.images[0],
    timestampMs: beforeMutation.images[0].timestampMs + 50,
  };
  const changedManifest = await mutatingWorkspace.saveManifest({
    ...beforeMutation,
    images: [changedFrame],
  });
  let runnerCalls = 0;
  let rejection;
  const recoveryWorkspace = await openWorkspace(options);
  try {
    await extractFrames({
      videoPath,
      captures: [planned],
      workspace: recoveryWorkspace,
      manifest: changedManifest,
      run: async (command, args) => {
        runnerCalls += 1;
        return frameRunner("must-not-run")(command, args);
      },
      log: { info() {} },
    });
  } catch (error) {
    rejection = error;
  }

  assert.ok(rejection instanceof OutputConflictError);
  assert.equal(runnerCalls, 0);
  assert.equal((await recoveryWorkspace.loadManifest()).revision, changedManifest.revision);
  assert.deepEqual((await recoveryWorkspace.loadManifest()).images, [changedFrame]);
  await assert.rejects(access(finalPath));
  await assertProtectedPriorBackup(recoveryWorkspace.imagesDir, "prior-jpeg");
});

test("post-manifest backup cleanup failure leaves a committed stage that resume recovers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-backup-cleanup-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  await writeFile(videoPath, "source-video-bytes");
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const planned = capture();
  delete planned.width;
  delete planned.height;
  const run = async (command, args) => {
    if (command === "ffmpeg") {
      await writeFile(args.at(-1), "jpeg-bytes");
      return { code: 0, stdout: "", stderr: "" };
    }
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ width: 640, height: 360 }] }),
      stderr: "",
    };
  };
  const firstWorkspace = await openWorkspace(options);
  const first = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: firstWorkspace,
    manifest: await firstWorkspace.loadManifest(),
    run,
    log: { info() {} },
  });
  const cleanupFailure = new Error("injected backup unlink failure");
  let cleanupAttempts = 0;
  const replacingWorkspace = await openWorkspace({
    ...options,
    frameFileOps: {
      unlink(filePath) {
        if (!path.basename(filePath).startsWith("previous-")) {
          unlinkSync(filePath);
          return;
        }
        cleanupAttempts += 1;
        throw cleanupFailure;
      },
    },
  });
  const changed = { ...planned, timestampMs: planned.timestampMs + 1 };
  await assert.rejects(extractFrames({
    videoPath,
    captures: [changed],
    workspace: replacingWorkspace,
    manifest: first,
    run,
    log: { info() {} },
  }), SourceError);

  assert.equal(cleanupAttempts, 1);
  const replaced = await replacingWorkspace.loadManifest();
  assert.equal(replaced.revision, 3);
  assert.equal((await frameStageNames(replacingWorkspace.imagesDir)).length, 1);

  const resumed = await openWorkspace(options);
  const recovered = await extractFrames({
    videoPath,
    captures: [changed],
    workspace: resumed,
    manifest: replaced,
    run: async () => { throw new Error("committed replacement must be reused"); },
    log: { info() {} },
  });
  assert.deepEqual(await readdir(resumed.imagesDir), [planned.filename]);
  assert.equal((await resumed.markComplete(recovered)).status, "complete");
});

test("a recovered frame lease scavenges a token-proven abandoned private generation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-abandoned-frame-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  await writeFile(videoPath, "source-video-bytes");
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const workspace = await openWorkspace(options);
  const token = "00000000-0000-4000-8000-000000000099";
  const abandoned = path.join(workspace.imagesDir, `.v2w-frame-stage-${token}`);
  await mkdir(abandoned, { mode: 0o700 });
  await writeFile(path.join(abandoned, `owner-${token}`), token);
  await writeFile(path.join(abandoned, "abandoned.jpg"), "partial-jpeg");
  const planned = capture();
  delete planned.width;
  delete planned.height;

  const building = await extractFrames({
    videoPath,
    captures: [planned],
    workspace,
    manifest: await workspace.loadManifest(),
    run: async (command, args) => {
      if (command === "ffmpeg") {
        await writeFile(args.at(-1), "recovered-jpeg");
        return { code: 0, stdout: "", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ streams: [{ width: 640, height: 360 }] }),
        stderr: "",
      };
    },
    log: { info() {} },
  });

  assert.deepEqual(await readdir(workspace.imagesDir), [planned.filename]);
  assert.equal((await workspace.markComplete(building)).status, "complete");
});

test("commitFrame surfaces a real workspace no-overwrite publication failure without changing prior state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-frame-rename-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicationFailure = Object.assign(new Error("injected frame publication failure"), { code: "EIO" });
  let publicationCalls = 0;
  const workspace = await openWorkspace({
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
    frameFileOps: {
      link() {
        publicationCalls += 1;
        throw publicationFailure;
      },
    },
  });
  const manifest = await workspace.loadManifest();
  const manifestBytes = await readFile(workspace.manifestPath, "utf8");
  const prepared = await preparedFrame(workspace, t);
  const finalPath = path.join(workspace.imagesDir, prepared.frame.filename);

  await assert.rejects(
    workspace.commitFrame(manifest, prepared),
    (error) => error === publicationFailure,
  );

  assert.equal(publicationCalls, 1);
  assert.equal(await readFile(workspace.manifestPath, "utf8"), manifestBytes);
  assert.equal(await readFile(prepared.tempPath, "utf8"), "prepared-jpeg");
  await assert.rejects(access(finalPath));
});

test("atomic no-overwrite rejects a source alias introduced in the final publication window", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-frame-late-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let prepared;
  let injected = false;
  const workspace = await openWorkspace({
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
    frameFileOps: {
      link(from, to) {
        if (!injected && prepared && to.endsWith(prepared.frame.filename)) {
          injected = true;
          linkSync(prepared.sourcePath, to);
        }
        linkSync(from, to);
      },
    },
  });
  const manifest = await workspace.loadManifest();
  prepared = await preparedFrame(workspace, t);
  const finalPath = path.join(workspace.imagesDir, prepared.frame.filename);

  await assert.rejects(
    workspace.commitFrame(manifest, prepared),
    OutputConflictError,
  );

  assert.equal(injected, true);
  assert.equal(await readFile(prepared.sourcePath, "utf8"), "source-video-bytes");
  assert.equal(await readFile(finalPath, "utf8"), "source-video-bytes");
  assert.equal(await readFile(prepared.tempPath, "utf8"), "prepared-jpeg");
  assert.equal((await workspace.loadManifest()).revision, 1);
});

test("frame publication retains a caption hard link introduced after orchestration validation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-frame-protected-caption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await openWorkspace({
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  });
  const manifest = await workspace.loadManifest();
  const manifestBytes = await readFile(workspace.manifestPath, "utf8");
  const prepared = await preparedFrame(workspace, t);
  const captionPath = path.join(root, "lesson.vtt");
  const finalPath = path.join(workspace.imagesDir, prepared.frame.filename);
  await writeFile(captionPath, "protected-caption-bytes");
  const captionBefore = await lstat(captionPath);
  await link(captionPath, finalPath);
  prepared.protectedFiles = [{
    label: "caption",
    path: captionPath,
    canonicalPath: captionPath,
    identity: identity(captionBefore),
  }];

  await assert.rejects(
    workspace.commitFrame(manifest, prepared),
    OutputConflictError,
  );

  assert.equal(await readFile(captionPath, "utf8"), "protected-caption-bytes");
  assert.equal(await readFile(finalPath, "utf8"), "protected-caption-bytes");
  assert.deepEqual(identity(await lstat(captionPath)), identity(captionBefore));
  assert.deepEqual(identity(await lstat(finalPath)), identity(captionBefore));
  assert.equal(await readFile(workspace.manifestPath, "utf8"), manifestBytes);
});

test("protected frame publication atomically captures a final swapped at the former unlink boundary", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-frame-atomic-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planned = capture();
  const outputDir = path.join(root, "output");
  const finalPath = path.join(outputDir, "images", planned.filename);
  const captionPath = path.join(root, "lesson.vtt");
  let injected = false;
  const swapFinal = () => {
    if (injected) return;
    unlinkSync(finalPath);
    linkSync(captionPath, finalPath);
    injected = true;
  };
  const workspace = await openWorkspace({
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir,
    source,
    frameFileOps: {
      rename(from, to) {
        if (from === finalPath) swapFinal();
        renameSync(from, to);
      },
      unlink(filePath) {
        if (filePath === finalPath) swapFinal();
        unlinkSync(filePath);
      },
    },
  });
  const manifest = await workspace.loadManifest();
  const manifestBytes = await readFile(workspace.manifestPath, "utf8");
  const prepared = await preparedFrame(workspace, t, planned);
  await writeFile(finalPath, "prior-frame");
  await writeFile(captionPath, "protected-caption");
  const captionBefore = await lstat(captionPath);
  prepared.protectedFiles = [{
    label: "caption",
    path: captionPath,
    canonicalPath: captionPath,
    identity: identity(captionBefore),
  }];

  await assert.rejects(
    workspace.commitFrame(manifest, prepared),
    OutputConflictError,
  );

  assert.equal(injected, true);
  assert.equal(await readFile(captionPath, "utf8"), "protected-caption");
  assert.equal(await readFile(finalPath, "utf8"), "protected-caption");
  assert.deepEqual(identity(await lstat(captionPath)), identity(captionBefore));
  assert.deepEqual(identity(await lstat(finalPath)), identity(captionBefore));
  assert.equal(await readFile(workspace.manifestPath, "utf8"), manifestBytes);
});

test("publication rechecks the retained staged inode synchronously and a real resume cleans the owned residue", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-stage-publication-recheck-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  const foreignPath = path.join(root, "foreign-member.jpg");
  await writeFile(videoPath, "source-video-bytes");
  await writeFile(foreignPath, "foreign-member-bytes");
  const sourceIdentity = identity(await lstat(videoPath));
  const foreignIdentity = identity(await lstat(foreignPath));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  let replacementPath;
  let replaced = false;
  const workspace = await openWorkspace({
    ...options,
    frameFileOps: {
      lstat(filePath) {
        if (!replaced
          && path.extname(filePath) === ".jpg"
          && path.basename(path.dirname(filePath)).startsWith(".v2w-frame-stage-")) {
          replaced = true;
          replacementPath = filePath;
          unlinkSync(filePath);
          linkSync(foreignPath, filePath);
        }
        return lstatSync(filePath);
      },
    },
  });
  const planned = capture();
  delete planned.width;
  delete planned.height;

  await assert.rejects(extractFrames({
    videoPath,
    captures: [planned],
    workspace,
    manifest: await workspace.loadManifest(),
    run: frameRunner("unpublishable-jpeg"),
    log: { info() {} },
  }), SourceError);

  assert.equal(replaced, true);
  assert.deepEqual(identity(await lstat(replacementPath)), foreignIdentity);
  assert.equal(await readFile(replacementPath, "utf8"), "foreign-member-bytes");
  assert.deepEqual(identity(await lstat(videoPath)), sourceIdentity);
  assert.equal(await readFile(videoPath, "utf8"), "source-video-bytes");
  assert.equal((await workspace.loadManifest()).revision, 1);
  const [stageName] = await frameStageNames(workspace.imagesDir);
  const stagePath = path.join(workspace.imagesDir, stageName);
  const token = stageName.slice(".v2w-frame-stage-".length);
  assert.deepEqual((await readdir(stagePath)).sort(), [
    planned.filename,
    `owner-${token}`,
  ].sort());
  assert.equal(await readFile(path.join(stagePath, `owner-${token}`), "utf8"), token);

  const resumed = await openWorkspace(options);
  const recovered = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: resumed,
    manifest: await resumed.loadManifest(),
    run: frameRunner("recovered-jpeg"),
    log: { info() {} },
  });
  assert.equal(await readFile(path.join(resumed.imagesDir, planned.filename), "utf8"), "recovered-jpeg");
  assert.deepEqual(identity(await lstat(foreignPath)), foreignIdentity);
  assert.equal((await resumed.markComplete(recovered)).status, "complete");
  assert.deepEqual(await readdir(resumed.imagesDir), [planned.filename]);
});

test("a final replacement after backup capture survives the synchronous remove decision", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-final-remove-recheck-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  const foreignPath = path.join(root, "foreign-final.jpg");
  await writeFile(videoPath, "source-video-bytes");
  await writeFile(foreignPath, "foreign-final-bytes");
  const sourceIdentity = identity(await lstat(videoPath));
  const foreignIdentity = identity(await lstat(foreignPath));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const planned = capture();
  delete planned.width;
  delete planned.height;
  const initialWorkspace = await openWorkspace(options);
  const initial = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: initialWorkspace,
    manifest: await initialWorkspace.loadManifest(),
    run: frameRunner("prior-jpeg"),
    log: { info() {} },
  });
  const finalPath = path.join(initialWorkspace.imagesDir, planned.filename);
  let backupLinked = false;
  let replaced = false;
  const replacingWorkspace = await openWorkspace({
    ...options,
    frameFileOps: {
      link(from, to) {
        linkSync(from, to);
        if (path.basename(to).startsWith("previous-")) backupLinked = true;
      },
      lstat(filePath) {
        if (filePath === finalPath && backupLinked && !replaced) {
          replaced = true;
          unlinkSync(finalPath);
          linkSync(foreignPath, finalPath);
        }
        return lstatSync(filePath);
      },
    },
  });
  const changed = { ...planned, timestampMs: planned.timestampMs + 1 };

  await assert.rejects(extractFrames({
    videoPath,
    captures: [changed],
    workspace: replacingWorkspace,
    manifest: initial,
    run: frameRunner("must-not-publish"),
    log: { info() {} },
  }), SourceError);

  assert.equal(replaced, true);
  assert.deepEqual(identity(await lstat(finalPath)), foreignIdentity);
  assert.equal(await readFile(finalPath, "utf8"), "foreign-final-bytes");
  assert.deepEqual(identity(await lstat(foreignPath)), foreignIdentity);
  assert.deepEqual(identity(await lstat(videoPath)), sourceIdentity);
  assert.equal((await replacingWorkspace.loadManifest()).revision, initial.revision);
  for (const stageName of await frameStageNames(replacingWorkspace.imagesDir)) {
    const entries = await readdir(path.join(replacingWorkspace.imagesDir, stageName));
    assert.equal(entries.some((entry) => entry.startsWith("owner-")), true);
  }

  const resumed = await openWorkspace(options);
  const recovered = await extractFrames({
    videoPath,
    captures: [changed],
    workspace: resumed,
    manifest: await resumed.loadManifest(),
    run: frameRunner("recovered-jpeg"),
    log: { info() {} },
  });
  assert.equal(await readFile(finalPath, "utf8"), "recovered-jpeg");
  assert.deepEqual(identity(await lstat(foreignPath)), foreignIdentity);
  assert.equal((await resumed.markComplete(recovered)).status, "complete");
});

test("recovery preserves a replacement generation introduced between capture and cleanup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-recovery-generation-replacement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  };
  const initialWorkspace = await openWorkspace(options);
  const token = "00000000-0000-4000-8000-000000000201";
  const generationPath = path.join(initialWorkspace.imagesDir, `.v2w-frame-stage-${token}`);
  const movedGenerationPath = `${generationPath}-moved`;
  const ownerPath = path.join(generationPath, `owner-${token}`);
  const memberPath = path.join(generationPath, "abandoned.jpg");
  await mkdir(generationPath, { mode: 0o700 });
  await writeFile(ownerPath, token);
  await writeFile(memberPath, "owned-abandoned-member");
  const generationIdentity = identity(await lstat(generationPath));
  const memberIdentity = identity(await lstat(memberPath));
  let generationStats = 0;
  let foreignGenerationIdentity;
  let foreignMemberIdentity;
  const workspace = await openWorkspace({
    ...options,
    frameFileOps: {
      lstat(filePath) {
        if (filePath === generationPath) {
          generationStats += 1;
          if (generationStats === 2) {
            renameSync(generationPath, movedGenerationPath);
            mkdirSync(generationPath, { mode: 0o700 });
            writeFileSync(path.join(generationPath, `owner-${token}`), "foreign-owner");
            writeFileSync(path.join(generationPath, "foreign.txt"), "foreign-generation");
            foreignGenerationIdentity = identity(lstatSync(generationPath));
            foreignMemberIdentity = identity(lstatSync(path.join(generationPath, "foreign.txt")));
          }
        }
        return lstatSync(filePath);
      },
    },
  });
  let operations = 0;

  await assert.rejects(workspace.withFrameLease(
    await workspace.loadManifest(),
    () => {
      operations += 1;
      return null;
    },
  ), OutputConflictError);

  assert.equal(operations, 0);
  assert.equal(generationStats >= 2, true);
  assert.deepEqual(identity(await lstat(generationPath)), foreignGenerationIdentity);
  assert.deepEqual(identity(await lstat(path.join(generationPath, "foreign.txt"))), foreignMemberIdentity);
  assert.equal(await readFile(path.join(generationPath, "foreign.txt"), "utf8"), "foreign-generation");
  assert.equal(await readFile(path.join(generationPath, `owner-${token}`), "utf8"), "foreign-owner");
  assert.deepEqual(identity(await lstat(movedGenerationPath)), generationIdentity);
  assert.deepEqual(identity(await lstat(path.join(movedGenerationPath, "abandoned.jpg"))), memberIdentity);
  assert.equal(await readFile(path.join(movedGenerationPath, `owner-${token}`), "utf8"), token);
});

test("recovery preserves a replacement member introduced between capture and unlink", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-recovery-member-replacement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const foreignPath = path.join(root, "foreign-recovery-member.jpg");
  await writeFile(foreignPath, "foreign-recovery-member");
  const foreignIdentity = identity(await lstat(foreignPath));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  };
  const initialWorkspace = await openWorkspace(options);
  const token = "00000000-0000-4000-8000-000000000202";
  const generationPath = path.join(initialWorkspace.imagesDir, `.v2w-frame-stage-${token}`);
  const ownerPath = path.join(generationPath, `owner-${token}`);
  const memberPath = path.join(generationPath, "abandoned.jpg");
  await mkdir(generationPath, { mode: 0o700 });
  await writeFile(ownerPath, token);
  await writeFile(memberPath, "owned-abandoned-member");
  const generationIdentity = identity(await lstat(generationPath));
  let memberStats = 0;
  const workspace = await openWorkspace({
    ...options,
    frameFileOps: {
      lstat(filePath) {
        if (filePath === memberPath) {
          memberStats += 1;
          if (memberStats === 2) {
            unlinkSync(memberPath);
            linkSync(foreignPath, memberPath);
          }
        }
        return lstatSync(filePath);
      },
    },
  });
  let operations = 0;

  await assert.rejects(workspace.withFrameLease(
    await workspace.loadManifest(),
    () => {
      operations += 1;
      return null;
    },
  ), OutputConflictError);

  assert.equal(operations, 0);
  assert.equal(memberStats >= 2, true);
  assert.deepEqual(identity(await lstat(generationPath)), generationIdentity);
  assert.deepEqual(identity(await lstat(memberPath)), foreignIdentity);
  assert.deepEqual(identity(await lstat(foreignPath)), foreignIdentity);
  assert.equal(await readFile(memberPath, "utf8"), "foreign-recovery-member");
  assert.equal(await readFile(ownerPath, "utf8"), token);
});

test("EEXIST with a prior final leaves an owned recoverable stage and the next real extraction completes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-prior-final-eexist-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  const foreignPath = path.join(root, "foreign-eexist.jpg");
  await writeFile(videoPath, "source-video-bytes");
  await writeFile(foreignPath, "foreign-eexist-bytes");
  const sourceIdentity = identity(await lstat(videoPath));
  const foreignIdentity = identity(await lstat(foreignPath));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const planned = capture();
  delete planned.width;
  delete planned.height;
  const initialWorkspace = await openWorkspace(options);
  const initial = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: initialWorkspace,
    manifest: await initialWorkspace.loadManifest(),
    run: frameRunner("prior-jpeg"),
    log: { info() {} },
  });
  const finalPath = path.join(initialWorkspace.imagesDir, planned.filename);
  let injected = false;
  const failingWorkspace = await openWorkspace({
    ...options,
    frameFileOps: {
      link(from, to) {
        if (!injected
          && to === finalPath
          && path.extname(from) === ".jpg"
          && path.basename(path.dirname(from)).startsWith(".v2w-frame-stage-")) {
          injected = true;
          linkSync(foreignPath, finalPath);
        }
        linkSync(from, to);
      },
    },
  });
  const changed = { ...planned, timestampMs: planned.timestampMs + 1 };

  await assert.rejects(extractFrames({
    videoPath,
    captures: [changed],
    workspace: failingWorkspace,
    manifest: initial,
    run: frameRunner("failed-new-jpeg"),
    log: { info() {} },
  }), SourceError);

  assert.equal(injected, true);
  assert.equal((await failingWorkspace.loadManifest()).revision, initial.revision);
  assert.deepEqual(identity(await lstat(finalPath)), foreignIdentity);
  assert.deepEqual(identity(await lstat(foreignPath)), foreignIdentity);
  assert.deepEqual(identity(await lstat(videoPath)), sourceIdentity);
  const [stageName] = await frameStageNames(failingWorkspace.imagesDir);
  const stageEntries = await readdir(path.join(failingWorkspace.imagesDir, stageName));
  assert.equal(stageEntries.some((entry) => entry.startsWith("owner-")), true);
  assert.equal(stageEntries.some((entry) => entry.startsWith("previous-")), true);

  const resumed = await openWorkspace(options);
  const recovered = await extractFrames({
    videoPath,
    captures: [changed],
    workspace: resumed,
    manifest: await resumed.loadManifest(),
    run: frameRunner("recovered-jpeg"),
    log: { info() {} },
  });
  assert.equal(await readFile(finalPath, "utf8"), "recovered-jpeg");
  assert.deepEqual(identity(await lstat(foreignPath)), foreignIdentity);
  assert.equal((await resumed.markComplete(recovered)).status, "complete");
  assert.deepEqual(await readdir(resumed.imagesDir), [planned.filename]);
});

test("manifest success plus backup cleanup failure retains its owner until a real resume recovers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-manifest-backup-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  await writeFile(videoPath, "source-video-bytes");
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const planned = capture();
  delete planned.width;
  delete planned.height;
  const initialWorkspace = await openWorkspace(options);
  const initial = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: initialWorkspace,
    manifest: await initialWorkspace.loadManifest(),
    run: frameRunner("prior-jpeg"),
    log: { info() {} },
  });
  const cleanupFailure = Object.assign(new Error("injected synchronous backup unlink failure"), {
    code: "EIO",
  });
  let cleanupAttempts = 0;
  const failingWorkspace = await openWorkspace({
    ...options,
    frameFileOps: {
      unlink(filePath) {
        if (path.basename(filePath).startsWith("previous-")) {
          cleanupAttempts += 1;
          throw cleanupFailure;
        }
        unlinkSync(filePath);
      },
    },
  });
  const changed = { ...planned, timestampMs: planned.timestampMs + 1 };

  await assert.rejects(extractFrames({
    videoPath,
    captures: [changed],
    workspace: failingWorkspace,
    manifest: initial,
    run: frameRunner("committed-new-jpeg"),
    log: { info() {} },
  }), (error) => error instanceof SourceError && error.cause instanceof AggregateError);

  assert.equal(cleanupAttempts >= 1, true);
  const persisted = await failingWorkspace.loadManifest();
  assert.equal(persisted.revision, initial.revision + 1);
  assert.equal(await readFile(path.join(failingWorkspace.imagesDir, planned.filename), "utf8"), "committed-new-jpeg");
  const [stageName] = await frameStageNames(failingWorkspace.imagesDir);
  const stageEntries = await readdir(path.join(failingWorkspace.imagesDir, stageName));
  assert.equal(stageEntries.some((entry) => entry.startsWith("owner-")), true);
  assert.equal(stageEntries.some((entry) => entry.startsWith("previous-")), true);

  const resumed = await openWorkspace(options);
  let runnerCalls = 0;
  const recovered = await extractFrames({
    videoPath,
    captures: [changed],
    workspace: resumed,
    manifest: await resumed.loadManifest(),
    run: async () => {
      runnerCalls += 1;
      throw new Error("committed frame must be reused after stage recovery");
    },
    log: { info() {} },
  });
  assert.equal(runnerCalls, 0);
  assert.equal((await resumed.markComplete(recovered)).status, "complete");
  assert.deepEqual(await readdir(resumed.imagesDir), [planned.filename]);
});

test("member cleanup failure removes no owner marker and the next real extraction recovers it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-owner-last-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "source-video.mov");
  await writeFile(videoPath, "source-video-bytes");
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source: { ...source, input: videoPath },
  };
  const planned = capture();
  delete planned.width;
  delete planned.height;
  const runnerFailure = new Error("injected runner failure");
  const unlinkFailure = Object.assign(new Error("injected member unlink failure"), { code: "EIO" });
  let memberUnlinks = 0;
  const workspace = await openWorkspace({
    ...options,
    frameFileOps: {
      unlink(filePath) {
        if (path.extname(filePath) === ".jpg") {
          memberUnlinks += 1;
          throw unlinkFailure;
        }
        unlinkSync(filePath);
      },
    },
  });

  await assert.rejects(extractFrames({
    videoPath,
    captures: [planned],
    workspace,
    manifest: await workspace.loadManifest(),
    run: async () => { throw runnerFailure; },
    log: { info() {} },
  }), (error) => error instanceof SourceError && error.cause instanceof AggregateError);

  assert.equal(memberUnlinks, 1);
  const [stageName] = await frameStageNames(workspace.imagesDir);
  const stagePath = path.join(workspace.imagesDir, stageName);
  const token = stageName.slice(".v2w-frame-stage-".length);
  assert.deepEqual((await readdir(stagePath)).sort(), [
    planned.filename,
    `owner-${token}`,
  ].sort());
  assert.equal(await readFile(path.join(stagePath, `owner-${token}`), "utf8"), token);

  const resumed = await openWorkspace(options);
  const recovered = await extractFrames({
    videoPath,
    captures: [planned],
    workspace: resumed,
    manifest: await resumed.loadManifest(),
    run: frameRunner("recovered-jpeg"),
    log: { info() {} },
  });
  assert.equal((await resumed.markComplete(recovered)).status, "complete");
  assert.deepEqual(await readdir(resumed.imagesDir), [planned.filename]);
});

test("rejects empty fingerprints and noncanonical resumed timestamps", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-canonical-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");
  await assert.rejects(
    openWorkspace({
      cacheRoot: path.join(root, "cache"),
      fingerprint: "",
      outputDir,
      source: { ...source, fingerprint: "" },
    }),
    OutputConflictError,
  );

  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir,
    source,
  };
  const workspace = await openWorkspace(options);
  const building = await workspace.loadManifest();
  for (const createdAt of ["1", "2026-02-30T00:00:00.000Z"]) {
    const invalid = JSON.stringify({ ...building, createdAt });
    await writeFile(workspace.manifestPath, invalid);
    await assert.rejects(openWorkspace(options), OutputConflictError);
    assert.equal(await readFile(workspace.manifestPath, "utf8"), invalid);
  }

  await writeFile(workspace.manifestPath, `${JSON.stringify(building, null, 2)}\n`);
  const complete = await workspace.markComplete(building);
  const invalidCompletedAt = JSON.stringify({
    ...complete,
    completedAt: "2026-02-30T00:00:00.000Z",
  });
  await writeFile(workspace.manifestPath, invalidCompletedAt);
  await assert.rejects(openWorkspace(options), OutputConflictError);
  assert.equal(await readFile(workspace.manifestPath, "utf8"), invalidCompletedAt);
});

test("delayed initialization resumes a newer completed manifest without overwriting it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-initialization-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  };
  let allowDelayedOpen;
  const delayedOpen = new Promise((resolve) => {
    allowDelayedOpen = resolve;
  });
  let delayedBeforeLock;
  const delayedBeforeLockReached = new Promise((resolve) => {
    delayedBeforeLock = resolve;
  });
  const firstPromise = openWorkspace({
    ...options,
    hooks: {
      async beforeInitializationLock() {
        delayedBeforeLock();
        await delayedOpen;
      },
    },
  });
  await delayedBeforeLockReached;

  const second = await openWorkspace(options);
  const completed = await second.markComplete(await second.loadManifest());
  const completedBytes = await readFile(second.manifestPath, "utf8");
  allowDelayedOpen();
  const first = await firstPromise;

  assert.deepEqual(await first.loadManifest(), completed);
  assert.equal(await readFile(first.manifestPath, "utf8"), completedBytes);
});

test("a creator killed before lock publication cannot strand first-time initialization", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-killed-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  };
  const workspaceModuleUrl = new URL("../src/workspace.mjs", import.meta.url).href;
  const childSource = `
    import { openWorkspace } from ${JSON.stringify(workspaceModuleUrl)};
    const options = ${JSON.stringify(options)};
    await openWorkspace({
      ...options,
      hooks: {
        async afterLockCandidatePrepared(candidate) {
          process.send({ candidatePath: candidate.candidatePath });
          await new Promise(() => {});
        },
      },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const prepared = await Promise.race([
      once(child, "message").then(([message]) => message),
      once(child, "exit").then(([code, signal]) => {
        throw new Error(`candidate creator exited before its barrier (${code}, ${signal}): ${stderr}`);
      }),
    ]);
    assert.equal(typeof prepared.candidatePath, "string");
    assert.equal(path.dirname(prepared.candidatePath), options.outputDir);
    const childExit = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    const [code, signal] = await childExit;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    await assert.doesNotReject(access(prepared.candidatePath));

    const workspace = await openWorkspace(options);
    assert.equal((await workspace.loadManifest()).revision, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const childExit = once(child, "exit");
      child.kill("SIGKILL");
      await childExit;
    }
  }
});

test("metadata-close failure cleans only the unpublished candidate", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-candidate-close-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");
  const closeFailure = processError("EIO");
  let candidatePath;

  await assert.rejects(
    openWorkspace({
      cacheRoot: path.join(root, "cache"),
      fingerprint: source.fingerprint,
      outputDir,
      source,
      hooks: {
        async closeLockMetadata(handle, candidate) {
          candidatePath = candidate.candidatePath;
          await handle.close();
          throw closeFailure;
        },
      },
    }),
    (error) => error === closeFailure,
  );

  assert.equal(typeof candidatePath, "string");
  await assert.rejects(access(candidatePath));
  await assert.rejects(access(path.join(outputDir, manifestLockFilename)));
  assert.deepEqual(await readdir(outputDir), []);
});

test("two stale reclaimers cannot both own or delete a replacement lock", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-two-reclaimers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  };
  const firstObserved = deferred();
  const allowFirstUnlink = deferred();
  const firstPublished = deferred();
  const allowFirstMutation = deferred();
  const secondObserved = deferred();
  const allowSecondUnlink = deferred();
  let armFirstPublication = false;
  let publishedFirstOwner;
  const first = await openWorkspace({
    ...options,
    hooks: {
      killProcess: probeOnlyDeadOwner,
      async beforeStaleOwnerUnlink({ metadata }) {
        assert.equal(metadata.token, deadOwnerToken);
        firstObserved.resolve();
        await allowFirstUnlink.promise;
      },
      async afterLockPublished(owner) {
        if (!armFirstPublication) return;
        publishedFirstOwner = owner;
        firstPublished.resolve();
        await allowFirstMutation.promise;
      },
    },
  });
  const second = await openWorkspace({
    ...options,
    hooks: {
      killProcess: probeOnlyDeadOwner,
      async beforeStaleOwnerUnlink({ metadata }) {
        assert.equal(metadata.token, deadOwnerToken);
        secondObserved.resolve();
        await allowSecondUnlink.promise;
      },
    },
  });
  const firstManifest = await first.loadManifest();
  const secondManifest = structuredClone(await second.loadManifest());
  const { lockPath } = await createOwnerLock(first.outputDir);
  armFirstPublication = true;
  const mutations = [
    first.recordFrame(firstManifest, capture()),
    second.markComplete(secondManifest),
  ];
  const firstResult = mutations[0].then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  const secondResult = mutations[1].then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  const settled = Promise.allSettled(mutations);

  try {
    const phase = await Promise.race([
      Promise.all([firstObserved.promise, secondObserved.promise]).then(() => "both-observed"),
      settled.then(() => "mutations-settled"),
    ]);
    assert.equal(phase, "both-observed", "both reclaimers must reach the stale-identity barrier");

    allowFirstUnlink.resolve();
    const publicationPhase = await Promise.race([
      firstPublished.promise.then(() => "first-published"),
      firstResult.then(() => "first-settled"),
    ]);
    assert.equal(publicationPhase, "first-published");

    allowSecondUnlink.resolve();
    const rejectedSecond = await secondResult;
    assert.equal(rejectedSecond.status, "rejected");
    assert.ok(rejectedSecond.reason instanceof OutputConflictError);
    assert.deepEqual(await readOwnerLock(lockPath), {
      ownerFilename: publishedFirstOwner.ownerFilename,
      metadata: publishedFirstOwner.metadata,
    });

    allowFirstMutation.resolve();
    const completedFirst = await firstResult;
    assert.equal(completedFirst.status, "fulfilled");
    assert.equal(completedFirst.value.revision, 2);
  } finally {
    allowFirstUnlink.resolve();
    allowSecondUnlink.resolve();
    allowFirstMutation.resolve();
  }

  const results = await settled;
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.ok(results.some((result) => result.status === "rejected"
    && result.reason instanceof OutputConflictError));
  const persisted = await first.loadManifest();
  assert.equal(persisted.revision, 2);
  await assert.rejects(access(lockPath));
});

test("a delayed stale reclaimer cannot remove a live replacement owner", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-replacement-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  };
  const staleOwnerUnlinked = deferred();
  const allowStaleReclaimer = deferred();
  const replacementPublished = deferred();
  const allowReplacement = deferred();
  let armReplacement = false;
  let publishedReplacement;
  let reclaimMutation;
  let replacementMutation;
  const reclaimer = await openWorkspace({
    ...options,
    hooks: {
      killProcess: probeOnlyDeadOwner,
      async afterStaleOwnerUnlink(observed) {
        staleOwnerUnlinked.resolve(observed);
        await allowStaleReclaimer.promise;
      },
    },
  });
  const replacement = await openWorkspace({
    ...options,
    hooks: {
      async afterLockPublished(owner) {
        if (!armReplacement) return;
        publishedReplacement = owner;
        replacementPublished.resolve();
        await allowReplacement.promise;
      },
    },
  });
  const reclaimerManifest = await reclaimer.loadManifest();
  const replacementManifest = structuredClone(await replacement.loadManifest());
  const { lockPath } = await createOwnerLock(reclaimer.outputDir);

  try {
    reclaimMutation = reclaimer.saveManifest(reclaimerManifest);
    const reclaimResult = reclaimMutation.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    const recoveryPhase = await Promise.race([
      staleOwnerUnlinked.promise.then(() => "stale-owner-unlinked"),
      reclaimResult.then(() => "reclaimer-settled"),
    ]);
    assert.equal(recoveryPhase, "stale-owner-unlinked");

    armReplacement = true;
    replacementMutation = replacement.recordFrame(replacementManifest, capture());
    const replacementResult = replacementMutation.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    const replacementPhase = await Promise.race([
      replacementPublished.promise.then(() => "replacement-published"),
      replacementResult.then(() => "replacement-settled"),
    ]);
    assert.equal(replacementPhase, "replacement-published");

    allowStaleReclaimer.resolve();
    const rejectedReclaimer = await reclaimResult;
    assert.equal(rejectedReclaimer.status, "rejected");
    assert.ok(rejectedReclaimer.reason instanceof OutputConflictError);
    assert.deepEqual(await readOwnerLock(lockPath), {
      ownerFilename: publishedReplacement.ownerFilename,
      metadata: publishedReplacement.metadata,
    });

    allowReplacement.resolve();
    const completedReplacement = await replacementResult;
    assert.equal(completedReplacement.status, "fulfilled");
    assert.equal(completedReplacement.value.revision, 2);
    await assert.rejects(access(lockPath));
  } finally {
    allowStaleReclaimer.resolve();
    allowReplacement.resolve();
    await Promise.allSettled([reclaimMutation, replacementMutation].filter(Boolean));
  }
});

test("lock publication is complete and failed acquisition cleans only its candidate", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-lock-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  };
  const candidatePrepared = deferred();
  const allowCandidatePublication = deferred();
  const replacementPublished = deferred();
  const allowReplacement = deferred();
  let armCandidate = false;
  let armReplacement = false;
  let preparedCandidate;
  let publishedReplacement;
  let candidateMutation;
  let replacementMutation;
  const candidateWorkspace = await openWorkspace({
    ...options,
    hooks: {
      async afterLockCandidatePrepared(candidate) {
        if (!armCandidate) return;
        preparedCandidate = candidate;
        candidatePrepared.resolve();
        await allowCandidatePublication.promise;
      },
    },
  });
  const replacementWorkspace = await openWorkspace({
    ...options,
    hooks: {
      async afterLockPublished(owner) {
        if (!armReplacement) return;
        publishedReplacement = owner;
        replacementPublished.resolve();
        await allowReplacement.promise;
      },
    },
  });
  const candidateManifest = await candidateWorkspace.loadManifest();
  const replacementManifest = structuredClone(await replacementWorkspace.loadManifest());
  const lockPath = path.join(candidateWorkspace.outputDir, manifestLockFilename);

  try {
    armCandidate = true;
    candidateMutation = candidateWorkspace.saveManifest(candidateManifest);
    const candidateResult = candidateMutation.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    const candidatePhase = await Promise.race([
      candidatePrepared.promise.then(() => "candidate-prepared"),
      candidateResult.then(() => "candidate-settled"),
    ]);
    assert.equal(candidatePhase, "candidate-prepared");
    await assert.rejects(access(lockPath));
    assert.deepEqual(await readOwnerLock(preparedCandidate.candidatePath), {
      ownerFilename: preparedCandidate.ownerFilename,
      metadata: preparedCandidate.metadata,
    });

    armReplacement = true;
    replacementMutation = replacementWorkspace.recordFrame(replacementManifest, capture());
    const replacementResult = replacementMutation.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    const replacementPhase = await Promise.race([
      replacementPublished.promise.then(() => "replacement-published"),
      replacementResult.then(() => "replacement-settled"),
    ]);
    assert.equal(replacementPhase, "replacement-published");

    allowCandidatePublication.resolve();
    const rejectedCandidate = await candidateResult;
    assert.equal(rejectedCandidate.status, "rejected");
    assert.ok(rejectedCandidate.reason instanceof OutputConflictError);
    await assert.rejects(access(preparedCandidate.candidatePath));
    assert.deepEqual(await readOwnerLock(lockPath), {
      ownerFilename: publishedReplacement.ownerFilename,
      metadata: publishedReplacement.metadata,
    });

    allowReplacement.resolve();
    const completedReplacement = await replacementResult;
    assert.equal(completedReplacement.status, "fulfilled");
    assert.equal(completedReplacement.value.revision, 2);
    await assert.rejects(access(lockPath));

    await mkdir(lockPath);
    const afterInterruptedRecovery = await candidateWorkspace.saveManifest(completedReplacement.value);
    assert.equal(afterInterruptedRecovery.revision, 3);
    await assert.rejects(access(lockPath));
  } finally {
    allowCandidatePublication.resolve();
    allowReplacement.resolve();
    await Promise.allSettled([candidateMutation, replacementMutation].filter(Boolean));
  }
});

test("EPERM from the liveness probe keeps the complete owner lock busy and unchanged", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-eperm-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probes = [];
  const workspace = await openWorkspace({
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
    hooks: {
      killProcess(pid, signal) {
        probes.push([pid, signal]);
        throw processError("EPERM");
      },
    },
  });
  const manifest = await workspace.loadManifest();
  const manifestBytes = await readFile(workspace.manifestPath, "utf8");
  const owner = await createOwnerLock(workspace.outputDir);

  await assert.rejects(workspace.saveManifest(manifest), OutputConflictError);

  assert.deepEqual(probes, [[deadOwnerPid, 0]]);
  assert.deepEqual(await readOwnerLock(owner.lockPath), {
    ownerFilename: owner.ownerFilename,
    metadata: owner.metadata,
  });
  assert.equal(await readFile(workspace.manifestPath, "utf8"), manifestBytes);
});
