import assert from "node:assert/strict";
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SourceError } from "../src/errors.mjs";
import {
  buildFrameArgs,
  extractFrames,
  probeImageDimensions,
} from "../src/frames.mjs";

function capture({
  filename = "000004250-primary.jpg",
  requestedMs = 4000,
  timestampMs = 4250,
  reasons = ["primary", "caption"],
  associations = [
    { segmentIndex: 0, requestedMs: 4000, reasons: ["primary"] },
    { segmentIndex: 2, requestedMs: 4100, reasons: ["caption"] },
  ],
} = {}) {
  return { requestedMs, timestampMs, reasons, associations, filename };
}

function buildingManifest(images = [], revision = 0) {
  return { status: "building", revision, images };
}

async function frameFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2w-frames-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagesDir = path.join(root, "output", "images");
  await mkdir(imagesDir, { recursive: true });
  return { root, imagesDir };
}

function successfulRun({ width = 1920, height = 1080, calls = [] } = {}) {
  return async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "ffmpeg") {
      await writeFile(args.at(-1), "jpeg-bytes");
      return { code: 0, stdout: "", stderr: "" };
    }
    return {
      code: 0,
      stdout: JSON.stringify({ streams: [{ width, height }] }),
      stderr: "",
    };
  };
}

async function commitPreparedFrame(imagesDir, manifest, { tempPath, frame }) {
  await rename(tempPath, path.join(imagesDir, frame.filename));
  return {
    ...manifest,
    revision: manifest.revision + 1,
    images: [...manifest.images.filter((image) => image.filename !== frame.filename), frame],
  };
}

test("frame arguments seek to the requested decoded frame and emit one native JPEG", () => {
  const args = buildFrameArgs({
    videoPath: "/video with spaces.mov",
    timestampMs: 4250,
    outputPath: "/out.part.jpg",
  });
  assert.deepEqual(args, [
    "-y", "-ss", "4.250", "-i", "/video with spaces.mov",
    "-map", "0:v:0", "-frames:v", "1", "-q:v", "2",
    "-update", "1", "/out.part.jpg",
  ]);
  assert.equal(args.includes("-vf"), false);
  assert.equal(args.includes("-c:v"), false);
  assert.equal(args.includes("-c:a"), false);
});

test("frame arguments format zero and maximum safe millisecond timestamps exactly", () => {
  assert.equal(buildFrameArgs({
    videoPath: "/video.mov",
    timestampMs: 0,
    outputPath: "/zero.jpg",
  })[2], "0.000");
  assert.equal(buildFrameArgs({
    videoPath: "/video.mov",
    timestampMs: Number.MAX_SAFE_INTEGER,
    outputPath: "/maximum.jpg",
  })[2], "9007199254740.991");
});

test("image probing selects the first video stream and returns positive integer dimensions", async () => {
  const calls = [];
  const dimensions = await probeImageDimensions("/image with spaces.jpg", {
    run: async (command, args) => {
      calls.push({ command, args });
      return {
        code: 0,
        stdout: JSON.stringify({ streams: [{ width: 3840, height: 2160 }] }),
        stderr: "",
      };
    },
  });

  assert.deepEqual(dimensions, { width: 3840, height: 2160 });
  assert.deepEqual(calls, [{
    command: "ffprobe",
    args: [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "json",
      "/image with spaces.jpg",
    ],
  }]);
});

test("image probing rejects command, JSON, empty-stream, and invalid-dimension results", async () => {
  const invalidResults = [
    async () => ({ code: 1, stdout: "", stderr: "probe failed" }),
    async () => ({ code: 0, stdout: "not json", stderr: "" }),
    async () => ({ code: 0, stdout: JSON.stringify({ streams: [] }), stderr: "" }),
    async () => ({ code: 0, stdout: JSON.stringify({ streams: [{ width: 0, height: 1080 }] }), stderr: "" }),
    async () => ({ code: 0, stdout: JSON.stringify({ streams: [{ width: 1920.5, height: 1080 }] }), stderr: "" }),
  ];

  for (const run of invalidResults) {
    await assert.rejects(probeImageDimensions("/bad.jpg", { run }), SourceError);
  }
  await assert.rejects(
    probeImageDimensions("/bad.jpg", { run: async () => { throw new Error("spawn failed"); } }),
    (error) => error instanceof SourceError && error.cause?.message === "spawn failed",
  );
});

