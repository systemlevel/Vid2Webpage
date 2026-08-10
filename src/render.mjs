import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  copyFileAtomic,
  isPublicationExpectation,
  writeFileAtomic,
} from "./fs.mjs";
import { formatVttTimestamp } from "./vtt.mjs";

const pageCssPath = fileURLToPath(new URL("./page.css", import.meta.url));

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[character]));
}

function timestampSeconds(timestampMs) {
  if (!Number.isFinite(timestampMs) || timestampMs < 0) {
    throw new RangeError("Timestamp must be a finite, non-negative number");
  }
  return Math.floor(timestampMs / 1_000);
}

export function youtubeTimestampUrl(url, timestampMs) {
  const timestamped = safeHttpUrl(url);
  timestamped.searchParams.set("t", String(timestampSeconds(timestampMs)));
  return timestamped.toString();
}

function safeHttpUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("Source URL must use HTTP or HTTPS");
  }
  return parsed;
}

function assertSafeImageFilename(filename) {
  if (typeof filename !== "string" || filename.length === 0 || path.isAbsolute(filename)
    || filename === "." || filename === ".." || filename !== path.basename(filename)
    || filename.includes("/") || filename.includes("\\")) {
    throw new TypeError(`Unsafe manifest image filename: ${filename}`);
  }
  return filename;
}

function safeImagePath(filename) {
  assertSafeImageFilename(filename);
  return `images/${encodeURIComponent(filename)}`;
}

function positiveInteger(value, description) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${description} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value, description) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${description} must be a non-negative integer`);
  }
  return value;
}

function isoDuration(timestampMs) {
  const totalMs = Math.floor(timestampMs);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = (totalMs % 60_000) / 1_000;
  const secondsText = Number.isInteger(seconds)
    ? String(seconds)
    : seconds.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
  return `PT${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}${secondsText}S`;
}

function timestampMarkup(source, timestampMs) {
  const display = formatVttTimestamp(timestampMs);
  if (source?.kind === "youtube" && typeof source.webpageUrl === "string") {
    return `<a class="timestamp" href="${escapeHtml(youtubeTimestampUrl(source.webpageUrl, timestampMs))}">${display}</a>`;
  }
  return `<time datetime="${isoDuration(timestampMs)}">${display}</time>`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function renderPublicationFromLease(lease) {
  const publication = lease?.publication;
  const protectedFiles = publication?.protectedFiles;
  const protectedMode = Array.isArray(protectedFiles) && protectedFiles.length > 0;
  const targets = publication?.targets;
  const targetValues = [targets?.transcript, targets?.stylesheet, targets?.html];
  const validTarget = (target) => isPlainObject(target)
    && Object.isFrozen(target)
    && typeof target.path === "string"
    && target.path.length > 0
    && (protectedMode
      ? isPublicationExpectation(target.expectedDestination)
      : target.expectedDestination === undefined);
  if (!isPlainObject(lease)
    || !Object.isFrozen(lease)
    || !isPlainObject(publication)
    || !Object.isFrozen(publication)
    || !Array.isArray(protectedFiles)
    || !Object.isFrozen(protectedFiles)
    || protectedFiles.some((protectedFile) =>
      !isPlainObject(protectedFile)
      || !Object.isFrozen(protectedFile)
      || !isPlainObject(protectedFile.identity)
      || !Object.isFrozen(protectedFile.identity))
    || !isPlainObject(targets)
    || !Object.isFrozen(targets)
    || targetValues.some((target) => !validTarget(target))
    || (protectedMode
      ? typeof publication.retentionDir !== "string" || publication.retentionDir.length === 0
      : publication.retentionDir !== undefined)) {
    throw new TypeError("Render lease publication context is invalid");
  }
  return publication;
}

function validateRenderImages(images, segmentCount) {
  if (!Array.isArray(images)) {
    throw new TypeError("Manifest images must be an array");
  }
  for (const image of images) {
    if (!isPlainObject(image)) throw new TypeError("Frame record must be an object");
    assertSafeImageFilename(image.filename);
    nonNegativeInteger(image.timestampMs, "Frame timestamp");
    positiveInteger(image.width, "Frame width");
    positiveInteger(image.height, "Frame height");
    if (!Array.isArray(image.associations) || image.associations.length === 0) {
      throw new TypeError("Frame record must include associations");
    }
    const associatedSegments = new Set();
    for (const association of image.associations) {
      if (!isPlainObject(association)
        || Object.keys(association).length !== 3
        || !Object.hasOwn(association, "segmentIndex")
        || !Object.hasOwn(association, "requestedMs")
        || !Object.hasOwn(association, "reasons")
        || !Number.isSafeInteger(association.segmentIndex)
        || association.segmentIndex < 0
        || association.segmentIndex >= segmentCount
        || !Number.isSafeInteger(association.requestedMs)
        || association.requestedMs < 0
        || !Array.isArray(association.reasons)
        || association.reasons.length === 0
        || association.reasons.some((reason) => typeof reason !== "string")) {
        throw new TypeError("Frame association is invalid");
      }
      if (associatedSegments.has(association.segmentIndex)) {
        throw new TypeError("Frame associations must contain each segment only once");
      }
      associatedSegments.add(association.segmentIndex);
    }
  }
}

function segmentGalleries(images, segmentCount) {
  const galleries = Array.from({ length: segmentCount }, () => new Map());
  for (const image of images) {
    for (const association of image.associations) {
      const index = association.segmentIndex;
      const existing = galleries[index].get(image.filename);
      const reasons = new Set([...(existing?.reasons ?? []), ...(association.reasons ?? [])]);
      galleries[index].set(image.filename, { image, reasons: [...reasons] });
    }
  }
  return galleries.map((gallery) => [...gallery.values()].sort((left, right) =>
    left.image.timestampMs - right.image.timestampMs
      || left.image.filename.localeCompare(right.image.filename)));
}

function frameMarkup({ image, reasons }, source) {
  const imagePath = safeImagePath(image.filename);
  const timestampMs = nonNegativeInteger(image.timestampMs, "Frame timestamp");
  const width = positiveInteger(image.width, "Frame width");
  const height = positiveInteger(image.height, "Frame height");
  const labels = reasons.map((reason) => `<span class="reason">${escapeHtml(reason)}</span>`).join("");
  return `<figure class="frame-card">
  <a class="frame" href="${escapeHtml(imagePath)}">
    <img src="${escapeHtml(imagePath)}" width="${width}" height="${height}" loading="lazy" alt="Frame at ${formatVttTimestamp(timestampMs)}">
  </a>
  <figcaption>${timestampMarkup(source, timestampMs)}${labels ? `<span class="reasons">${labels}</span>` : ""}</figcaption>
