import assert from "node:assert/strict";
import test from "node:test";

import {
  expandCandidateEvidenceWindow,
  validateCandidateDenseRefinement,
} from "../pipeline/candidate-refinement.mjs";
import { renderCandidateRoughCut } from "../pipeline/proxy.mjs";

const candidate = {
  candidateId: "candidate-1",
  title: "直播电商为什么越来越难",
  hook: "直播电商已然达到了地狱级难度。",
  openingLine: "直播电商已然达到了地狱级难度。",
  topic: "直播电商",
  contentPillar: "商业、电商、搞钱判断",
  rationale: "保留成本、用户与供应链的完整因果。",
  recallWindow: { startSec: 8, endSec: 60 },
  safetyWindow: { startSec: 0, endSec: 100 },
  transcriptSegmentIds: ["s1", "s2", "s3"],
  visualEventIds: [],
  requiredVisualProof: ["完整播放"],
  deleteSuggestions: [],
  score: {
    hook: 18,
    emotion: 12,
    insight: 18,
    controversy: 12,
    completeness: 15,
    titlePotential: 12,
    total: 87,
  },
  risks: [],
  validationStatus: "editorial_candidate_needs_av_review",
};

const transcriptSegments = [
  {
    id: "s1",
    speaker: "speaker_1",
    startSec: 0,
    endSec: 8,
    text: "普通人现在还适合做电商吗？",
  },
  {
    id: "s2",
    speaker: "speaker_2",
    startSec: 8,
    endSec: 35,
    text: "直播电商已然达到了地狱级难度，但带货是长线的。",
  },
  {
    id: "s3",
    speaker: "speaker_2",
    startSec: 35,
    endSec: 60,
    text: "你要把成本、用户和供应链学明白，再决定怎么做。",
  },
];

function refinement(overrides = {}) {
  return {
    candidateId: "candidate-1",
    decision: "retain",
    refinedRecallWindow: { startSec: 8, endSec: 60 },
    refinedSafetyWindow: { startSec: 0, endSec: 100 },
    openingLine: "直播电商已然达到了地狱级难度。",
    closureText: "你要把成本、用户和供应链学明白，再决定怎么做。",
    tianzongSpeakerLabel: "speaker_2",
    openingSegmentId: "s2",
    closingSegmentId: "s3",
    spokenContentSegmentIds: ["s2", "s3"],
    contextOnlySegmentIds: ["s1"],
    questionCardText: "普通人现在还适合做电商吗？",
    semanticClosureStatus: "complete",
    roughCutCategory: "business_judgment",
    roughCutDurationRationale: "商业粗剪保留完整判断、原因和行动落点。",
    transcriptSegmentIds: ["s2", "s3"],
    visualEventIds: [],
    visualPunchline: {
      present: false,
      description: "",
      evidenceFrameIds: [],
      confidence: 0,
    },
    actionCompleteness: {
      status: "complete_in_sampled_evidence",
      description: "观点表达完整。",
      evidenceFrameIds: ["f1"],
    },
    boundaryAssessment: {
      openingStatus: "supported",
      closingStatus: "supported",
      riskNotes: [],
    },
    requiredHumanNormalPlaybackChecks: ["正常倍速检查切口"],
    risks: [],
    rejectionReason: "",
    machineReviewMethod: "dense_still_frames_plus_diarized_transcript",
    continuousAudioVideoReviewed: false,
    humanNormalPlaybackRequired: true,
    validationStatus:
      "candidate_dense_av_screening_needs_human_normal_playback",
    ...overrides,
  };
}

const validationEvidence = {
  candidate,
  transcriptSegments,
  visualEvents: [],
  frames: [{ id: "f1" }],
};

test("candidate evidence windows expand to the right instead of freezing a 20s visual window", () => {
  const expanded = expandCandidateEvidenceWindow({
    ...candidate,
    recallWindow: { startSec: 10, endSec: 20 },
    safetyWindow: { startSec: 8, endSec: 28 },
  }, {
    mediaDurationSec: 180,
    mode: "chat",
  });
  assert.deepEqual(expanded.safetyWindow, { startSec: 2, endSec: 115 });
});

