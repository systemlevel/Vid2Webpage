import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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

async function preparedFrame(workspace, frame = capture()) {
  const tempPath = path.join(
    workspace.imagesDir,
    `${path.parse(frame.filename).name}.part-${process.pid}-00000000-0000-4000-8000-000000000011.jpg`,
  );
  await writeFile(tempPath, "prepared-jpeg");
  const info = await lstat(tempPath);
  return {
    tempPath,
    tempIdentity: { dev: info.dev, ino: info.ino },
    frame,
  };
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

  assert.equal(firstManifest.revision, 0);
  const advanced = await first.recordFrame(firstManifest, capture());
  assert.equal(advanced.revision, 1);
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

test("concurrent output mutations leave exactly one revision-one terminal or building result", async (t) => {
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
  assert.equal(manifest.revision, 1);
  if (manifest.status === "complete") {
    assert.equal(manifest.images.length, 0);
  } else {
    assert.deepEqual(manifest.images.map((image) => image.filename), ["000004000-primary.jpg"]);
  }
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
  const completionLocked = deferred();
  const allowCompletion = deferred();
  let armCompletion = false;
  const completing = await openWorkspace({
    ...options,
    hooks: {
      async afterLockPublished() {
        if (!armCompletion) return;
        completionLocked.resolve();
        await allowCompletion.promise;
      },
    },
  });
  const extracting = await openWorkspace(options);
  const completionManifest = await completing.loadManifest();
  const staleFrameManifest = structuredClone(await extracting.loadManifest());
  const prepared = await preparedFrame(extracting);
  const finalPath = path.join(extracting.imagesDir, prepared.frame.filename);

  armCompletion = true;
  const completion = completing.markComplete(completionManifest);
  await completionLocked.promise;
  try {
    await assert.rejects(
      extracting.commitFrame(staleFrameManifest, prepared),
      OutputConflictError,
    );
  } finally {
    allowCompletion.resolve();
  }
  await assert.rejects(access(finalPath));
  assert.equal(await readFile(prepared.tempPath, "utf8"), "prepared-jpeg");

  const complete = await completion;
  assert.equal(complete.status, "complete");
  assert.deepEqual(complete.images, []);
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
  const frameLocked = deferred();
  const allowFrameCommit = deferred();
  let armFrame = false;
  const extracting = await openWorkspace({
    ...options,
    hooks: {
      async afterLockPublished() {
        if (!armFrame) return;
        frameLocked.resolve();
        await allowFrameCommit.promise;
      },
    },
  });
  const completing = await openWorkspace(options);
  const frameManifest = await extracting.loadManifest();
  const staleCompletionManifest = structuredClone(await completing.loadManifest());
  const prepared = await preparedFrame(extracting);
  const finalPath = path.join(extracting.imagesDir, prepared.frame.filename);

  armFrame = true;
  const frameCommit = extracting.commitFrame(frameManifest, prepared);
  const frameCommitResult = frameCommit.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  const phase = await Promise.race([
    frameLocked.promise.then(() => "frame-locked"),
    frameCommitResult.then(() => "frame-settled"),
  ]);
  assert.equal(phase, "frame-locked");
  await assert.rejects(
    completing.markComplete(staleCompletionManifest),
    OutputConflictError,
  );
  await assert.rejects(access(finalPath));

  allowFrameCommit.resolve();
  const completedFrameCommit = await frameCommitResult;
  assert.equal(completedFrameCommit.status, "fulfilled");
  const building = completedFrameCommit.value;
  assert.equal(building.status, "building");
  assert.equal(building.revision, 1);
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
  const workspace = await openWorkspace({
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
    hooks: {
      beforeFrameManifestWrite() {
        throw failure;
      },
    },
  });
  const manifest = await workspace.loadManifest();
  const prepared = await preparedFrame(workspace);
  const finalPath = path.join(workspace.imagesDir, prepared.frame.filename);

  await assert.rejects(
    workspace.commitFrame(manifest, prepared),
    (error) => error === failure,
  );

  const persisted = await workspace.loadManifest();
  assert.equal(persisted.status, "building");
  assert.equal(persisted.revision, 0);
  assert.deepEqual(persisted.images, []);
  assert.equal(await readFile(finalPath, "utf8"), "prepared-jpeg");
  await assert.rejects(access(prepared.tempPath));
  assert.equal((await openWorkspace({
    cacheRoot: path.join(root, "cache"),
    fingerprint: source.fingerprint,
    outputDir: path.join(root, "output"),
    source,
  })).outputDir, workspace.outputDir);
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
    assert.equal((await workspace.loadManifest()).revision, 0);
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
    assert.equal(completedFirst.value.revision, 1);
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
  assert.equal(persisted.revision, 1);
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
    assert.equal(completedReplacement.value.revision, 1);
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
    assert.equal(completedReplacement.value.revision, 1);
    await assert.rejects(access(lockPath));

    await mkdir(lockPath);
    const afterInterruptedRecovery = await candidateWorkspace.saveManifest(completedReplacement.value);
    assert.equal(afterInterruptedRecovery.revision, 2);
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
