import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNativeAvReviewCheckpoint,
  restoreNativeAvReviewCheckpoint,
  type NativeAvCheckpointIdentity,
} from "../native-av-checkpoint.js";

const identity: NativeAvCheckpointIdentity = {
  sourceSha256: "a".repeat(64),
  sourceSizeBytes: 123,
  mediaDurationSec: 7200,
  coreSha256: "b".repeat(64),
  coreVersion: "1.2.3-private.1",
  mode: "commerce",
  model: "doubao-seed-2-0-lite-260428",
  candidateId: "doubao_candidate_0001",
  safetyWindow: { startSec: 100, endSec: 160 },
};

const result = {
  normalized: {
    candidateId: identity.candidateId,
    reviewDecision: "supported",
    reviewContract: {
      nativeAudioVideoInputReviewed: true,
      continuousFrameByFrameReviewed: false,
      humanNormalPlaybackRequired: true,
    },
  },
};

test("native AV checkpoint restores the exact source, Skill, model and candidate", () => {
  const checkpoint = buildNativeAvReviewCheckpoint({
    identity,
    result,
    record: { candidateId: identity.candidateId, provider: "doubao" },
  });
  const restored = restoreNativeAvReviewCheckpoint({
    checkpoint,
    expectedIdentity: identity,
  });
  assert.deepEqual(restored?.result, result);
  assert.equal(restored?.record.provider, "doubao");
});

test("native AV checkpoint never reuses a changed window or overclaimed review", () => {
  const checkpoint = buildNativeAvReviewCheckpoint({
    identity,
    result,
    record: { candidateId: identity.candidateId, provider: "doubao" },
  });
  assert.equal(restoreNativeAvReviewCheckpoint({
    checkpoint,
    expectedIdentity: {
      ...identity,
      safetyWindow: { startSec: 90, endSec: 160 },
    },
  }), null);

  const overclaimed = buildNativeAvReviewCheckpoint({
    identity,
    result: {
      normalized: {
        ...result.normalized,
        reviewContract: {
          ...result.normalized.reviewContract,
          continuousFrameByFrameReviewed: true,
        },
      },
    },
    record: { candidateId: identity.candidateId, provider: "doubao" },
  });
  assert.equal(restoreNativeAvReviewCheckpoint({
    checkpoint: overclaimed,
    expectedIdentity: identity,
  }), null);
});
