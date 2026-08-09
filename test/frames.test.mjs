import assert from "node:assert/strict";
import {
  access,
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
    recordFrame: async (manifest, frame) => {
      recorded.push(structuredClone(frame));
      return {
        ...manifest,
        revision: manifest.revision + 1,
        images: [...manifest.images, frame],
      };
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
    recordFrame: async (manifest, frame) => {
      recordInputs.push({ revision: manifest.revision, timestampMs: frame.timestampMs });
      return {
        ...manifest,
        revision: manifest.revision + 1,
        images: [...manifest.images, frame],
      };
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
      recordFrame: async () => { throw new Error("must not record a reused frame"); },
    },
    manifest,
    run: async () => { throw new Error("must not invoke FFmpeg for a reused frame"); },
    log: { info() {} },
  });

  assert.equal(result, manifest);
  assert.deepEqual(reuseChecks, [existing]);
  assert.equal(await readFile(path.join(imagesDir, planned.filename), "utf8"), "existing-jpeg");
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
      recordFrame: async (manifest, frame) => {
        recorded = frame;
        return { ...manifest, revision: 2, images: [frame] };
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
      recordFrame: async () => { throw new Error("must not record failed output"); },
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
      recordFrame: async () => { throw new Error("must not record empty output"); },
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
      recordFrame: async () => { throw new Error("must not record invalid dimensions"); },
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
    recordFrame: async (manifest, frame) => ({ ...manifest, revision: 1, images: [frame] }),
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
    assert.equal(path.dirname(tempPath), imagesDir);
    assert.match(path.basename(tempPath), /^000004250-primary\.part-\d+-[0-9a-f-]+\.jpg$/u);
    await assert.rejects(access(tempPath));
  }
  assert.equal(await readFile(foreignPath, "utf8"), "foreign-temp");
  assert.equal(await readFile(path.join(imagesDir, planned.filename), "utf8"), "winner-jpeg");
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
    recordFrame: async (manifest, frame) => ({
      ...manifest,
      revision: manifest.revision + 1,
      images: [...manifest.images, frame],
    }),
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

  assert.deepEqual(attempted, ["000004250-primary", "000008000-scene"]);
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
    recordFrame: async () => { throw new Error("must not record rejected captures"); },
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
      recordFrame: async (manifest, frame) => ({ ...manifest, revision: 1, images: [frame] }),
    },
    manifest: buildingManifest(),
    run: successfulRun(),
    log: { info() {} },
  });

  assert.equal(await readFile(videoPath, "utf8"), "original-video-bytes");
});