test("extraction preserves every logical association and publishes native dimensions", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const planned = capture();
  const recorded = [];
  const workspace = {
    imagesDir,
    canReuseFrame: async () => false,
    commitFrame: async (manifest, prepared) => {
      const { frame } = prepared;
      recorded.push(structuredClone(frame));
      return commitPreparedFrame(imagesDir, manifest, prepared);
    },
  };

  const result = await extractFrames({
    videoPath: "/video.mov",
    captures: [planned],
    workspace,
    manifest: buildingManifest(),
    run: successfulRun(),
    log: { info() {} },
  });

  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    ...planned,
    associations: [
      { segmentIndex: 0, requestedMs: 4000, reasons: ["primary"] },
      { segmentIndex: 2, requestedMs: 4100, reasons: ["caption"] },
    ],
    width: 1920,
    height: 1080,
  });
  assert.equal(Object.hasOwn(recorded[0], "segmentIndex"), false);
  assert.equal(result.revision, 1);
  assert.equal(await readFile(path.join(imagesDir, planned.filename), "utf8"), "jpeg-bytes");
});

test("extraction is timestamp-ordered, sequential, and threads each manifest revision", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const later = capture({
    filename: "000008000-scene.jpg",
    requestedMs: 7750,
    timestampMs: 8000,
    reasons: ["scene"],
    associations: [{ segmentIndex: 1, requestedMs: 7750, reasons: ["scene"] }],
  });
  const earlier = capture();
  const originalPlan = structuredClone([later, earlier]);
  const recordInputs = [];
  let activeCommands = 0;
  const run = async (command, args) => {
    activeCommands += 1;
    assert.equal(activeCommands, 1);
    try {
      if (command === "ffmpeg") {
        await writeFile(args.at(-1), "jpeg-bytes");
        return { code: 0, stdout: "", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ streams: [{ width: 1280, height: 720 }] }),
        stderr: "",
      };
    } finally {
      activeCommands -= 1;
    }
  };
  const workspace = {
    imagesDir,
    canReuseFrame: async () => false,
    commitFrame: async (manifest, prepared) => {
      const { frame } = prepared;
      recordInputs.push({ revision: manifest.revision, timestampMs: frame.timestampMs });
      return commitPreparedFrame(imagesDir, manifest, prepared);
    },
  };

  const result = await extractFrames({
    videoPath: "/video.mov",
    captures: [later, earlier],
    workspace,
    manifest: buildingManifest([], 7),
    run,
    log: { info() {} },
  });

  assert.deepEqual(recordInputs, [
    { revision: 7, timestampMs: 4250 },
    { revision: 8, timestampMs: 8000 },
  ]);
  assert.equal(result.revision, 9);
  assert.deepEqual([later, earlier], originalPlan, "the caller's plan remains unmodified");
});

test("a matching nonempty manifest frame is reused without extraction or mutation", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const planned = capture();
  const existing = { ...planned, width: 640, height: 360 };
  await writeFile(path.join(imagesDir, planned.filename), "existing-jpeg");
  const reuseChecks = [];
  const manifest = buildingManifest([existing], 4);
  const result = await extractFrames({
    videoPath: "/video.mov",
    captures: [planned],
    workspace: {
      imagesDir,
      canReuseFrame: async (frame) => {
        reuseChecks.push(structuredClone(frame));
        return true;
      },
      commitFrame: async () => { throw new Error("must not commit a reused frame"); },
    },
    manifest,
    run: async () => { throw new Error("must not invoke FFmpeg for a reused frame"); },
    log: { info() {} },
  });

  assert.equal(result, manifest);
  assert.deepEqual(reuseChecks, [existing]);
  assert.equal(await readFile(path.join(imagesDir, planned.filename), "utf8"), "existing-jpeg");
});

