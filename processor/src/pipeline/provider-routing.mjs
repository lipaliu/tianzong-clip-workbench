import { invariant } from "./errors.mjs";

function safeFailure(error) {
  return {
    code:
      typeof error?.code === "string" && error.code.length
        ? error.code
        : "PROVIDER_ROUTE_FAILED",
    stage:
      typeof error?.stage === "string" && error.stage.length
        ? error.stage
        : null,
  };
}

export async function executeProviderRoute({
  requestedProvider,
  primaryProvider,
  primary,
  fallbackProvider,
  fallback,
  allowFallback = false,
} = {}) {
  invariant(
    typeof requestedProvider === "string"
    && requestedProvider.length > 0
    && requestedProvider === primaryProvider
    && typeof primary === "function",
    "Provider route is malformed",
    {
      code: "PROVIDER_ROUTE_INVALID",
      stage: "provider_route",
    },
  );

  try {
    return {
      value: await primary(),
      route: {
        requestedProvider,
        effectiveProvider: primaryProvider,
        fallbackUsed: false,
        primaryFailure: null,
      },
    };
  } catch (error) {
    if (
      !allowFallback
      || typeof fallbackProvider !== "string"
      || fallbackProvider.length === 0
      || typeof fallback !== "function"
    ) {
      throw error;
    }
    return {
      value: await fallback(),
      route: {
        requestedProvider,
        effectiveProvider: fallbackProvider,
        fallbackUsed: true,
        primaryFailure: safeFailure(error),
      },
    };
  }
}

function roundMillis(value) {
  return Math.round(value * 1_000) / 1_000;
}

export function applyNativeAvBoundarySuggestions({
  candidateResult,
  reviewResults,
  mediaDurationSec,
} = {}) {
  invariant(
    candidateResult
    && Array.isArray(candidateResult.candidates)
    && Array.isArray(reviewResults)
    && Number.isFinite(mediaDurationSec)
    && mediaDurationSec > 0,
    "Candidate boundary expansion input is invalid",
    {
      code: "NATIVE_AV_BOUNDARY_INPUT_INVALID",
      stage: "native_av_boundary_expansion",
    },
  );

  const reviewsByCandidate = new Map();
  for (const review of reviewResults) {
    const normalized = review?.normalized;
    invariant(
      normalized
      && typeof normalized.candidateId === "string"
      && normalized.boundarySuggestion
      && Number.isFinite(normalized.boundarySuggestion.extendBeforeSec)
      && Number.isFinite(normalized.boundarySuggestion.extendAfterSec),
      "Native AV boundary suggestion is malformed",
      {
        code: "NATIVE_AV_BOUNDARY_SUGGESTION_INVALID",
        stage: "native_av_boundary_expansion",
      },
    );
    invariant(
      !reviewsByCandidate.has(normalized.candidateId),
      "Native AV boundary suggestion is duplicated",
      {
        code: "NATIVE_AV_BOUNDARY_SUGGESTION_DUPLICATED",
        stage: "native_av_boundary_expansion",
        details: { candidateId: normalized.candidateId },
      },
    );
    reviewsByCandidate.set(normalized.candidateId, normalized);
  }

  let expandedCandidateCount = 0;
  const candidates = candidateResult.candidates.map((candidate) => {
    const review = reviewsByCandidate.get(candidate.candidateId);
    if (!review) return candidate;
    const original = candidate.safetyWindow;
    const extendBeforeSec = Math.max(
      0,
      Number(review.boundarySuggestion.extendBeforeSec),
    );
    const extendAfterSec = Math.max(
      0,
      Number(review.boundarySuggestion.extendAfterSec),
    );
    const expanded = {
      startSec: roundMillis(Math.max(0, original.startSec - extendBeforeSec)),
      endSec: roundMillis(
        Math.min(mediaDurationSec, original.endSec + extendAfterSec),
      ),
    };
    invariant(
      expanded.startSec <= candidate.recallWindow.startSec + 0.05
      && expanded.endSec >= candidate.recallWindow.endSec - 0.05
      && expanded.endSec > expanded.startSec,
      "Native AV boundary expansion no longer contains the recall window",
      {
        code: "NATIVE_AV_BOUNDARY_EXPANSION_INVALID",
        stage: "native_av_boundary_expansion",
        details: { candidateId: candidate.candidateId },
      },
    );
    const changed =
      expanded.startSec < original.startSec - 0.001
      || expanded.endSec > original.endSec + 0.001;
    if (!changed) return candidate;
    expandedCandidateCount += 1;
    return {
      ...candidate,
      safetyWindow: expanded,
      requiredVisualProof: [
        ...(candidate.requiredVisualProof ?? []),
        "豆包音视频复核提出补上下文建议；须完整正常倍速播放扩展后的安全窗。",
      ],
      risks: [
        ...(candidate.risks ?? []),
        `候选安全窗按原生音视频模型建议由 ${original.startSec.toFixed(3)}–`
          + `${original.endSec.toFixed(3)} 秒扩展为 ${expanded.startSec.toFixed(3)}–`
          + `${expanded.endSec.toFixed(3)} 秒，新增部分尚须最终编导与人工验片确认。`,
      ],
    };
  });

  return {
    candidateResult: {
      ...candidateResult,
      candidates,
    },
    summary: {
      reviewedCandidateCount: reviewResults.length,
      expandedCandidateCount,
      unchangedCandidateCount: reviewResults.length - expandedCandidateCount,
      expansionSource: "validated_doubao_native_av_boundary_suggestion",
      finalEditorialMustRecheckExpandedEvidence: true,
      humanNormalPlaybackRequired: true,
    },
  };
}

