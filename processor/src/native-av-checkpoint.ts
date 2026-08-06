type UnknownRecord = Record<string, unknown>;

export type NativeAvCheckpointIdentity = {
  sourceSha256: string;
  sourceSizeBytes: number;
  mediaDurationSec: number;
  coreSha256: string;
  coreVersion: string;
  mode: string;
  model: string;
  candidateId: string;
  safetyWindow: { startSec: number; endSec: number };
};

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function sameIdentity(
  saved: UnknownRecord,
  expected: NativeAvCheckpointIdentity,
): boolean {
  return JSON.stringify(saved) === JSON.stringify(expected);
}

function validReviewResult(
  value: unknown,
  candidateId: string,
): value is UnknownRecord {
  const result = record(value);
  const normalized = record(result?.normalized);
  const contract = record(normalized?.reviewContract);
  return Boolean(
    result
    && normalized
    && normalized.candidateId === candidateId
    && ["supported", "uncertain", "contradicted"].includes(
      String(normalized.reviewDecision),
    )
    && contract?.nativeAudioVideoInputReviewed === true
    && contract?.continuousFrameByFrameReviewed === false
    && contract?.humanNormalPlaybackRequired === true,
  );
}

export function buildNativeAvReviewCheckpoint(input: {
  identity: NativeAvCheckpointIdentity;
  result: UnknownRecord;
  record: UnknownRecord;
}): UnknownRecord {
  return {
    schemaVersion: "tianclip.native-av-review-checkpoint.v1",
    identity: input.identity,
    result: input.result,
    record: input.record,
    savedAt: new Date().toISOString(),
  };
}

export function restoreNativeAvReviewCheckpoint(input: {
  checkpoint: unknown;
  expectedIdentity: NativeAvCheckpointIdentity;
}): { result: UnknownRecord; record: UnknownRecord } | null {
  const checkpoint = record(input.checkpoint);
  const identity = record(checkpoint?.identity);
  const savedRecord = record(checkpoint?.record);
  if (
    checkpoint?.schemaVersion !== "tianclip.native-av-review-checkpoint.v1"
    || !identity
    || !sameIdentity(identity, input.expectedIdentity)
    || !validReviewResult(
      checkpoint.result,
      input.expectedIdentity.candidateId,
    )
    || !savedRecord
    || savedRecord.candidateId !== input.expectedIdentity.candidateId
  ) {
    return null;
  }
  return {
    result: checkpoint.result as UnknownRecord,
    record: savedRecord,
  };
}