test("reuse rechecks a source alias introduced while canReuseFrame is awaiting", async (t) => {
  const { root, imagesDir } = await frameFixture(t);
  const planned = capture();
  const existing = { ...planned, width: 640, height: 360 };
  const sourcePath = path.join(root, "source-video.mov");
  const finalPath = path.join(imagesDir, planned.filename);
  await writeFile(sourcePath, "source-video-bytes");
  await writeFile(finalPath, "existing-jpeg");
  let allowReuse;
  let reuseStarted;
  const reuseStartedPromise = new Promise((resolve) => { reuseStarted = resolve; });
  const allowReusePromise = new Promise((resolve) => { allowReuse = resolve; });
  const extraction = extractFrames({
    videoPath: sourcePath,
    captures: [planned],
    workspace: {
      imagesDir,
      async canReuseFrame() {
        reuseStarted();
        await allowReusePromise;
        return true;
      },
      commitFrame: async () => { throw new Error("must not commit an aliased reuse"); },
    },
    manifest: buildingManifest([existing], 4),
    run: async () => { throw new Error("must not extract an aliased reuse"); },
    log: { info() {} },
  });

  await reuseStartedPromise;
  await unlink(finalPath);
  await link(sourcePath, finalPath);
  allowReuse();
  await assert.rejects(extraction, SourceError);

  assert.equal(await readFile(sourcePath, "utf8"), "source-video-bytes");
  assert.equal(await readFile(finalPath, "utf8"), "source-video-bytes");
});

test("a stale manifest image is replaced and recorded when reuse is not confirmed", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const planned = capture();
  const stale = { ...planned, width: 640, height: 360 };
  await writeFile(path.join(imagesDir, planned.filename), "stale-jpeg");
  let recorded;
  const result = await extractFrames({
    videoPath: "/video.mov",
    captures: [planned],
    workspace: {
      imagesDir,
      canReuseFrame: async (candidate) => {
        assert.deepEqual(candidate, stale);
        return false;
      },
      commitFrame: async (manifest, prepared) => {
        const { frame } = prepared;
        recorded = frame;
        return commitPreparedFrame(imagesDir, manifest, prepared);
      },
    },
    manifest: buildingManifest([stale], 1),
    run: successfulRun({ width: 1920, height: 1080 }),
    log: { info() {} },
  });

  assert.deepEqual({ width: recorded.width, height: recorded.height }, { width: 1920, height: 1080 });
  assert.equal(result.revision, 2);
  assert.equal(await readFile(path.join(imagesDir, planned.filename), "utf8"), "jpeg-bytes");
});

test("FFmpeg nonzero exit cleans its partial temp and preserves final and foreign files", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const planned = capture();
  const finalPath = path.join(imagesDir, planned.filename);
  const foreignPath = path.join(imagesDir, "foreign.part-1234-owned.jpg");
  await writeFile(finalPath, "foreign-final");
  await writeFile(foreignPath, "foreign-temp");
  let ownedTemp;

  await assert.rejects(extractFrames({
    videoPath: "/video.mov",
    captures: [planned],
    workspace: {
      imagesDir,
      canReuseFrame: async () => false,
      commitFrame: async () => { throw new Error("must not commit failed output"); },
    },
    manifest: buildingManifest(),
    run: async (command, args) => {
      assert.equal(command, "ffmpeg");
      ownedTemp = args.at(-1);
      await writeFile(ownedTemp, "partial-jpeg");
      return { code: 1, stdout: "", stderr: "decode failed" };
    },
    log: { info() {} },
  }), SourceError);

  await assert.rejects(access(ownedTemp));
  assert.equal(await readFile(finalPath, "utf8"), "foreign-final");
  assert.equal(await readFile(foreignPath, "utf8"), "foreign-temp");
});

