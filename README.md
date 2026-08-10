# v2w

`v2w` turns a YouTube video or a local video file into a standalone transcript
webpage with native-resolution screenshots.

```text
v2w <youtube-url-or-local-file> [--output <directory>]
```

The page's displayed prose comes exclusively from a timed Whisper VTT. YouTube
captions, embedded subtitles, and local sidecars are optional timing hints for
screenshot selection; their words never become the displayed transcript.

## Requirements

- Node.js 20 or newer.
- FFmpeg and FFprobe for both input modes.
- A timed Whisper engine:
  - primary: `mlx_whisper`, using exactly
    `mlx-community/whisper-large-v3-turbo`; or
  - fallback: `whisper-cli` plus
    `${XDG_CACHE_HOME:-$HOME/.cache}/v2w/models/ggml-large-v3-turbo.bin`.
- `yt-dlp` for YouTube URLs only. Local-file mode does not use or require
  `yt-dlp`.

For example, on macOS:

```sh
brew install node ffmpeg
uv tool install mlx-whisper
# Only if processing YouTube URLs:
brew install yt-dlp
```

MLX Whisper downloads `mlx-community/whisper-large-v3-turbo` on its first
transcription and reuses it from the Hugging Face cache (`$HF_HOME`, normally
`$HOME/.cache/huggingface`). For the optional whisper.cpp fallback, put the
`ggml-large-v3-turbo.bin` model at the exact XDG-aware path above and ensure the
`whisper-cli` executable is on `PATH`.

## Install

From this checkout:

```sh
npm link
command -v v2w
v2w --help
```

The help output is:

```text
Usage: v2w <youtube-url-or-local-file> [--output <directory>]
```

`npm link` installs a global command that points to the current checkout, so
later edits in the checkout are immediately reflected in `v2w`.

## Use

YouTube mode accepts `youtube.com` and `youtu.be` URLs:

```sh
v2w "https://www.youtube.com/watch?v=jNQXAC9IVRw"
v2w "https://youtu.be/jNQXAC9IVRw" --output first-youtube-video
```

Local mode accepts any regular video file FFmpeg can read:

```sh
v2w "/Users/me/Videos/lecture.mov"
v2w ./demo.mp4 --output demo-notes
```

Generic remote URLs such as `https://example.com/video.mp4` are rejected. The
only supported remote source is YouTube.

When `--output` is omitted, `v2w` derives a safe directory name from the
YouTube title or local filename. A local video is a protected, read-only input:
`v2w` never moves, changes, truncates, or deletes it. A neighboring
`<basename>.vtt` or `<basename>.srt` sidecar is protected the same way.

## What it writes

```text
output-directory/
├── index.html
├── styles.css
├── transcript.vtt
├── manifest.json
└── images/
    ├── 000002000-caption.jpg
    ├── 000004000-primary.jpg
    └── 000005000-scene.jpg
```

The final output contains no source video, extracted audio, partial file,
staging directory, or retention data. `index.html` displays the Whisper
segments from `transcript.vtt`; `styles.css` makes the result browsable without
the CLI. YouTube timestamps link back to the source. Local timestamps are text
because the source file is deliberately not copied.

Every Whisper segment has a required `primary` screenshot. Caption timing and
scene changes may add supplementary screenshots. Screenshots retain the source
video's native dimensions and aspect ratio and are encoded by FFmpeg as JPEGs
with `-q:v 2` and no scaling. If candidates resolve to the exact same decoded
frame, one physical JPEG can serve multiple segment associations; the HTML may
therefore refer to that JPEG more than once.

`manifest.json` is the machine-readable completion and resume record. It holds
the source fingerprint, Whisper engine, transcript segments, physical image
dimensions and filenames, and each image's per-segment associations and
reasons. `status: "complete"` is the durable completion marker.

Audit one or more completed outputs with:

```sh
node scripts/verify-output.mjs output-directory another-output
```

The auditor requires complete primary coverage, nonempty page assets and
JPEGs, positive image dimensions, exact agreement among the manifest, HTML
references, and physical image inventory, contained paths, and no media,
audio, staging, partial, or retention artifacts below the output directory.

## Captions and transcript provenance

Whisper VTT is authoritative in both modes. For YouTube, `yt-dlp` attempts to
fetch English manual or automatic captions. For local files, `v2w` looks for
`<basename>.vtt`, then `<basename>.srt`, then an embedded subtitle stream.
Missing or unreadable captions are nonfatal: the run simply has fewer optional
timing hints. Caption cue text is never a transcription fallback and is never
rendered as page prose.

## Cache, resume, and retention

Run state lives at:

```text
${XDG_CACHE_HOME:-$HOME/.cache}/v2w/<source-fingerprint>/
```

The fingerprint is based on the YouTube video identity for URLs and on the
resolved path, size, and modification time for local files. Interrupted runs
can reuse validated transcript and frame work from this cache. A matching
`v2w` manifest resumes safely; an existing nonempty output without a manifest,
or a manifest for a different source, is rejected rather than overwritten.

A matching completed output is read-only on rerun: `v2w` validates and returns
it without retranscribing or rewriting its page assets. `index.html` alone is
not proof of completion; check the manifest's status.

Local mode uses protected publication retention directories so an output or
cache destination can never be confused with the source video or sidecar.
They are outside the final output: a `.v2w-retention-<key>` sibling beside the
output and another inside the fingerprint cache. Protected local cleanup may
also retain diagnostic intermediates and print a warning when safe atomic
removal cannot be proved. `v2w` intentionally performs no automatic garbage
collection of protected retention data. Review and remove such data manually
only after no run is active and it is no longer needed for diagnosis.

## Troubleshooting

**A dependency is missing.** FFmpeg and FFprobe are always required. Install
`yt-dlp` only for URL mode. Confirm the commands with `command -v ffmpeg`,
`command -v ffprobe`, `command -v mlx_whisper`, and, when applicable,
`command -v yt-dlp` or `command -v whisper-cli`.

**The model downloads or cannot be found.** A first MLX run downloads
`mlx-community/whisper-large-v3-turbo`; allow time and network access, and
check the Hugging Face cache. The whisper.cpp fallback is considered ready
only when `whisper-cli` is on `PATH` and a nonempty model exists at
`${XDG_CACHE_HOME:-$HOME/.cache}/v2w/models/ggml-large-v3-turbo.bin`.

**The video has no audio.** `v2w` requires a positive-duration video with a
video stream and an audio stream. Add or select a source with usable audio;
caption text cannot replace speech transcription.

**Transcript quality fails.** MLX retries degraded repetition or segmentation
with previous-text conditioning disabled. If every Whisper attempt still
fails the quality gate, the command exits nonzero and does not mark the output
complete. Keep the cache and retention diagnostics when investigating.

**No captions were found.** This is expected for many sources. Primary
screenshots and Whisper prose are unaffected; only caption-suggested
supplementary screenshots are absent.

**The output conflicts.** Choose a new `--output` directory, or resume only
with the existing matching `v2w` manifest. The CLI refuses to mix results with
foreign files or a different source. Do not place the output inside the `v2w`
cache, or the cache inside the output.

## Test

The automated suite uses Node's built-in test runner and does not download a
model or call YouTube:

```sh
npm test
```

To test a completed real run, use `scripts/verify-output.mjs` as shown above.

## Legacy script

`yt-to-webpage.pl` remains in the repository for historical reference. It is
the old YouTube-caption workflow, is not the primary interface, and does not
implement the `v2w` Whisper-only transcript, local-file, immutable-input,
native screenshot, manifest, resume, or final-inventory contract documented
here.
