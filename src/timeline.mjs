const reasonOrder = new Map([
  ["primary", 0],
  ["scene", 1],
  ["caption", 2],
]);

function midpoint({ startMs, endMs }) {
  return (startMs + endMs) / 2;
}

function decodedFrameAtOrAfter(requestedMs, frameTimes) {
  return frameTimes.find((timestampMs) => timestampMs >= requestedMs) ?? frameTimes.at(-1);
}

function clampToDuration(timestampMs, durationMs) {
  return Math.max(0, Math.min(timestampMs, durationMs - 1));
}

function owningSegment(timestampMs, segments) {
  const containingIndex = segments.findIndex(
    (segment) => segment.startMs <= timestampMs && timestampMs < segment.endMs,
  );
  if (containingIndex >= 0) return containingIndex;

  let nearestIndex = 0;
  let nearestDistance = Infinity;
  for (let index = 0; index < segments.length; index += 1) {
    const distance = Math.abs(timestampMs - midpoint(segments[index]));
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  }
  return nearestIndex;
}

export function buildCapturePlan({ segments, captionCues, sceneTimes, frameTimes, durationMs }) {
  const orderedCuts = [...new Set(sceneTimes)].sort((a, b) => a - b);
  const candidates = [
    ...segments.map((segment, segmentIndex) => ({
      requestedMs: clampToDuration(midpoint(segment), durationMs),
      reason: "primary",
      segmentIndex,
    })),
    ...captionCues.map((cue) => ({
      requestedMs: clampToDuration(midpoint(cue), durationMs),
      reason: "caption",
    })),
    ...orderedCuts.map((cut, index) => ({
      requestedMs: clampToDuration(
        Math.min(cut + 250, (orderedCuts[index + 1] ?? Infinity) - 1),
        durationMs,
      ),
      reason: "scene",
    })),
  ];
  const capturesByTimestamp = new Map();

  for (const candidate of candidates) {
    const timestampMs = decodedFrameAtOrAfter(candidate.requestedMs, frameTimes);
    const segmentIndex = candidate.segmentIndex ?? owningSegment(timestampMs, segments);
    const priority = reasonOrder.get(candidate.reason);
    let capture = capturesByTimestamp.get(timestampMs);
    if (!capture) {
      capture = {
        requestedMs: candidate.requestedMs,
        requestedPriority: priority,
        timestampMs,
        reasons: [],
        associationsBySegment: new Map(),
      };
      capturesByTimestamp.set(timestampMs, capture);
    }
    if (priority < capture.requestedPriority) {
      capture.requestedMs = candidate.requestedMs;
      capture.requestedPriority = priority;
    }
    if (!capture.reasons.includes(candidate.reason)) capture.reasons.push(candidate.reason);

    let association = capture.associationsBySegment.get(segmentIndex);
    if (!association) {
      association = {
        segmentIndex,
        requestedMs: candidate.requestedMs,
        requestedPriority: priority,
        reasons: [],
      };
      capture.associationsBySegment.set(segmentIndex, association);
    }
    if (priority < association.requestedPriority) {
      association.requestedMs = candidate.requestedMs;
      association.requestedPriority = priority;
    }
    if (!association.reasons.includes(candidate.reason)) association.reasons.push(candidate.reason);
  }

  return [...capturesByTimestamp.values()]
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .map((capture) => {
      capture.reasons.sort((a, b) => reasonOrder.get(a) - reasonOrder.get(b));
      return {
        requestedMs: capture.requestedMs,
        timestampMs: capture.timestampMs,
        reasons: capture.reasons,
        associations: [...capture.associationsBySegment.values()]
          .sort((a, b) => a.segmentIndex - b.segmentIndex)
          .map(({ segmentIndex, requestedMs, reasons }) => ({
            segmentIndex,
            requestedMs,
            reasons: reasons.sort((a, b) => reasonOrder.get(a) - reasonOrder.get(b)),
          })),
        filename: `${String(capture.timestampMs).padStart(9, "0")}-${capture.reasons[0]}.jpg`,
      };
    });
}