test("FFmpeg success with empty output is fatal and leaves no final image", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const planned = capture();
  let tempPath;
  await assert.rejects(extractFrames({
    videoPath: "/video.mov",
    captures: [planned],
    workspace: {
      imagesDir,
      canReuseFrame: async () => false,
      commitFrame: async () => { throw new Error("must not commit empty output"); },
    },
    manifest: buildingManifest(),
    run: async (_command, args) => {
      tempPath = args.at(-1);
      return { code: 0, stdout: "", stderr: "" };
    },
    log: { info() {} },
  }), SourceError);

  await assert.rejects(access(tempPath));
  await assert.rejects(access(path.join(imagesDir, planned.filename)));
});

test("invalid probed dimensions clean the owned temp and leave no final image", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const planned = capture();
  let tempPath;
  await assert.rejects(extractFrames({
    videoPath: "/video.mov",
    captures: [planned],
    workspace: {
      imagesDir,
      canReuseFrame: async () => false,
      commitFrame: async () => { throw new Error("must not commit invalid dimensions"); },
    },
    manifest: buildingManifest(),
    run: async (command, args) => {
      if (command === "ffmpeg") {
        tempPath = args.at(-1);
        await writeFile(tempPath, "jpeg-bytes");
        return { code: 0, stdout: "", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ streams: [{ width: 1920, height: -1 }] }),
        stderr: "",
      };
    },
    log: { info() {} },
  }), SourceError);

  await assert.rejects(access(tempPath));
  await assert.rejects(access(path.join(imagesDir, planned.filename)));
});

test("concurrent invocations exclusively own unique JPEG temp siblings", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const planned = capture();
  const foreignPath = path.join(imagesDir, "foreign.part-9999-still-owned.jpg");
  await writeFile(foreignPath, "foreign-temp");
  const tempPaths = [];
  let releaseBoth;
  const bothStarted = new Promise((resolve) => { releaseBoth = resolve; });

  function concurrentRun(succeeds) {
    return async (command, args) => {
      if (command === "ffprobe") {
        return {
          code: 0,
          stdout: JSON.stringify({ streams: [{ width: 1920, height: 1080 }] }),
          stderr: "",
        };
      }
      const tempPath = args.at(-1);
      tempPaths.push(tempPath);
      if (tempPaths.length === 2) releaseBoth();
      await bothStarted;
      await writeFile(tempPath, succeeds ? "winner-jpeg" : "partial-jpeg");
      return { code: succeeds ? 0 : 1, stdout: "", stderr: succeeds ? "" : "failed" };
    };
  }

  const workspace = {
    imagesDir,
    canReuseFrame: async () => false,
    commitFrame: async (manifest, prepared) => commitPreparedFrame(imagesDir, manifest, prepared),
  };
  const results = await Promise.allSettled([
    extractFrames({
      videoPath: "/video.mov",
      captures: [planned],
      workspace,
      manifest: buildingManifest(),
      run: concurrentRun(false),
      log: { info() {} },
    }),
    extractFrames({
      videoPath: "/video.mov",
      captures: [planned],
      workspace,
      manifest: buildingManifest(),
      run: concurrentRun(true),
      log: { info() {} },
    }),
  ]);

  assert.deepEqual(results.map(({ status }) => status).sort(), ["fulfilled", "rejected"]);
  assert.equal(new Set(tempPaths).size, 2);
  for (const tempPath of tempPaths) {
    assert.equal(path.dirname(path.dirname(tempPath)), imagesDir);
    assert.match(path.basename(path.dirname(tempPath)), /^\.v2w-frame-stage-[0-9a-f-]+$/u);
    assert.equal(path.basename(tempPath), planned.filename);
    await assert.rejects(access(tempPath));
  }
  assert.equal(await readFile(foreignPath, "utf8"), "foreign-temp");
  assert.equal(await readFile(path.join(imagesDir, planned.filename), "utf8"), "winner-jpeg");
});

