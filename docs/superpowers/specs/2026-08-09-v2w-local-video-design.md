# v2w: URL and Local Video to Webpage

**Date:** 2026-08-09
**Status:** Approved

## Goal

Replace the YouTube-only primary CLI with a `v2w` command that accepts either
a YouTube URL or any local video container FFmpeg can read, transcribes the
spoken content, and produces a browsable transcript paired with
native-resolution screenshots.

The displayed text must always come from Whisper transcription. YouTube,
embedded, or sidecar captions may improve screenshot timing, but caption text
must never replace the Whisper transcript.

## User Experience

```sh
v2w <youtube-url-or-local-file> [--output <directory>]
```

When `--output` is omitted, `v2w` derives a filesystem-safe directory name from
the YouTube title or local filename. A local source is read-only: `v2w` never
moves, changes, or deletes it.

Examples:

```sh
v2w "https://www.youtube.com/watch?v=jNQXAC9IVRw"
v2w "/Users/me/Videos/lecture.mov"
v2w ./demo.mp4 --output demo-notes
```

The supported remote source in this version is YouTube. Generic HTTP media
URLs are out of scope.

## Output

```text
output-name/
├── index.html
├── styles.css
├── transcript.vtt
├── manifest.json
└── images/
    ├── 000002000-caption.jpg
    ├── 000004000-primary.jpg
    └── 000005000-scene.jpg
```

The final output contains no video or audio file. Each transcript segment in
`index.html` contains:

- Whisper-authored text and its timestamp;
- one required screenshot from the segment midpoint; and
- zero or more supplementary screenshots suggested by captions or scene
  changes.

Page thumbnails link to the native-resolution images. For YouTube sources, the
page also links each timestamp back to the source video. A local source shows
the timestamp as text because the video is intentionally not copied.

`manifest.json` makes coverage auditable and resumable. It records a schema
version, source identity and fingerprint, duration, transcription model and
engine, transcript segments, screenshot timestamp and filename, owning
segment, and every reason that caused the screenshot to be captured.

## Architecture

The new implementation is a self-contained Node 20+ ESM CLI. It does not
import Lakefront or depend on Lakefront being installed at a fixed path. It
ports and adapts the proven transcription and quality logic from Lakefront's
`yt-intake` pipeline.

The repository exposes `v2w` through the root package's `bin` field. The legacy
Perl script remains available for historical reference during this change but
is not the primary interface.

Modules have narrow responsibilities:

1. **CLI** — parse arguments, print progress, select the output, and map errors
   to a nonzero exit status.
2. **Source** — classify YouTube versus local input, obtain metadata, validate
   local media with FFprobe, and download URL media and captions with `yt-dlp`.
3. **Media** — extract temporary audio, inspect video timing and dimensions,
   discover embedded subtitle streams, and invoke FFmpeg scene detection.
4. **Transcription** — run the Whisper engine cascade and produce timed VTT.
5. **Quality** — detect repetition loops and segmentation collapse and select
   or reject retry output.
6. **Timeline** — parse timed transcript/caption cues, merge visual timing
   signals, coalesce candidates that resolve to the same decoded video frame,
   and associate every screenshot with a transcript segment.
7. **Frames** — extract native-resolution screenshots atomically with FFmpeg.
8. **Render** — safely generate HTML, CSS, VTT, and the resumable manifest.

External processes are invoked with argument arrays, never interpolated shell
commands.

## Source Acquisition

### YouTube URL

`yt-dlp` downloads the best usable video/audio combination into the run cache.
It also requests English manual and automatic captions when available.
Caption absence or download failure does not block transcription; it only
removes one optional screenshot-timing signal.

### Local Video

The path is resolved absolutely and checked for a readable regular file.
FFprobe must report a positive duration and at least one usable audio stream.
The video itself stays in place. When an embedded subtitle stream can be
converted to VTT, its cue times become optional screenshot-timing hints.

For sidecar timing, `v2w` looks beside the video for `<basename>.vtt`, then
`<basename>.srt` if no VTT exists. SRT timing is converted internally to VTT.
A sidecar's text is not displayed.

## Transcription

FFmpeg extracts 128 kbps AAC audio for transcription. The engine cascade is:

1. `mlx_whisper` with `mlx-community/whisper-large-v3-turbo`;
2. retry MLX Whisper with previous-text conditioning disabled when a repetition
   loop or segmentation collapse is detected; and
3. `whisper-cli` with
   `${XDG_CACHE_HOME:-~/.cache}/v2w/models/ggml-large-v3-turbo.bin` when MLX is
   absent or fails.

Unlike the original `yt-intake` URL flow, captions are not a text fallback.
If every Whisper engine fails, `v2w` fails.

The selected engine must emit timed VTT. The vocabulary prompt mechanism and
the repetition/fragmentation detectors are adapted from `yt-intake`. If both
the first pass and retry remain degraded, `v2w` retains the diagnostic
artifacts but stops before marking the page complete. Accuracy failures are not
silently published.

## Screenshot Timeline

Whisper VTT is the authoritative transcript timeline. For every Whisper
segment, `v2w` creates a required capture candidate at the segment midpoint.
This screenshot cannot be removed or replaced by another timing signal.