function nearestFrameIds(frames, startSec, endSec) {
  invariant(Array.isArray(frames) && frames.length > 0, "Dense frames are required", {
    code: "NATIVE_AV_FRAME_EVIDENCE_MISSING",
    stage: "native_av_augmentation",
  });
  const midpoint = (startSec + endSec) / 2;
  const ranked = [...frames].sort((left, right) =>
    Math.abs(left.timestampSec - midpoint)
    - Math.abs(right.timestampSec - midpoint));
  const ids = [];
  for (const frame of ranked) {
    if (
      ids.length === 0
      || (frame.timestampSec >= startSec - 0.05
        && frame.timestampSec <= endSec + 0.05)
    ) {
      ids.push(frame.id);
    }
    if (ids.length >= 3) break;
  }
  return ids;
}

function summaryDescription(normalized) {
  const boundary = normalized.boundarySuggestion;
  const audio = normalized.audioAssessment;
  return [
    `豆包原生音视频候选复核：${normalized.reviewDecision}。${normalized.summary}`,
    `开头=${boundary.openingStatus}，结尾=${boundary.closingStatus}；${boundary.reason}`,
    `音频=${audio.availability}；语气/声音：${audio.toneSummary || "未确认"}；`
      + `场外说话=${audio.offscreenSpeechPresent ? "有" : "未确认"}；`
      + `音乐=${audio.musicPresent ? "有" : "未确认"}。`,
    `逐字稿对齐=${normalized.transcriptAlignment.status}。`,
  ].join(" ");
}