test("temp reservation retries an exclusive-name collision without touching the colliding file", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const planned = capture();
  const ids = [
    "00000000-0000-4000-8000-000000000021",
    "00000000-0000-4000-8000-000000000022",
  ];
  const collisionPath = path.join(imagesDir, `.v2w-frame-stage-${ids[0]}`);
  await mkdir(collisionPath);
  await writeFile(path.join(collisionPath, "foreign.txt"), "foreign-collision");
  let ffmpegOutputPath;

  const result = await extractFrames({
    videoPath: "/video.mov",
    captures: [planned],
    workspace: {
      imagesDir,
      canReuseFrame: async () => false,
      commitFrame: async (manifest, prepared) => commitPreparedFrame(imagesDir, manifest, prepared),
    },
    manifest: buildingManifest(),
    nextTempId: () => ids.shift(),
    run: async (command, args) => {
      if (command === "ffmpeg") {
        ffmpegOutputPath = args.at(-1);
        await writeFile(ffmpegOutputPath, "jpeg-bytes");
        return { code: 0, stdout: "", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ streams: [{ width: 1920, height: 1080 }] }),
        stderr: "",
      };
    },
    log: { info() {} },
  });

  assert.match(
    path.basename(path.dirname(ffmpegOutputPath)),
    /00000000-0000-4000-8000-000000000022$/u,
  );
  assert.equal(await readFile(path.join(collisionPath, "foreign.txt"), "utf8"), "foreign-collision");
  assert.equal(result.revision, 1);
});

