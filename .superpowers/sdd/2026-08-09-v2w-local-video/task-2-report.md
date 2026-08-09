# Task 2 report: classify sources and compute stable fingerprints

## Changes

- Added `src/source.mjs` with explicit YouTube-host URL classification and local-file classification.
- Local sources resolve against the supplied `cwd`, require a regular file, and expose `{ size, mtimeMs }` from `stat`.
- Unsupported remote URLs, missing local paths, and directories throw `SourceError`.
- Added NUL-delimited SHA-256 fingerprints for local source identity and YouTube video IDs.
- Added `test/source.test.mjs` covering local/YouTube classification, invalid sources, deterministic fingerprints, and source-specific YouTube fingerprints.

## TDD evidence

1. RED setup: after writing tests, `node --test test/source.test.mjs` failed with `ERR_MODULE_NOT_FOUND` for `src/source.mjs` (module-resolution failure, explicitly not treated as behavioral RED).
2. Minimal export scaffolding was added, then the same focused command failed with three behavioral test failures: `classifySource` and fingerprint functions reported `Error: not implemented`; the invalid-source assertion also showed the wrong error type instead of `SourceError`.
3. GREEN implementation was added from the task brief. `node --test test/source.test.mjs` passed: 3 tests, 3 pass, 0 fail.

## Verification

- Focused: `node --test test/source.test.mjs` — 3 passed, 0 failed.
- Full: `npm test` — 6 passed, 0 failed.
- `git diff --check` — clean.

## Self-review

- Scope is limited to the requested source module and tests.
- Classification performs read-only filesystem `stat`; it does not read, mutate, or execute local video content.
- URL validation is restricted to `http:`/`https:` and the five hosts specified in the brief.
- Fingerprints include explicit source-kind prefixes and NUL separators, making local and YouTube identities deterministic and distinct.

## Concerns

- The brief does not require validating YouTube path/query shape or extracting a video ID from a URL; classification therefore preserves the normalized URL and leaves ID handling to callers.