Two optional sources add candidates:

- the midpoint of each available YouTube, embedded, or sidecar caption cue;
- each significant visual change reported by FFmpeg scene detection.

A scene-change candidate is placed 250 milliseconds after a cut detected with
FFmpeg's `scene` score threshold of `0.30`, capped before the next cut or the
end of the video. This favors the newly established scene rather than a
transition frame. The threshold is tested against synthetic hard cuts. Tuning
it from the CLI is out of scope for the first version.

Candidate timestamps are canonicalized against decoded frame presentation
timestamps, including for variable-frame-rate media. Candidates that resolve
to the exact same decoded source frame share one image file and preserve all
reasons in the manifest. No perceptual or similarity deduplication is
performed; visually distinct frames must not disappear merely because they
look alike.

Each saved frame belongs to the Whisper segment containing its timestamp. A
frame falling in a gap between segments attaches to the nearest segment. A
segment may therefore display multiple screenshots in chronological order.

Images use millisecond timestamp filenames and FFmpeg JPEG quality `-q:v 2`
without a scale filter. They preserve the source video's native dimensions and
aspect ratio. The filename suffix uses deterministic reason priority
`primary`, then `scene`, then `caption`; the manifest retains every reason when
one frame satisfies several signals.

## Resumability and Atomic Writes

Intermediates live under `${XDG_CACHE_HOME:-~/.cache}/v2w/<source-fingerprint>`.
The fingerprint uses the YouTube video identity for URLs and the resolved path,
size, and modification time for local files.

Downloaded media, extracted audio, engine output, caption timing data, scene
timestamps, and partial diagnostics can be reused after interruption. A
successful run removes temporary downloaded media and audio while retaining
the small metadata necessary to recognize completed work.

Final VTT, manifest, HTML, and each image are written to a temporary sibling
and renamed into place only after the write succeeds. An existing output with
a matching source manifest resumes and skips validated artifacts. An existing
output without a `v2w` manifest, or with a different source fingerprint, is
rejected rather than overwritten or mixed.

`index.html` is written last. Its presence therefore never serves as proof of
completion until the manifest also records a complete run.

## Failure Behavior

The CLI performs an up-front dependency check:

- FFmpeg and FFprobe are required for every source;
- MLX Whisper or a configured whisper.cpp fallback is required for
  transcription; and
- `yt-dlp` is additionally required for YouTube input.

Missing commands produce actionable installation messages. Other fatal
conditions include unreadable input, a video with no usable audio, invalid
duration, complete transcription failure, a surviving transcript quality
failure, any required screenshot that cannot be created, and unsafe output
directory reuse.

On failure, `v2w` exits nonzero, never deletes a local source, leaves completed
work available for resumption, and does not label a partial page complete.

Transcript and metadata strings are HTML-escaped during rendering. Media paths
and URLs are always passed as process arguments rather than shell text.

## Testing

The root package uses Node's built-in test runner. The test suite includes:

- argument parsing, default slugging, and URL/local source classification;
- local validation and actionable missing-dependency errors;
- Whisper argument construction and engine fallback behavior;
- repetition-loop and segmentation-collapse detection and retry selection;
- VTT parsing, caption timing extraction, and HTML escaping;
- required midpoint generation, scene/caption candidate merging, exact-frame
  coalescing, gap association, stable ordering, and unique filenames;
- matching-manifest resume and mismatched-output refusal;
- injected-process integration tests for complete URL and local-file flows;
- an FFmpeg-generated fixture with hard scene cuts to verify scene timestamps,
  native screenshot dimensions, nonempty unique files, and complete HTML image
  references; and
- manual end-to-end smoke tests using one short YouTube video and one local
  video through MLX Whisper.

Tests do not download a model or call YouTube in normal automated runs.

## Documentation and Installation

The README is updated around the `v2w` command and documents Node 20+, FFmpeg,
`yt-dlp` for URL inputs, MLX Whisper as the primary engine, the optional
whisper.cpp fallback, installation with `npm link`, supported inputs, output
structure, cache behavior, and troubleshooting.

## Out of Scope

- The unfinished Electron interface.
- Generic non-YouTube remote media URLs.
- Copying or embedding the source video in the output.
- Caption-derived displayed text.
- Cloud transcription services or remote model APIs.
- Semantic image selection with a vision model.
- Translation, diarization, or speaker attribution.
- Perceptual screenshot deduplication.

## Acceptance Criteria

1. `v2w` accepts both a YouTube URL and a readable local video path.
2. Both input types are transcribed through Whisper into timed VTT.
3. Every transcript segment has a native-resolution midpoint screenshot.
4. Caption hints and scene changes can add screenshots without replacing a
   segment's required image.
5. The page displays only Whisper-authored transcript text.
6. Every HTML image reference resolves to a nonempty native-resolution file.
7. The manifest explains why each image exists and supports safe resumption.
8. Local source files remain byte-for-byte untouched.
9. Degraded or failed transcription never produces a falsely complete page.
10. Automated tests pass, and URL and local manual smoke tests both produce a
    complete browsable page.