test("direct, symlink, and hard-link frame aliases are rejected before FFmpeg", async (t) => {
  for (const aliasKind of ["direct", "symlink", "hard-link"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `v2w-frame-alias-${aliasKind}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const imagesDir = path.join(root, "images");
    await mkdir(imagesDir);
    const planned = capture({ filename: "source.jpg" });
    const sourcePath = aliasKind === "direct"
      ? path.join(imagesDir, planned.filename)
      : path.join(root, "source-video.mov");
    const finalPath = path.join(imagesDir, planned.filename);
    await writeFile(sourcePath, "original-video-bytes");
    if (aliasKind === "symlink") await symlink(sourcePath, finalPath);
    if (aliasKind === "hard-link") await link(sourcePath, finalPath);
    let runnerCalls = 0;

    await assert.rejects(extractFrames({
      videoPath: sourcePath,
      captures: [planned],
      workspace: {
        imagesDir,
        canReuseFrame: async () => false,
        commitFrame: async () => { throw new Error("must not commit an aliased frame"); },
      },
      manifest: buildingManifest(),
      run: async () => {
        runnerCalls += 1;
        throw new Error("must not run for an aliased frame");
      },
      log: { info() {} },
    }), SourceError);

    assert.equal(runnerCalls, 0, aliasKind);
    assert.equal(await readFile(sourcePath, "utf8"), "original-video-bytes", aliasKind);
    assert.equal(await readFile(finalPath, "utf8"), "original-video-bytes", aliasKind);
  }
});

test("a source alias introduced during extraction is rejected before final replacement", async (t) => {
  const { root, imagesDir } = await frameFixture(t);
  const sourcePath = path.join(root, "source-video.mov");
  const planned = capture();
  const finalPath = path.join(imagesDir, planned.filename);
  await writeFile(sourcePath, "original-video-bytes");
  let committed = false;

  await assert.rejects(extractFrames({
    videoPath: sourcePath,
    captures: [planned],
    workspace: {
      imagesDir,
      canReuseFrame: async () => false,
      commitFrame: async (manifest, prepared) => {
        committed = true;
        return commitPreparedFrame(imagesDir, manifest, prepared);
      },
    },
    manifest: buildingManifest(),
    run: async (command, args) => {
      if (command === "ffmpeg") {
        await writeFile(args.at(-1), "jpeg-bytes");
        await link(sourcePath, finalPath);
        return { code: 0, stdout: "", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ streams: [{ width: 1920, height: 1080 }] }),
        stderr: "",
      };
    },
    log: { info() {} },
  }), SourceError);

  assert.equal(committed, false);
  assert.equal(await readFile(sourcePath, "utf8"), "original-video-bytes");
  assert.equal(await readFile(finalPath, "utf8"), "original-video-bytes");
});

test("unsafe timestamp boundaries reject before runner and temp side effects", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const invalidCaptures = [
    capture({ requestedMs: -1 }),
    capture({ requestedMs: Number.MAX_SAFE_INTEGER + 1 }),
    capture({ timestampMs: -1 }),
    capture({ timestampMs: 1.5 }),
    capture({ timestampMs: Number.MAX_SAFE_INTEGER + 1 }),
  ];
  let sideEffects = 0;

  for (const planned of invalidCaptures) {
    await assert.rejects(extractFrames({
      videoPath: "/video.mov",
      captures: [planned],
      workspace: {
        imagesDir,
        canReuseFrame: async () => false,
        commitFrame: async () => {
          sideEffects += 1;
          throw new Error("must not commit invalid timestamps");
        },
      },
      manifest: buildingManifest(),
      run: async () => {
        sideEffects += 1;
        throw new Error("must not run invalid timestamps");
      },
      log: { info() {} },
    }), SourceError);
  }

  assert.equal(sideEffects, 0);
  assert.deepEqual(await readdir(imagesDir), []);
});

test("temp pathname replacement and symlink attacks preserve foreign paths and targets", async (t) => {
  for (const attackKind of ["replacement", "symlink"]) {
    const { root, imagesDir } = await frameFixture(t);
    const planned = capture({ filename: `000004250-${attackKind}.jpg` });
    const foreignTarget = path.join(root, `${attackKind}-foreign.jpg`);
    await writeFile(foreignTarget, "foreign-target");
    let attackedPath;

    await assert.rejects(extractFrames({
      videoPath: "/video.mov",
      captures: [planned],
      workspace: {
        imagesDir,
        canReuseFrame: async () => false,
        commitFrame: async () => { throw new Error("must not commit replaced temp"); },
      },
      manifest: buildingManifest(),
      run: async (command, args) => {
        assert.equal(command, "ffmpeg");
        attackedPath = args.at(-1);
        await unlink(attackedPath);
        if (attackKind === "symlink") {
          await symlink(foreignTarget, attackedPath);
        } else {
          await writeFile(attackedPath, "foreign-replacement");
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      log: { info() {} },
    }), SourceError);

    const attackedInfo = await lstat(attackedPath);
    assert.equal(attackedInfo.isSymbolicLink(), attackKind === "symlink");
    assert.equal(
      await readFile(attackedPath, "utf8"),
      attackKind === "symlink" ? "foreign-target" : "foreign-replacement",
    );
    assert.equal(await readFile(foreignTarget, "utf8"), "foreign-target");
  }
});

test("replacement of a private staging generation is rejected without deleting the replacement", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const planned = capture();
  let generationPath;
  let movedGenerationPath;

  await assert.rejects(extractFrames({
    videoPath: "/video.mov",
    captures: [planned],
    workspace: {
      imagesDir,
      canReuseFrame: async () => false,
      commitFrame: async () => { throw new Error("must not commit a replaced generation"); },
    },
    manifest: buildingManifest(),
    run: async (command, args) => {
      assert.equal(command, "ffmpeg");
      generationPath = path.dirname(args.at(-1));
      movedGenerationPath = `${generationPath}-moved`;
      await rename(generationPath, movedGenerationPath);
      await mkdir(generationPath);
      await writeFile(path.join(generationPath, "foreign.txt"), "foreign-generation");
      return { code: 0, stdout: "", stderr: "" };
    },
    log: { info() {} },
  }), SourceError);

  assert.equal(await readFile(path.join(generationPath, "foreign.txt"), "utf8"), "foreign-generation");
  assert.equal((await lstat(movedGenerationPath)).isDirectory(), true);
});

test("thrown FFmpeg and commit rename failures clean only the still-owned temp", async (t) => {
  for (const failureKind of ["runner", "rename"]) {
    const { imagesDir } = await frameFixture(t);
    const planned = capture({ filename: `000004250-${failureKind}.jpg` });
    let tempPath;
    const injected = Object.assign(new Error(`${failureKind} failed`), { code: "EIO" });

    await assert.rejects(extractFrames({
      videoPath: "/video.mov",
      captures: [planned],
      workspace: {
        imagesDir,
        canReuseFrame: async () => false,
        commitFrame: async (_manifest, prepared) => {
          tempPath = prepared.tempPath;
          throw injected;
        },
      },
      manifest: buildingManifest(),
      run: async (command, args) => {
        if (command === "ffmpeg") {
          tempPath = args.at(-1);
          if (failureKind === "runner") throw injected;
          await writeFile(tempPath, "jpeg-bytes");
          return { code: 0, stdout: "", stderr: "" };
        }
        return {
          code: 0,
          stdout: JSON.stringify({ streams: [{ width: 1920, height: 1080 }] }),
          stderr: "",
        };
      },
      log: { info() {} },
    }), SourceError);

    await assert.rejects(access(tempPath));
    await assert.rejects(access(path.join(imagesDir, planned.filename)));
  }
});

test("cleanup failure is reported without deleting or losing ownership of the reserved temp", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const planned = capture();
  const runnerFailure = new Error("runner failed");
  const cleanupFailure = new Error("cleanup failed");
  let tempPath;

  await assert.rejects(extractFrames({
    videoPath: "/video.mov",
    captures: [planned],
    workspace: {
      imagesDir,
      canReuseFrame: async () => false,
      commitFrame: async () => { throw new Error("must not commit failed extraction"); },
    },
    manifest: buildingManifest(),
    fileOps: {
      async unlink() {
        throw cleanupFailure;
      },
    },
    run: async (_command, args) => {
      tempPath = args.at(-1);
      throw runnerFailure;
    },
    log: { info() {} },
  }), (error) => error instanceof SourceError
    && error.cause instanceof AggregateError
    && error.cause.errors.some((cause) => cause === cleanupFailure)
    && error.cause.errors.some((cause) => cause.cause === runnerFailure));

  assert.equal((await lstat(tempPath)).isFile(), true);
});

test("initial frame-handle stat failure closes the handle and cleans only its private generation", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const planned = capture();
  const statFailure = new Error("initial handle stat failed");
  let closed = false;

  await assert.rejects(extractFrames({
    videoPath: "/video.mov",
    captures: [planned],
    workspace: {
      imagesDir,
      canReuseFrame: async () => false,
      commitFrame: async () => { throw new Error("must not commit failed reservation"); },
    },
    manifest: buildingManifest(),
    fileOps: {
      async open(filePath, flags, mode) {
        const handle = await open(filePath, flags, mode);
        if (path.extname(filePath) !== ".jpg") return handle;
        return {
          stat: async () => { throw statFailure; },
          async close() {
            await handle.close();
            closed = true;
          },
        };
      },
    },
    run: async () => { throw new Error("must not run after stat failure"); },
    log: { info() {} },
  }), (error) => error === statFailure || error.cause === statFailure);

  assert.equal(closed, true);
  assert.deepEqual(await readdir(imagesDir), []);
});

test("frame-handle close failure preserves the runner error and cleans the private generation", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const planned = capture();
  const runnerFailure = new Error("runner failed before close");
  const closeFailure = new Error("frame handle close failed");

  await assert.rejects(extractFrames({
    videoPath: "/video.mov",
    captures: [planned],
    workspace: {
      imagesDir,
      canReuseFrame: async () => false,
      commitFrame: async () => { throw new Error("must not commit runner failure"); },
    },
    manifest: buildingManifest(),
    fileOps: {
      async open(filePath, flags, mode) {
        const handle = await open(filePath, flags, mode);
        if (path.extname(filePath) !== ".jpg") return handle;
        return {
          stat: (...args) => handle.stat(...args),
          async close() {
            await handle.close();
            throw closeFailure;
          },
        };
      },
    },
    run: async () => { throw runnerFailure; },
    log: { info() {} },
  }), (error) => error instanceof SourceError
    && error.cause instanceof AggregateError
    && error.cause.errors.some((cause) => cause === closeFailure)
    && error.cause.errors.some((cause) => cause.cause === runnerFailure));

  assert.deepEqual(await readdir(imagesDir), []);
});

test("capture failures stop the sequential plan and never publish the failing frame", async (t) => {
  const { imagesDir } = await frameFixture(t);
  const first = capture();
  const second = capture({
    filename: "000008000-scene.jpg",
    requestedMs: 7750,
    timestampMs: 8000,
    reasons: ["scene"],
    associations: [{ segmentIndex: 1, requestedMs: 7750, reasons: ["scene"] }],
  });
  const third = capture({
    filename: "000009000-caption.jpg",
    requestedMs: 8750,
    timestampMs: 9000,
    reasons: ["caption"],
    associations: [{ segmentIndex: 1, requestedMs: 8750, reasons: ["caption"] }],
  });
  const attempted = [];
  const workspace = {
    imagesDir,
    canReuseFrame: async () => false,
    commitFrame: async (manifest, prepared) => commitPreparedFrame(imagesDir, manifest, prepared),
  };

  await assert.rejects(extractFrames({
    videoPath: "/video.mov",
    captures: [third, first, second],
    workspace,
    manifest: buildingManifest(),
    run: async (command, args) => {
      if (command === "ffprobe") {
        return {
          code: 0,
          stdout: JSON.stringify({ streams: [{ width: 640, height: 360 }] }),
          stderr: "",
        };
      }
      attempted.push(path.basename(args.at(-1)).split(".part-")[0]);
      if (attempted.length === 2) return { code: 1, stdout: "", stderr: "failed" };
      await writeFile(args.at(-1), "jpeg-bytes");
      return { code: 0, stdout: "", stderr: "" };
    },
    log: { info() {} },
  }), SourceError);

  assert.deepEqual(attempted, ["000004250-primary.jpg", "000008000-scene.jpg"]);
  assert.equal(await readFile(path.join(imagesDir, first.filename), "utf8"), "jpeg-bytes");
  await assert.rejects(access(path.join(imagesDir, second.filename)));
  await assert.rejects(access(path.join(imagesDir, third.filename)));
});

test("extraction rejects unsafe filenames and complete manifests before writing", async (t) => {
  const { root, imagesDir } = await frameFixture(t);
  const outsidePath = path.join(root, "outside.jpg");
  const workspace = {
    imagesDir,
    canReuseFrame: async () => false,
    commitFrame: async () => { throw new Error("must not commit rejected captures"); },
  };
  const run = async () => { throw new Error("must not run for rejected captures"); };

  await assert.rejects(extractFrames({
    videoPath: "/video.mov",
    captures: [capture({ filename: "../outside.jpg" })],
    workspace,
    manifest: buildingManifest(),
    run,
    log: { info() {} },
  }), SourceError);
  await assert.rejects(extractFrames({
    videoPath: "/video.mov",
    captures: [capture()],
    workspace,
    manifest: { ...buildingManifest(), status: "complete" },
    run,
    log: { info() {} },
  }), SourceError);
  await assert.rejects(access(outsidePath));
  assert.deepEqual(await readdir(imagesDir), []);
});

test("frame extraction never mutates the local video", async (t) => {
  const { root, imagesDir } = await frameFixture(t);
  const videoPath = path.join(root, "local-video.mov");
  await writeFile(videoPath, "original-video-bytes");
  const planned = capture();
  await extractFrames({
    videoPath,
    captures: [planned],
    workspace: {
      imagesDir,
      canReuseFrame: async () => false,
      commitFrame: async (manifest, prepared) => commitPreparedFrame(imagesDir, manifest, prepared),
    },
    manifest: buildingManifest(),
    run: successfulRun(),
    log: { info() {} },
  });

  assert.equal(await readFile(videoPath, "utf8"), "original-video-bytes");
});