test("complete 52s Tianzong business rough cut passes the hard gate", () => {
  assert.equal(
    validateCandidateDenseRefinement(
      refinement(),
      validationEvidence,
    ),
    true,
  );
});

test("another speaker cannot become the delivered opening", () => {
  assert.throws(
    () => validateCandidateDenseRefinement(
      refinement({
        openingLine: "普通人现在还适合做电商吗？",
        openingSegmentId: "s1",
        spokenContentSegmentIds: ["s1", "s2", "s3"],
        transcriptSegmentIds: ["s1", "s2", "s3"],
      }),
      validationEvidence,
    ),
    (error) => error?.code === "CANDIDATE_REFINEMENT_TIANZONG_SPEAKER_INVALID",
  );
});

test("business rough cut cannot be compressed back to 20 seconds", () => {
  assert.throws(
    () => validateCandidateDenseRefinement(
      refinement({
        refinedRecallWindow: { startSec: 8, endSec: 28 },
      }),
      validationEvidence,
    ),
    (error) => error?.code === "CANDIDATE_REFINEMENT_ROUGH_DURATION_INVALID",
  );
});

test("transcript evidence outside the refined safety window is rejected per candidate", () => {
  const outsideSegment = {
    id: "s4",
    speaker: "speaker_2",
    startSec: 80,
    endSec: 90,
    text: "这是已经进入下一个话题的证据。",
  };
  assert.throws(
    () => validateCandidateDenseRefinement(
      refinement({
        refinedSafetyWindow: { startSec: 0, endSec: 65 },
        transcriptSegmentIds: ["s2", "s3", "s4"],
      }),
      {
        ...validationEvidence,
        transcriptSegments: [...transcriptSegments, outsideSegment],
      },
    ),
    (error) =>
      error?.code === "CANDIDATE_REFINEMENT_TRANSCRIPT_EVIDENCE_INVALID",
  );
});

test("unfinished or source-truncated speech cannot be a closing point", () => {
  const truncatedSegments = transcriptSegments.map((segment) =>
    segment.id === "s3"
      ? {
          ...segment,
          text: "那我问你，他为什么要在你这里买东",
        }
      : segment);
  assert.throws(
    () => validateCandidateDenseRefinement(
      refinement({
        closureText: "那我问你，他为什么要在你这里买东",
      }),
      {
        ...validationEvidence,
        transcriptSegments: truncatedSegments,
      },
    ),
    (error) => error?.code === "CANDIDATE_REFINEMENT_CLOSURE_INVALID",
  );
});

test("rough-cut renderer removes other-speaker audio instead of exporting the safety window", async () => {
  let command;
  const deliverable = {
    ...candidate,
    recallWindow: { startSec: 0, endSec: 60 },
    semanticClosureStatus: "complete",
    tianzongSpeakerLabel: "speaker_2",
    openingSegmentId: "s2",
    closingSegmentId: "s3",
    deleteSuggestions: [{
      startSec: 0,
      endSec: 8,
      reason: "删除场外提问原声",
      transcriptSegmentIds: ["s1"],
    }],
  };
  const result = await renderCandidateRoughCut({
    sourcePath: "/tmp/source.mp4",
    candidate: deliverable,
    outputPath: "/tmp/rough.mp4",
    mediaDurationSec: 100,
    verifyOutput: false,
    runner: async (name, args) => {
      command = { name, args };
    },
  });
  const filter = command.args[command.args.indexOf("-filter_complex") + 1];
  assert.equal(command.name, "ffmpeg");
  assert.match(filter, /trim=start=8\.000:end=60\.000/);
  assert.doesNotMatch(filter, /trim=start=0\.000:end=100\.000/);
  assert.deepEqual(result.keptRanges, [{ startSec: 8, endSec: 60 }]);
  assert.equal(result.sourceWindow.durationSec, 52);
});
