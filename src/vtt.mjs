const TIMING = /^(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})/;
const ENTITY = /&(?:amp|lt|gt|quot|apos|#39|nbsp);/g;
const SKIPPED_BLOCK = /^(?:NOTE|STYLE|REGION)(?:[ \t]|$)/;

function blocks(text) {
  if (typeof text !== "string") return [];
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n(?:[ \t]*\n)*/)
    .map((block) => block.split("\n"));
}

function timestampMs(match, hour, minute, second, millisecond) {
  return (
    Number(hour || 0) * 60 * 60 * 1000 +
    Number(minute) * 60 * 1000 +
    Number(second) * 1000 +
    Number(millisecond)
  );
}

function cleanText(lines) {
  return lines
    .join(" ")
    .replace(/<[^>]*>/g, "")
    .replace(ENTITY, (entity) => ({
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'",
      "&#39;": "'",
      "&nbsp;": " ",
    }[entity]))
    .replace(/\s+/g, " ")
    .trim();
}

function parseBlocks(text) {
  const cues = [];

  for (const block of blocks(text)) {
    const firstLine = block[0]?.trim() || "";
    if (SKIPPED_BLOCK.test(firstLine)) continue;

    const timingIndex = block.findIndex((line) => TIMING.test(line.trim()));
    if (timingIndex < 0) continue;

    const timing = TIMING.exec(block[timingIndex].trim());
    if (!timing) continue;

    const startMs = timestampMs(timing, timing[1], timing[2], timing[3], timing[4]);
    const endMs = timestampMs(timing, timing[5], timing[6], timing[7], timing[8]);
    if (endMs <= startMs) continue;

    cues.push({
      startMs,
      endMs,
      text: cleanText(block.slice(timingIndex + 1)),
    });
  }

  return cues;
}

export function parseVtt(text) {
  return parseBlocks(text);
}

export function parseSrt(text) {
  return parseBlocks(text);
}

export function cueText(cues) {
  if (!Array.isArray(cues)) return "";
  return cues
    .map((cue) => String(cue?.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

export function formatVttTimestamp(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError("Timestamp must be a finite, non-negative number");
  }

  const totalMs = Math.floor(ms);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;

  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":") +
    "." + String(milliseconds).padStart(3, "0");
}
