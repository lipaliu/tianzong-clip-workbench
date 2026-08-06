import assert from "node:assert/strict";
import test from "node:test";

import {
  applyNativeAvBoundarySuggestions,
  augmentVisualMapWithNativeAvReviews,
  executeProviderRoute,
} from "../provider-routing.mjs";

test("provider routing records an explicit fallback without leaking the error message", async () => {
  const secret = "signed-url-secret";
  const result = await executeProviderRoute({
    requestedProvider: "doubao",
    primaryProvider: "doubao",
    primary: async () => {
      const error = new Error(`provider failed at ${secret}`);
      error.code = "DOUBAO_NETWORK_FAILED";
      error.stage = "doubao_av_review";
      throw error;
    },
    fallbackProvider: "sampled_stills",
    fallback: async () => ({ retained: true }),
    allowFallback: true,
  });

  assert.deepEqual(result.value, { retained: true });
  assert.deepEqual(result.route, {
    requestedProvider: "doubao",
    effectiveProvider: "sampled_stills",
    fallbackUsed: true,
    primaryFailure: {
      code: "DOUBAO_NETWORK_FAILED",
      stage: "doubao_av_review",
    },
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("native AV evidence augments the map while preserving the human playback gate", () => {
  const result = augmentVisualMapWithNativeAvReviews({
    visualMap: {
      method: "dense_stills",
      events: [],
      coverage: {
        continuousAudioVideoReviewed: false,
        limitation: "Sampled evidence only.",
      },
    },
    frameManifest: {
      frames: [
        { id: "frame_1", timestampSec: 100 },
        { id: "frame_2", timestampSec: 105 },
        { id: "frame_3", timestampSec: 110 },
      ],
    },
    attemptedCandidateCount: 1,
    reviewResults: [{
      normalized: {
        candidateId: "candidate_0001",
        reviewDecision: "supported",
        summary: "表情与语气共同支撑这个判断。",
        sourceWindow: { startSec: 100, endSec: 110, durationSec: 10 },
        visualEvents: [{
          id: "doubao_av_candidate_0001_001",
          startSec: 102,
          endSec: 106,
          eventType: "speaker_expression",
          description: "天总语气笃定并看向镜头。",
          people: ["天总"],
          actions: [],
          expressions: ["笃定"],
          products: [],
          onscreenText: [],
          clipSignals: ["doubao_native_av:expression"],
          confidence: 0.9,
          uncertainties: [],
          observationMethod: "doubao_seed_2_lite_native_audio_video",
          nativeAudioVideoInputReviewed: true,
          continuousFrameByFrameReviewed: false,
          humanNormalPlaybackRequired: true,
        }],
        boundarySuggestion: {
          openingStatus: "supported",
          closingStatus: "supported",
          reason: "语义闭环。",
        },
        audioAssessment: {
          availability: "present",
          toneSummary: "笃定",
          offscreenSpeechPresent: false,
          musicPresent: false,
        },
        transcriptAlignment: { status: "aligned" },
        uncertainties: [],
        reviewContract: {
          nativeAudioVideoInputReviewed: true,
          continuousFrameByFrameReviewed: false,
          humanNormalPlaybackRequired: true,
        },
      },
    }],
  });

  assert.equal(result.summary.complete, true);
  assert.equal(result.summary.supportedCandidateCount, 1);
  assert.equal(result.summary.uncertainCandidateCount, 0);
  assert.equal(result.summary.contradictedCandidateCount, 0);
  assert.equal(result.visualMap.events.length, 2);
  assert.ok(
    result.visualMap.events.every(
      (event) => event.nativeAvReviewDecision === "supported",
    ),
  );
  assert.ok(
    result.visualMap.events.every((event) =>
      Array.isArray(event.evidenceFrameIds)
      && event.evidenceFrameIds.length > 0),
  );
  assert.equal(
    result.visualMap.coverage.candidateNativeAudioVideoModelReviewComplete,
    true,
  );
  assert.equal(result.visualMap.coverage.continuousAudioVideoReviewed, false);
  assert.match(result.visualMap.coverage.limitation, /does not prove/);
});

test("transcript-first native AV evidence does not require unused sampled stills", () => {
  const result = augmentVisualMapWithNativeAvReviews({
    visualMap: {
      method: "diarized_transcript",
      events: [],
      coverage: {
        continuousAudioVideoReviewed: false,
        fullTranscriptRecallPrepared: true,
        limitation: "Transcript recall plus native AV candidate review.",
      },
    },
    frameManifest: {
      frames: [],
      coverage: {
        fullTimelineScreeningExtracted: false,
        fullTranscriptRecallPrepared: true,
        continuousVideoReviewed: false,
      },
    },
    attemptedCandidateCount: 1,
    reviewResults: [{
      normalized: {
        candidateId: "candidate_0001",
        reviewDecision: "supported",
        summary: "原生音视频证据支持该候选。",
        sourceWindow: { startSec: 100, endSec: 110, durationSec: 10 },
        visualEvents: [],
        boundarySuggestion: {
          openingStatus: "supported",
          closingStatus: "supported",
          reason: "语义闭环。",
        },
        audioAssessment: {
          availability: "present",
          toneSummary: "笃定",
          offscreenSpeechPresent: false,
          musicPresent: false,
        },
        transcriptAlignment: { status: "aligned" },
        uncertainties: [],
        reviewContract: {
          nativeAudioVideoInputReviewed: true,
          continuousFrameByFrameReviewed: false,
          humanNormalPlaybackRequired: true,
        },
      },
    }],
  });

  assert.equal(result.summary.complete, true);
  assert.equal(result.visualMap.events.length, 1);
  assert.deepEqual(result.visualMap.events[0].evidenceFrameIds, []);
  assert.equal(
    result.visualMap.coverage.candidateNativeAudioVideoModelReviewComplete,
    true,
  );
});

test("native AV boundary suggestions expand the final evidence window within media bounds", () => {
  const result = applyNativeAvBoundarySuggestions({
    candidateResult: {
      candidates: [
        {
          candidateId: "candidate_0001",
          recallWindow: { startSec: 11, endSec: 19 },
          safetyWindow: { startSec: 10, endSec: 20 },
          requiredVisualProof: [],
          risks: [],
        },
        {
          candidateId: "candidate_0002",
          recallWindow: { startSec: 30, endSec: 35 },
          safetyWindow: { startSec: 29, endSec: 36 },
          requiredVisualProof: [],
          risks: [],
        },
      ],
      selectionSummary: { qualifyingCount: 2 },
    },
    reviewResults: [{
      normalized: {
        candidateId: "candidate_0001",
        boundarySuggestion: {
          extendBeforeSec: 3,
          extendAfterSec: 5,
        },
      },
    }],
    mediaDurationSec: 22,
  });

  assert.deepEqual(
    result.candidateResult.candidates[0].safetyWindow,
    { startSec: 7, endSec: 22 },
  );
  assert.deepEqual(
    result.candidateResult.candidates[1].safetyWindow,
    { startSec: 29, endSec: 36 },
  );
  assert.equal(result.summary.expandedCandidateCount, 1);
  assert.match(
    result.candidateResult.candidates[0].risks[0],
    /10\.000–20\.000 秒扩展为 7\.000–22\.000 秒/,
  );
});
