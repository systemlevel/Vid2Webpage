import assert from "node:assert/strict";
import test from "node:test";

import {
  detectSceneChanges,
  listFrameTimestamps,
  parseSceneTimes,
} from "../src/visual-timing.mjs";

test("parses FFmpeg showinfo scene timestamps", () => {
  assert.deepEqual(
    parseSceneTimes("showinfo n:1 pts:100 pts_time:2.004\nshowinfo n:2 pts_time:4.125"),
    [2004, 4125]
  );
});

test("sorts rounded scene times and removes only exact millisecond duplicates", () => {
  assert.deepEqual(
    parseSceneTimes([
      "showinfo pts_time:4.1254",
      "showinfo pts_time:2.004",
      "showinfo pts_time:4.12549",
      "showinfo pts_time:N/A",
    ].join("\n")),
    [2004, 4125]
  );
});

test("builds scene and frame timestamp commands", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (command === "ffmpeg") {
      return { code: 0, stdout: "", stderr: "showinfo pts_time:2.0" };
    }
    return { code: 0, stdout: "0.000000\n0.100000\n2.000000\n", stderr: "" };
  };
  assert.deepEqual(await detectSceneChanges("/video.mp4", { run }), [2000]);
  assert.deepEqual(await listFrameTimestamps("/video.mp4", { run }), [0, 100, 2000]);
  assert.deepEqual(calls, [
    {
      command: "ffmpeg",
      args: [
        "-hide_banner",
        "-i", "/video.mp4",
        "-filter:v", "select=gt(scene\\,0.30),showinfo",
        "-an",
        "-f", "null",
        "-",
      ],
    },
    {
      command: "ffprobe",
      args: [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_frames",
        "-show_entries", "frame=best_effort_timestamp_time",
        "-of", "csv=p=0",
        "/video.mp4",
      ],
    },
  ]);
});

test("treats failed scene detection as fatal", async () => {
  await assert.rejects(
    detectSceneChanges("/broken.mp4", {
      run: async () => ({ code: 1, stdout: "", stderr: "decode failed" }),
    }),
    /scene changes/i
  );
});

test("rejects failed frame timestamp discovery", async () => {
  await assert.rejects(
    listFrameTimestamps("/broken.mp4", {
      run: async () => ({ code: 1, stdout: "", stderr: "probe failed" }),
    }),
    /frame timestamps/i
  );
});

test("rejects an empty decoded frame list", async () => {
  await assert.rejects(
    listFrameTimestamps("/empty.mp4", {
      run: async () => ({ code: 0, stdout: "N/A\n", stderr: "" }),
    }),
    /no decoded frame timestamps/i
  );
});

test("sorts, rounds, and exactly deduplicates decoded frame timestamps", async () => {
  assert.deepEqual(
    await listFrameTimestamps("/video.mp4", {
      run: async () => ({
        code: 0,
        stdout: "2.0004\n0.1004\n0.10049\nN/A\n",
        stderr: "",
      }),
    }),
    [100, 2000]
  );
});
