import { invariant } from "./errors.mjs";

export const VALIDATION_STATUSES = Object.freeze({
  EDITORIAL_CANDIDATE: "editorial_candidate_needs_av_review",
  PROXY_READY: "proxy_rendered_needs_human_normal_playback",
  HUMAN_NEEDS_CHANGES: "human_review_needs_changes",
  HUMAN_REJECTED: "human_review_rejected",
  HUMAN_AV_VERIFIED: "human_av_verified_normal_playback",
});

function validIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function deriveCandidateValidation({
  candidate,
  proxy = undefined,
  humanReview = undefined,
} = {}) {
  invariant(candidate?.validationStatus === VALIDATION_STATUSES.EDITORIAL_CANDIDATE, "Candidate must begin as an unverified editorial proposal", {
    code: "INVALID_CANDIDATE_VALIDATION_STATE",
    stage: "candidate_validation",
    details: { candidateId: candidate?.candidateId, validationStatus: candidate?.validationStatus },
  });

  if (!proxy) {
    return {
      candidateId: candidate.candidateId,
      validationStatus: VALIDATION_STATUSES.EDITORIAL_CANDIDATE,
      audioVideoVerified: false,
      verifiedByHuman: false,
    };
  }

  invariant(proxy.candidateId === candidate.candidateId, "Proxy does not belong to this candidate", {
    code: "CANDIDATE_PROXY_MISMATCH",
    stage: "candidate_validation",
  });
  invariant(proxy.validationStatus === VALIDATION_STATUSES.PROXY_READY, "Proxy is not ready for normal-playback review", {
    code: "INVALID_PROXY_VALIDATION_STATE",
    stage: "candidate_validation",
    details: { candidateId: candidate.candidateId, validationStatus: proxy.validationStatus },
  });

  if (!humanReview) {
    return {
      candidateId: candidate.candidateId,
      validationStatus: VALIDATION_STATUSES.PROXY_READY,
      audioVideoVerified: false,
      verifiedByHuman: false,
    };
  }

  invariant(humanReview.reviewSource === "human_ui", "Only an explicit human UI review can verify audio and video", {
    code: "HUMAN_REVIEW_SOURCE_REQUIRED",
    stage: "candidate_validation",
  });
  invariant(typeof humanReview.reviewerId === "string" && humanReview.reviewerId.trim().length > 0, "Human reviewer id is required", {
    code: "HUMAN_REVIEWER_REQUIRED",
    stage: "candidate_validation",
  });
  invariant(validIsoTimestamp(humanReview.reviewedAt), "Human review timestamp is invalid", {
    code: "HUMAN_REVIEW_TIMESTAMP_INVALID",
    stage: "candidate_validation",
  });
  invariant(["approved", "needs_changes", "rejected"].includes(humanReview.decision), "Human review decision is invalid", {
    code: "HUMAN_REVIEW_DECISION_INVALID",
    stage: "candidate_validation",
  });

  if (humanReview.decision === "rejected") {
    return {
      candidateId: candidate.candidateId,
      validationStatus: VALIDATION_STATUSES.HUMAN_REJECTED,
      audioVideoVerified: false,
      verifiedByHuman: true,
      reviewerId: humanReview.reviewerId,
      reviewedAt: humanReview.reviewedAt,
      notes: humanReview.notes ?? "",
    };
  }
  if (humanReview.decision === "needs_changes") {
    return {
      candidateId: candidate.candidateId,
      validationStatus: VALIDATION_STATUSES.HUMAN_NEEDS_CHANGES,
      audioVideoVerified: false,
      verifiedByHuman: true,
      reviewerId: humanReview.reviewerId,
      reviewedAt: humanReview.reviewedAt,
      notes: humanReview.notes ?? "",
    };
  }

  invariant(humanReview.normalPlaybackConfirmed === true, "Approval cannot claim audio-video verification without normal-playback confirmation", {
    code: "NORMAL_PLAYBACK_CONFIRMATION_REQUIRED",
    stage: "candidate_validation",
    details: { candidateId: candidate.candidateId },
  });
  invariant(humanReview.audioVideoSyncConfirmed === true, "Approval cannot claim audio-video verification without confirming audio-video sync", {
    code: "AV_SYNC_CONFIRMATION_REQUIRED",
    stage: "candidate_validation",
    details: { candidateId: candidate.candidateId },
  });
  invariant(humanReview.reviewedWholeProxy === true, "Approval requires watching the entire safety-window proxy", {
    code: "FULL_PROXY_REVIEW_REQUIRED",
    stage: "candidate_validation",
    details: { candidateId: candidate.candidateId },
  });

  return {
    candidateId: candidate.candidateId,
    validationStatus: VALIDATION_STATUSES.HUMAN_AV_VERIFIED,
    audioVideoVerified: true,
    verifiedByHuman: true,
    verificationMethod: "human_normal_playback_of_entire_safety_window",
    reviewerId: humanReview.reviewerId,
    reviewedAt: humanReview.reviewedAt,
    notes: humanReview.notes ?? "",
  };
}