</figure>`;
}

function sourceMarkup(source) {
  const title = sourceTitle(source);
  if (source?.kind === "youtube" && typeof source.webpageUrl === "string") {
    return `<a class="source-link" href="${escapeHtml(safeHttpUrl(source.webpageUrl).toString())}">${title}</a>`;
  }
  return title;
}

function sourceTitle(source) {
  return escapeHtml(source?.title || source?.fingerprint || "Untitled source");
}

export function renderPage({ manifest, segments }) {
  const transcriptSegments = Array.isArray(segments) ? segments : [];
  const source = manifest?.source ?? {};
  const images = manifest?.images ?? [];
  validateRenderImages(images, transcriptSegments.length);
  const galleries = segmentGalleries(images, transcriptSegments.length);
  const physicalCount = images.length;
  const engine = escapeHtml(manifest?.transcript?.engine);
  const articles = transcriptSegments.map((segment, index) => {
    const startMs = nonNegativeInteger(segment?.startMs, "Segment start");
    const endMs = nonNegativeInteger(segment?.endMs, "Segment end");
    const gallery = galleries[index].map((frame) => frameMarkup(frame, source)).join("\n");
    return `<article class="segment">
  <header class="segment-header">${timestampMarkup(source, startMs)}<span class="segment-end">– ${timestampMarkup(source, endMs)}</span></header>
  <p>${escapeHtml(segment?.text)}</p>${gallery ? `
  <div class="gallery">${gallery}</div>` : ""}
</article>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${sourceTitle(source)}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main>
    <header class="page-header">
      <p class="eyebrow">Transcript and screenshots</p>
      <h1>${sourceMarkup(source)}</h1>
      <p class="metadata"><span>${engine}</span><span>${physicalCount} screenshot${physicalCount === 1 ? "" : "s"}</span></p>
    </header>
    <section class="transcript" aria-label="Transcript">${articles}</section>
  </main>
</body>
</html>
`;
}

export async function renderOutput({
  workspace,
  manifest,
  segments,
  transcriptVttPath,
  fileOps,
}) {
  const renderManifest = {
    ...manifest,
    transcript: { ...manifest.transcript, filename: "transcript.vtt" },
    segments: [...segments],
  };
  return workspace.withRenderLease(renderManifest, async (lease) => {
    const publication = renderPublicationFromLease(lease);
    const { protectedFiles, retentionDir, targets } = publication;
    const buildingManifest = {
      ...lease.manifest,
      transcript: renderManifest.transcript,
      segments: renderManifest.segments,
    };

    const publicationOptions = {
      protectedFiles,
      retentionDir,
      fileOps,
    };
    await copyFileAtomic(transcriptVttPath, targets.transcript.path, {
      ...publicationOptions,
      expectedDestination: targets.transcript.expectedDestination,
    });
    await copyFileAtomic(pageCssPath, targets.stylesheet.path, {
      ...publicationOptions,
      expectedDestination: targets.stylesheet.expectedDestination,
    });
    const savedManifest = await lease.saveManifest(buildingManifest);
    await writeFileAtomic(
      targets.html.path,
      renderPage({ manifest: savedManifest, segments }),
      { ...publicationOptions, expectedDestination: targets.html.expectedDestination },
    );
    return lease.markComplete(savedManifest);
  }, { expectedManifest: manifest });
}
