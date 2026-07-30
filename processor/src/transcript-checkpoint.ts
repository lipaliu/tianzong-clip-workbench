type TranscriptSegment = {
  id: string;
  speaker: string;
  text: string;
  startSec: number;
  endSec: number;
};

type TranscriptValue = {
  mediaDurationSec: number;
  segments: TranscriptSegment[];
  [key: string]: unknown;
};

type TranscriptRoute = {
  value: TranscriptValue;
  route: Record<string, unknown>;
};

type CheckpointIdentity = {
  sourceSha256: string;
  sourceSizeBytes: number;
  mediaDurationSec: number;
  transcriptionProvider: string;
};

export function buildTranscriptCheckpoint(
  transcriptRoute: TranscriptRoute,
  identity: CheckpointIdentity,
): Record<string, unknown> {
  return {
    schemaVersion: "tianclip.transcript-checkpoint.v1",
    ...identity,
    transcript: transcriptRoute.value,
    route: transcriptRoute.route,
    completedAt: new Date().toISOString(),
  };
}

export function restoreTranscriptCheckpoint(
  value: unknown,
  expected: CheckpointIdentity,
): TranscriptRoute | null {
  if (!value || typeof value !== "object") return null;
  const checkpoint = value as Record<string, unknown>;
  if (checkpoint.schemaVersion !== "tianclip.transcript-checkpoint.v1") {
    return null;
  }
  if (
    checkpoint.sourceSha256 !== expected.sourceSha256
    || checkpoint.sourceSizeBytes !== expected.sourceSizeBytes
    || checkpoint.transcriptionProvider !== expected.transcriptionProvider
    || Math.abs(
      Number(checkpoint.mediaDurationSec) - expected.mediaDurationSec,
    ) > 0.5
  ) {
    return null;
  }
  const transcript = checkpoint.transcript as TranscriptValue | undefined;
  const route = checkpoint.route;
  if (
    !transcript
    || typeof transcript !== "object"
    || !Array.isArray(transcript.segments)
    || transcript.segments.length === 0
    || !route
    || typeof route !== "object"
  ) {
    return null;
  }
  if (
    !Number.isFinite(transcript.mediaDurationSec)
    || Math.abs(transcript.mediaDurationSec - expected.mediaDurationSec) > 0.5
  ) {
    return null;
  }
  let previousStart = -1;
  for (const segment of transcript.segments) {
    if (
      !segment
      || typeof segment.id !== "string"
      || typeof segment.speaker !== "string"
      || typeof segment.text !== "string"
      || segment.text.trim().length === 0
      || !Number.isFinite(segment.startSec)
      || !Number.isFinite(segment.endSec)
      || segment.startSec < 0
      || segment.endSec < segment.startSec
      || segment.endSec > expected.mediaDurationSec + 0.5
      || segment.startSec < previousStart
    ) {
      return null;
    }
    previousStart = segment.startSec;
  }
  return {
    value: transcript,
    route: route as Record<string, unknown>,
  };
}