export function augmentVisualMapWithNativeAvReviews({
  visualMap,
  reviewResults,
  frameManifest,
  attemptedCandidateCount,
  failedCandidateCount = 0,
} = {}) {
  invariant(
    visualMap
    && Array.isArray(visualMap.events)
    && visualMap.coverage?.continuousAudioVideoReviewed === false,
    "Visual map is required and must remain human-gated",
    {
      code: "NATIVE_AV_VISUAL_MAP_INVALID",
      stage: "native_av_augmentation",
    },
  );
  invariant(
    Array.isArray(reviewResults)
    && Number.isInteger(attemptedCandidateCount)
    && attemptedCandidateCount >= reviewResults.length
    && Number.isInteger(failedCandidateCount)
    && failedCandidateCount >= 0,
    "Native AV review accounting is invalid",
    {
      code: "NATIVE_AV_REVIEW_ACCOUNTING_INVALID",
      stage: "native_av_augmentation",
    },
  );
  const frames = frameManifest?.frames;
  invariant(Array.isArray(frames) && frames.length > 0, "Dense frame manifest is required", {
    code: "NATIVE_AV_FRAME_MANIFEST_REQUIRED",
    stage: "native_av_augmentation",
  });

  const knownEventIds = new Set(visualMap.events.map((event) => event.id));
  const nativeEvents = [];
  for (const review of reviewResults) {
    const normalized = review?.normalized;
    invariant(
      normalized
      && typeof normalized.candidateId === "string"
      && ["supported", "uncertain", "contradicted"].includes(
        normalized.reviewDecision,
      )
      && normalized.sourceWindow
      && Array.isArray(normalized.visualEvents)
      && normalized.reviewContract?.nativeAudioVideoInputReviewed === true
      && normalized.reviewContract?.continuousFrameByFrameReviewed === false
      && normalized.reviewContract?.humanNormalPlaybackRequired === true,
      "Native AV review result is malformed or overclaims verification",
      {
        code: "NATIVE_AV_REVIEW_RESULT_INVALID",
        stage: "native_av_augmentation",
      },
    );

    const summaryId = `doubao_av_summary_${normalized.candidateId}`;
    invariant(!knownEventIds.has(summaryId), "Native AV summary event id is duplicated", {
      code: "NATIVE_AV_EVENT_ID_DUPLICATED",
      stage: "native_av_augmentation",
      details: { eventId: summaryId },
    });
    knownEventIds.add(summaryId);
    const summaryFrameIds = nearestFrameIds(
      frames,
      normalized.sourceWindow.startSec,
      normalized.sourceWindow.endSec,
    );
    const evidenceConfidences = normalized.visualEvents
      .map((event) => Number(event.confidence))
      .filter(Number.isFinite);
    nativeEvents.push({
      id: summaryId,
      startSec: roundMillis(normalized.sourceWindow.startSec),
      endSec: roundMillis(normalized.sourceWindow.endSec),
      eventType: "other",
      description: summaryDescription(normalized),
      people: ["天总"],
      actions: [],
      expressions: [],
      products: [],
      onscreenText: [],
      clipSignals: [
        "doubao_native_audio_video_candidate_review",
        `review_decision:${normalized.reviewDecision}`,
        `transcript_alignment:${normalized.transcriptAlignment.status}`,
      ],
      evidenceFrameIds: summaryFrameIds,
      confidence: evidenceConfidences.length
        ? Math.min(
            0.95,
            Math.max(
              0.1,
              evidenceConfidences.reduce((sum, value) => sum + value, 0)
                / evidenceConfidences.length,
            ),
          )
        : 0.5,
      uncertainties: [
        ...normalized.uncertainties,
        "该结论来自原生音视频模型输入，但不等于逐帧连续检查，也不等于人工正常倍速验片。",
      ],
      observationMethod: "doubao_seed_2_lite_native_audio_video",
      nativeAvReviewDecision: normalized.reviewDecision,
      continuousRangeReviewed: false,
      nativeAudioVideoInputReviewed: true,
      continuousFrameByFrameReviewed: false,
      humanNormalPlaybackRequired: true,
      candidateId: normalized.candidateId,
    });

    for (const event of normalized.visualEvents) {
      invariant(!knownEventIds.has(event.id), "Native AV evidence event id is duplicated", {
        code: "NATIVE_AV_EVENT_ID_DUPLICATED",
        stage: "native_av_augmentation",
        details: { eventId: event.id },
      });
      knownEventIds.add(event.id);
      nativeEvents.push({
        ...event,
        nativeAvReviewDecision: normalized.reviewDecision,
        evidenceFrameIds: nearestFrameIds(
          frames,
          event.startSec,
          event.endSec,
        ),
        uncertainties: [
          ...(event.uncertainties ?? []),
          "原生音视频模型证据仍须由人工完整、正常倍速播放候选安全窗后确认。",
        ],
        continuousRangeReviewed: false,
        candidateId: normalized.candidateId,
      });
    }
  }

  const completedCandidateCount = reviewResults.length;
  const supportedCandidateCount = reviewResults.filter(
    (review) => review.normalized.reviewDecision === "supported",
  ).length;
  const uncertainCandidateCount = reviewResults.filter(
    (review) => review.normalized.reviewDecision === "uncertain",
  ).length;
  const contradictedCandidateCount = reviewResults.filter(
    (review) => review.normalized.reviewDecision === "contradicted",
  ).length;
  const complete =
    attemptedCandidateCount > 0
    && completedCandidateCount === attemptedCandidateCount
    && failedCandidateCount === 0;
  return {
    visualMap: {
      ...visualMap,
      method:
        `${visualMap.method} + doubao_seed_2_lite_native_audio_video_candidate_review`,
      events: [...visualMap.events, ...nativeEvents].sort(
        (left, right) =>
          left.startSec - right.startSec || left.endSec - right.endSec,
      ),
      nativeAudioVideoModelReview: {
        provider: "volcengine_ark",
        model: "doubao-seed-2-0-lite-260428",
        attemptedCandidateCount,
        completedCandidateCount,
        failedCandidateCount,
        supportedCandidateCount,
        uncertainCandidateCount,
        contradictedCandidateCount,
        eventCount: nativeEvents.length,
        complete,
        continuousFrameByFrameReviewed: false,
        humanNormalPlaybackRequired: true,
      },
      coverage: {
        ...visualMap.coverage,
        candidateNativeAudioVideoModelReviewAttempted: attemptedCandidateCount > 0,
        candidateNativeAudioVideoModelReviewComplete: complete,
        candidateNativeAudioVideoModelReviewCount: completedCandidateCount,
        candidateNativeAudioVideoModelReviewFailedCount: failedCandidateCount,
        continuousAudioVideoReviewed: false,
        limitation:
          `${visualMap.coverage.limitation} Candidate proxies were additionally`
          + " submitted as native audio-video model inputs where configured;"
          + " this does not prove continuous frame-by-frame or human review.",
      },
    },
    summary: {
      provider: "volcengine_ark",
      model: "doubao-seed-2-0-lite-260428",
      attemptedCandidateCount,
      completedCandidateCount,
      failedCandidateCount,
      supportedCandidateCount,
      uncertainCandidateCount,
      contradictedCandidateCount,
      eventCount: nativeEvents.length,
      complete,
      continuousFrameByFrameReviewed: false,
      humanNormalPlaybackRequired: true,
    },
  };
}
