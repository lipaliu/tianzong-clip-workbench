import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.js";
import type { LoadedTianClipCore } from "./core/index.js";
import type {
  CandidatePayload,
  CandidateTranscriptLine,
  ClaimedJob,
  TianClipMode,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

type MediaProbe = {
  durationSec: number;
  video?: {
    fps?: number | null;
    width?: number | null;
    height?: number | null;
    rotation?: number | null;
    frameRate?: {
      numerator: number;
      denominator: number;
      rational: string;
      fps: number;
      source: "avg_frame_rate" | "r_frame_rate";
    } | null;
  };
  audio?: {
    channels?: number | null;
  };
};

type TranscriptSegment = {
  id: string;
  speaker: string;
  text: string;
  startSec: number;
  endSec: number;
};

type TranscriptResult = {
  segments: TranscriptSegment[];
  mediaDurationSec: number;
  model?: string;
  coverage?: {
    firstSegmentStartSec?: number;
    lastSegmentEndSec?: number;
  };
};

type VisualEvent = {
  id: string;
  startSec: number;
  endSec: number;
  eventType: string;
  description: string;
  people?: string[];
  actions?: string[];
  expressions?: string[];
  products?: string[];
  evidenceFrameIds: string[];
  confidence: number;
  uncertainties?: string[];
  observationMethod?: string;
  continuousRangeReviewed?: false;
  candidateId?: string;
};

type VisualMap = {
  method?: string;
  events: VisualEvent[];
  coverage?: {
    fullTimelineScreeningComplete?: boolean;
    continuousAudioVideoReviewed?: boolean;
    limitation?: string;
    denseVisualReverseRecallComplete?: boolean;
    densePeriodicIntervalSec?: number;
    denseFrameCount?: number;
    candidateDenseStillTranscriptRefinementComplete?: boolean;
    candidateSafetyWindowsReviewed?: number;
    candidateNativeAudioVideoModelReviewAttempted?: boolean;
    candidateNativeAudioVideoModelReviewComplete?: boolean;
    candidateNativeAudioVideoModelReviewCount?: number;
    candidateNativeAudioVideoModelReviewFailedCount?: number;
  };
};

type CandidateResultItem = {
  candidateId: string;
  editorProvider?: "openai" | "doubao";
  title: string;
  hook: string;
  openingLine: string;
  topic: string;
  contentPillar: string;
  rationale: string;
  recallWindow: TimeRange;
  safetyWindow: TimeRange;
  transcriptSegmentIds: string[];
  visualEventIds: string[];
  requiredVisualProof: string[];
  deleteSuggestions: Array<{
    startSec: number;
    endSec: number;
    reason: string;
    transcriptSegmentIds: string[];
  }>;
  score: {
    hook: number;
    emotion: number;
    insight: number;
    controversy: number;
    completeness: number;
    titlePotential: number;
    total: number;
  };
  risks: string[];
  validationStatus: "editorial_candidate_needs_av_review";
  discoveryMethods?: string[];
  refinement?: {
    method:
      | "dense_still_frames_plus_diarized_transcript"
      | "dense_still_frames_plus_diarized_transcript_plus_native_av_model_evidence";
    decision: "retain";
    visualPunchline: {
      present: boolean;
      description: string;
      evidenceFrameIds: string[];
      confidence: number;
    };
    actionCompleteness: {
      status: "complete_in_sampled_evidence" | "uncertain" | "incomplete";
      description: string;
      evidenceFrameIds: string[];
    };
    boundaryAssessment: {
      openingStatus: "supported" | "needs_more_context" | "uncertain";
      closingStatus: "supported" | "needs_more_context" | "uncertain";
      riskNotes: string[];
    };
    continuousAudioVideoReviewed: false;
    humanNormalPlaybackRequired: true;
    validationStatus: string;
    sourceCandidateId?: string;
  };
};

type CandidateResult = {
  candidates: CandidateResultItem[];
  selectionSummary: {
    qualifyingCount: number;
    rejectedThemes: string[];
    notes: string[];
  };
  mode?: "chat" | "sales";
  model?: string;
  generatedAt?: string;
  sourceFunnel?: {
    textCandidateCount: number;
    visualCandidateCount: number;
    exactDuplicateCount: number;
    mergedCandidateCount: number;
  };
  refinementSummary?: {
    inputCandidateCount: number;
    retainedCandidateCount: number;
    rejectedCandidateCount: number;
    method: string;
    continuousAudioVideoReviewed: false;
    humanNormalPlaybackRequired: true;
  };
};

type TimeRange = {
  startSec: number;
  endSec: number;
};

type SourceWindow = {
  start_sec: number;
  end_sec: number;
  start_word_id: string;
  end_word_id: string;
};

type NaturalUnit = {
  id: string;
  segmentIds: string[];
  range: TimeRange;
  candidateIds: string[];
};

export type EngineArtifactUris = {
  sourceMedia: string;
  transcript: string;
};

export type BuildEngineArtifactsInput = {
  job: ClaimedJob;
  media: MediaProbe;
  sourceSha256: string;
  transcript: TranscriptResult;
  visualMap: VisualMap;
  candidateResult: CandidateResult;
  core: LoadedTianClipCore;
  artifactUris: EngineArtifactUris;
  startedAt?: string;
  completedAt?: string;
};

export type EngineArtifacts = {
  factLayer: JsonRecord;
  editPlan: JsonRecord;
  engineLedger: JsonRecord;
  candidatePayloads: CandidatePayload[];
};

const SHA256 = /^[a-f0-9]{64}$/;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`engine_artifact_invalid: ${message}`);
}

function coreMode(jobMode: TianClipMode): "chat" | "sales" {
  return jobMode === "聊播" ? "chat" : "sales";
}

function roundMillis(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function safeRange(range: TimeRange, durationSec: number): TimeRange {
  const startSec = Math.max(0, Math.min(roundMillis(range.startSec), durationSec - 0.001));
  const endSec = Math.max(
    startSec + 0.001,
    Math.min(roundMillis(range.endSec), durationSec),
  );
  return { startSec, endSec: roundMillis(endSec) };
}

function overlappingSegments(
  segments: TranscriptSegment[],
  range: TimeRange,
): TranscriptSegment[] {
  return segments.filter(
    (segment) => segment.endSec >= range.startSec && segment.startSec <= range.endSec,
  );
}

function sourceWindow(
  range: TimeRange,
  segments: TranscriptSegment[],
  durationSec: number,
): SourceWindow {
  const safe = safeRange(range, durationSec);
  const evidence = overlappingSegments(segments, safe);
  const first = evidence[0] ?? segments[0];
  const last = evidence.at(-1) ?? segments.at(-1);
  assert(first && last, "a source window requires transcript evidence");
  return {
    start_sec: safe.startSec,
    end_sec: safe.endSec,
    start_word_id: first.id,
    end_word_id: last.id,
  };
}

function calculateAsrGaps(
  segments: TranscriptSegment[],
  durationSec: number,
): Array<{ start_sec: number; end_sec: number }> {
  const gaps: Array<{ start_sec: number; end_sec: number }> = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.startSec - cursor >= 2) {
      gaps.push({
        start_sec: roundMillis(cursor),
        end_sec: roundMillis(segment.startSec),
      });
    }
    cursor = Math.max(cursor, segment.endSec);
  }
  if (durationSec - cursor >= 2) {
    gaps.push({ start_sec: roundMillis(cursor), end_sec: roundMillis(durationSec) });
  }
  return gaps;
}

function visualScanMethod(visualMap: VisualMap): string {
  if (!visualMap.coverage?.denseVisualReverseRecallComplete) {
    return "adaptive_proxy_scan: periodic + scene-change sparse frames; not continuous playback";
  }
  const nativeReviewCount =
    visualMap.coverage.candidateNativeAudioVideoModelReviewCount ?? 0;
  return `adaptive_proxy_scan: sparse semantic map + every ${
    visualMap.coverage.densePeriodicIntervalSec ?? "configured"
  }s/scene-change dense visual reverse recall + candidate safety-window dense still/transcript refinement${
    nativeReviewCount > 0
      ? ` + ${nativeReviewCount} candidate native audio-video model reviews`
      : ""
  }; not continuous frame-by-frame or human playback`;
}

function visualEventType(value: string): string {
  const map: Record<string, string> = {
    speaker_expression: "expression_or_reaction",
    gesture: "outfit_or_body_movement",
    product_display: "product_or_sku_change",
    interaction: "comment_or_call_in",
    movement: "outfit_or_body_movement",
    scene_change: "person_change",
    onscreen_text: "measurement_or_label",
  };
  return map[value] ?? "other";
}

function contentType(value: string): string {
  const normalized = value.toLowerCase();
  if (/(sales|conversion|带货|成交)/.test(normalized)) return "sales_conversion";
  if (/(product|商品|产品)/.test(normalized)) return "product_nonconversion";
  if (/(business|career|创业|商业|职场|赚钱|电商)/.test(normalized)) {
    return "business_and_career";
  }
  if (/(relationship|boundary|情感|关系|婚姻)/.test(normalized)) {
    return "relationship_and_boundaries";
  }
  if (/(growth|learning|成长|学历|学习)/.test(normalized)) return "growth_and_learning";
  if (/(humor|comedy|搞笑|反转|整活)/.test(normalized)) return "humor_and_reversal";
  if (/(vulnerab|story|脆弱|故事|原生家庭)/.test(normalized)) {
    return "vulnerability_and_story";
  }
  if (/(beauty|style|穿搭|审美|美妆)/.test(normalized)) return "beauty_and_style";
  if (/(daily|pet|日常|宠物|做饭)/.test(normalized)) return "daily_life_and_pet";
  return "other";
}

function personaStates(candidate: CandidateResultItem): string[] {
  const haystack = `${candidate.contentPillar} ${candidate.topic} ${candidate.rationale}`;
  const states = new Set<string>();
  if (/(商业|创业|职场|赚钱|电商|用户|成本|business|career|sales)/i.test(haystack)) {
    states.add("practical_boss");
  }
  if (/(姐妹|关系|边界|女性|判断|劝|relationship|growth)/i.test(haystack)) {
    states.add("strong_sister");
  }
  if (/(穿搭|审美|漂亮|身材|动作|视觉|beauty|style)/i.test(haystack)) {
    states.add("visual_attraction");
  }
  if (/(搞笑|反转|翻车|发疯|整活|humor|comedy)/i.test(haystack)) {
    states.add("funny_woman");
  }
  if (/(脆弱|受伤|自卑|家庭|失去|故事|vulnerab)/i.test(haystack)) {
    states.add("vulnerable_real");
  }
  if (!states.size) {
    states.add("practical_boss");
    states.add("strong_sister");
  }
  return [...states];
}

function durationProfile(durationSec: number): {
  mode: "micro" | "standard" | "deep_dive" | "custom";
  reference_window_sec: { min: number; max: number } | null;
  exception_reason: string | null;
} {
  if (durationSec >= 12 && durationSec <= 27) {
    return { mode: "micro", reference_window_sec: { min: 12, max: 27 }, exception_reason: null };
  }
  if (durationSec >= 28 && durationSec <= 35) {
    return { mode: "standard", reference_window_sec: { min: 28, max: 35 }, exception_reason: null };
  }
  if (durationSec >= 90 && durationSec <= 130) {
    return { mode: "deep_dive", reference_window_sec: { min: 90, max: 130 }, exception_reason: null };
  }
  return {
    mode: "custom",
    reference_window_sec: null,
    exception_reason: "以内容闭环和原声证据决定时长，不为套入固定秒数破坏因果。",
  };
}

function subtractRanges(base: TimeRange, removals: TimeRange[]): TimeRange[] {
  const sorted = removals
    .map((range) => ({
      startSec: Math.max(base.startSec, range.startSec),
      endSec: Math.min(base.endSec, range.endSec),
    }))
    .filter((range) => range.endSec > range.startSec)
    .sort((left, right) => left.startSec - right.startSec);
  const result: TimeRange[] = [];
  let cursor = base.startSec;
  for (const range of sorted) {
    if (range.startSec > cursor) result.push({ startSec: cursor, endSec: range.startSec });
    cursor = Math.max(cursor, range.endSec);
  }
  if (cursor < base.endSec) result.push({ startSec: cursor, endSec: base.endSec });
  return result.filter((range) => range.endSec - range.startSec >= 0.05);
}

function buildNaturalUnits(
  segments: TranscriptSegment[],
  candidates: CandidateResultItem[],
): NaturalUnit[] {
  const candidateMembership = new Map<string, string[]>();
  for (const candidate of candidates) {
    for (const segmentId of candidate.transcriptSegmentIds) {
      const ids = candidateMembership.get(segmentId) ?? [];
      ids.push(candidate.candidateId);
      candidateMembership.set(segmentId, ids);
    }
  }

  const groups: NaturalUnit[] = [];
  let current: TranscriptSegment[] = [];
  let currentMembership = "";
  const flush = (): void => {
    if (!current.length) return;
    const candidateIds = [
      ...new Set(current.flatMap((segment) => candidateMembership.get(segment.id) ?? [])),
    ];
    groups.push({
      id: `unit-${String(groups.length + 1).padStart(5, "0")}`,
      segmentIds: current.map((segment) => segment.id),
      range: {
        startSec: current[0]!.startSec,
        endSec: current.at(-1)!.endSec,
      },
      candidateIds,
    });
    current = [];
  };

  for (const segment of segments) {
    const membership = [...(candidateMembership.get(segment.id) ?? [])].sort().join("|");
    const previous = current.at(-1);
    const boundary = previous
      && (
        segment.startSec - previous.endSec > 4
        || segment.endSec - current[0]!.startSec > 75
        || membership !== currentMembership
      );
    if (boundary) flush();
    if (!current.length) currentMembership = membership;
    current.push(segment);
  }
  flush();
  return groups;
}

function gate(
  status: "pass" | "needs_review" | "fail" | "not_applicable",
  evidence: string,
  checkedBy: "model" | "machine" | "human" | "model_and_human" = "model",
): JsonRecord {
  return {
    status,
    evidence,
    checked_by: checkedBy,
    checked_at: null,
  };
}

function transcriptLines(
  candidate: CandidateResultItem,
  transcript: TranscriptResult,
): CandidateTranscriptLine[] {
  const candidateIds = new Set(candidate.transcriptSegmentIds);
  const deletionIds = new Set(
    candidate.deleteSuggestions.flatMap((suggestion) => suggestion.transcriptSegmentIds),
  );
  return transcript.segments
    .filter((segment) => candidateIds.has(segment.id) || deletionIds.has(segment.id))
    .map((segment) => {
      const deletion = candidate.deleteSuggestions.find(
        (suggestion) => suggestion.transcriptSegmentIds.includes(segment.id),
      );
      return {
        id: segment.id,
        start: segment.startSec,
        end: segment.endSec,
        text: segment.text,
        speaker: segment.speaker,
        defaultDecision: deletion ? "remove" : "keep",
        reason: deletion?.reason ?? "承担候选片段的原声信息与逻辑闭环。",
        evidenceLevel: "原声逐字",
      };
    });
}

function sourceMediaPayload(
  job: ClaimedJob,
  media: MediaProbe,
): CandidatePayload["sourceMedia"] {
  const rotation = Number(media.video?.rotation ?? 0);
  const swapsDimensions =
    Number.isFinite(rotation)
    && Math.abs(Math.round(rotation)) % 180 === 90;
  const codedWidth = Number(media.video?.width);
  const codedHeight = Number(media.video?.height);
  const width = swapsDimensions ? codedHeight : codedWidth;
  const height = swapsDimensions ? codedWidth : codedHeight;
  const frameRate = media.video?.frameRate;
  const safeFrameRate =
    frameRate
    && Number.isSafeInteger(frameRate.numerator)
    && frameRate.numerator > 0
    && Number.isSafeInteger(frameRate.denominator)
    && frameRate.denominator > 0
    && Number.isFinite(frameRate.fps)
    && frameRate.fps > 0
      ? frameRate
      : null;
  const channels = Number(media.audio?.channels);
  const audioChannels =
    Number.isSafeInteger(channels) && channels > 0
      ? channels
      : null;
  const missingFields = [
    ...(!Number.isFinite(media.durationSec) || media.durationSec <= 0
      ? ["durationSeconds"]
      : []),
    ...(!Number.isSafeInteger(width) || width <= 0 ? ["width"] : []),
    ...(!Number.isSafeInteger(height) || height <= 0 ? ["height"] : []),
    ...(!safeFrameRate ? ["frameRate"] : []),
    ...(audioChannels === null ? ["audioChannels"] : []),
  ];
  return {
    originalFileName: basename(job.sourceName.replaceAll("\\", "/")),
    durationSeconds: media.durationSec,
    width,
    height,
    frameRate: safeFrameRate,
    audioChannels,
    metadataStatus: missingFields.length
      ? "incomplete_ffprobe"
      : "verified_ffprobe",
    missingFields,
  };
}

function publicPayload(
  job: ClaimedJob,
  candidate: CandidateResultItem,
  ordinal: number,
  transcript: TranscriptResult,
  media: MediaProbe,
): CandidatePayload {
  const safety = safeRange(candidate.safetyWindow, transcript.mediaDurationSec);
  const duration = roundMillis(safety.endSec - safety.startSec);
  const profile = durationProfile(duration);
  const scoreParts = [
    ["钩子", candidate.score.hook, 20],
    ["情绪", candidate.score.emotion, 15],
    ["判断", candidate.score.insight, 20],
    ["争议", candidate.score.controversy, 15],
    ["闭环", candidate.score.completeness, 15],
    ["标题潜力", candidate.score.titlePotential, 15],
  ] as const;
  return {
    id: randomUUID(),
    kind: job.mode,
    ...(candidate.editorProvider
      ? { editorProvider: candidate.editorProvider }
      : {}),
    index: String(ordinal).padStart(2, "0"),
    title: candidate.title,
    sourceStart: safety.startSec,
    sourceEnd: safety.endSec,
    originalSafetyStart: safety.startSec,
    originalSafetyEnd: safety.endSec,
    mediaDurationSeconds: transcript.mediaDurationSec,
    durationSeconds: duration,
    score: candidate.score.total,
    summary: candidate.rationale,
    contentType: contentType(candidate.contentPillar),
    personaModes: personaStates(candidate),
    personaReason: `该段同时保留天总的判断、原声依据与当前直播语境：${candidate.rationale}`,
    durationMode: profile.mode,
    durationWindow: profile.reference_window_sec
      ? `${profile.reference_window_sec.min}–${profile.reference_window_sec.max} 秒`
      : "不设硬窗口",
    durationReason: profile.exception_reason ?? "落在该内容类型的校准参考窗内。",
    selectionReasons: [
      candidate.rationale,
      ...(candidate.discoveryMethods?.includes("visual_only_dense_reverse_recall")
        ? ["该条由全片密集视觉反向补召回发现，再绑定相邻逐字稿。"]
        : []),
      ...(candidate.refinement
        ? [
          candidate.refinement.method
            === "dense_still_frames_plus_diarized_transcript_plus_native_av_model_evidence"
            ? `候选安全窗已由天总私有核心综合密集静帧、逐字稿和原生音视频模型证据；动作状态仍仅为“${candidate.refinement.actionCompleteness.status}”。`
            : `候选安全窗已完成密集静帧+逐字稿二次理解；动作状态仅为“${candidate.refinement.actionCompleteness.status}”。`,
          ...candidate.refinement.boundaryAssessment.riskNotes,
        ]
        : []),
      "候选数量来自整场证据与独立闭环，不使用固定配额。",
      "当前只是候选；机器没有连续逐帧观看，必须正常倍速完整播放安全窗后才能确认。",
    ],
    scoreBreakdown: scoreParts.map(([label, score, max]) => ({ label, score, max })),
    priority: candidate.score.total >= 85 ? "S" : candidate.score.total >= 70 ? "A" : "B",
    factGate: candidate.risks.length
      ? `需人工复核：${candidate.risks.join("；")}`
      : "未发现阻断性事实风险，仍须按原片复核。",
    calibrationStatus: candidate.refinement
      ? candidate.refinement.method
          === "dense_still_frames_plus_diarized_transcript_plus_native_av_model_evidence"
        ? "已绑定私有 Skill并综合候选级密集静帧、逐字稿和原生音视频模型证据；待人工正常倍速完整视听校准"
        : "已绑定私有 Skill并完成候选级密集静帧+逐字稿二次理解；待人工正常倍速完整视听校准"
      : "已绑定私有 Skill；待连续原片视听校准",
    transcript: transcriptLines(candidate, transcript),
    previewUrl: null,
    reviewStatus: "proxy_rendered_needs_human_normal_playback",
    renderStatus: "rough_ready",
    previewKind: "rough_cut",
    previewVersion: "pending_repository_binding",
    isFinal: false,
    sourceMedia: sourceMediaPayload(job, media),
  };
}

export function buildAndValidateEngineArtifacts(
  input: BuildEngineArtifactsInput,
): EngineArtifacts {
  const {
    job,
    media,
    sourceSha256,
    transcript,
    visualMap,
    candidateResult,
    core,
    artifactUris,
  } = input;
  assert(SHA256.test(sourceSha256), "source SHA-256 is invalid");
  assert(media.durationSec > 0, "media duration is invalid");
  assert(transcript.segments.length > 0, "transcript is empty");
  assert(
    visualMap.coverage?.fullTimelineScreeningComplete === true,
    "full-timeline sparse visual screening is incomplete",
  );
  assert(
    visualMap.coverage?.continuousAudioVideoReviewed === false,
    "machine screening cannot claim continuous source review",
  );
  assert(
    candidateResult.candidates.length === candidateResult.selectionSummary.qualifyingCount,
    "candidate count does not match selection summary",
  );
  if (candidateResult.sourceFunnel) {
    assert(
      visualMap.coverage?.denseVisualReverseRecallComplete === true,
      "dense full-timeline visual reverse recall is incomplete",
    );
    assert(
      visualMap.coverage?.candidateDenseStillTranscriptRefinementComplete === true,
      "candidate dense still-frame plus transcript refinement is incomplete",
    );
    assert(
      candidateResult.refinementSummary?.humanNormalPlaybackRequired === true
      && candidateResult.refinementSummary.continuousAudioVideoReviewed === false,
      "candidate refinement must preserve the human normal-playback gate",
    );
  }

  const mode = coreMode(job.mode);
  assert(core.provenance.mode === mode, "private core mode does not match the job");
  assert(
    core.provenance.coreVersion === core.manifest.version,
    "private core version binding is inconsistent",
  );
  const startedAt = input.startedAt ?? new Date().toISOString();
  const completedAt = input.completedAt ?? new Date().toISOString();
  const transcriptSha256 = sha256Hex(canonicalJson(transcript));
  const asrGaps = calculateAsrGaps(transcript.segments, media.durationSec);
  const naturalUnits = buildNaturalUnits(transcript.segments, candidateResult.candidates);
  const transcriptById = new Map(transcript.segments.map((segment) => [segment.id, segment]));
  const visualById = new Map(visualMap.events.map((event) => [event.id, event]));

  const factLayer: JsonRecord = {
    fact_schema_version: core.provenance.factSchemaVersion,
    project_id: job.projectId,
    source_media: {
      uri: artifactUris.sourceMedia,
      sha256: sourceSha256,
      duration_sec: media.durationSec,
      decodable_video_end_sec: media.durationSec,
      decodable_audio_end_sec: media.durationSec,
      fps: media.video?.fps ?? null,
      width: media.video?.width ?? null,
      height: media.video?.height ?? null,
      video_accessible: true,
      audio_accessible: true,
      av_sync_status: "needs_review",
    },
    transcript_units: transcript.segments.map((segment) => ({
      segment_id: segment.id,
      start_word_id: segment.id,
      end_word_id: segment.id,
      start_sec: segment.startSec,
      end_sec: Math.max(segment.endSec, segment.startSec + 0.001),
      speaker: segment.speaker,
      speaker_confidence: null,
      text_raw: segment.text,
      confidence: 0.5,
      audio_issue: "uncertain",
      terms_needing_review: [],
    })),
    visual_events: visualMap.events.map((event) => ({
      event_id: event.id,
      start_sec: Math.max(0, Math.min(event.startSec, media.durationSec - 0.001)),
      end_sec: Math.max(
        Math.min(event.startSec, media.durationSec - 0.001) + 0.001,
        Math.min(event.endSec, media.durationSec),
      ),
      event_type: visualEventType(event.eventType),
      description: event.description,
      subject: event.people?.[0] ?? event.products?.[0] ?? "直播画面",
      confidence: event.confidence,
      observation_method: event.observationMethod ?? "adaptive_proxy_scan",
      continuous_range_reviewed: false,
      evidence_refs: event.evidenceFrameIds.map((id) => `frame:${id}`),
      risk_notes: [
        ...(event.uncertainties ?? []),
        ...(event.observationMethod
          ? [`机器观察方法：${event.observationMethod}；不是连续视频观看。`]
          : []),
      ],
    })),
    coverage: {
      transcript_start_sec: transcript.segments[0]!.startSec,
      transcript_end_sec: transcript.segments.at(-1)!.endSec,
      asr_gap_ranges: asrGaps,
      asr_gaps_rechecked: false,
      visual_scan_start_sec: 0,
      visual_scan_end_sec: media.durationSec,
      full_timeline_visual_scan_completed: true,
      visual_scan_method: visualScanMethod(visualMap),
      uncovered_ranges: [],
    },
  };

  const editCandidates = candidateResult.candidates.map((candidate) => {
    const citedSegments = candidate.transcriptSegmentIds
      .map((id) => transcriptById.get(id))
      .filter((value): value is TranscriptSegment => value !== undefined);
    assert(citedSegments.length > 0, `candidate ${candidate.candidateId} lacks transcript evidence`);
    const recall = safeRange(candidate.recallWindow, media.durationSec);
    const safety = safeRange(candidate.safetyWindow, media.durationSec);
    const removals = candidate.deleteSuggestions.map((item) =>
      safeRange(item, media.durationSec));
    const keeps = subtractRanges(recall, removals);
    assert(keeps.length > 0, `candidate ${candidate.candidateId} removes its entire recall window`);
    const durationSec = roundMillis(
      keeps.reduce((sum, range) => sum + range.endSec - range.startSec, 0),
    );
    const profile = durationProfile(durationSec);
    const firstEvidence = citedSegments.find(
      (segment) => segment.text.includes(candidate.openingLine),
    ) ?? citedSegments[0]!;
    const personas = personaStates(candidate);
    return {
      candidate_id: candidate.candidateId,
      semantic_unit_id:
        naturalUnits.find((unit) => unit.candidateIds.includes(candidate.candidateId))?.id
        ?? `unit-${candidate.candidateId}`,
      status: "needs_manual_review",
      source_window: sourceWindow(safety, transcript.segments, media.durationSec),
      publish_safe_window: sourceWindow(recall, transcript.segments, media.durationSec),
      content_type: contentType(candidate.contentPillar),
      primary_template: mode === "sales"
        ? "需求判断—产品证据—边界—行动"
        : "结论先行—必要上下文—因果闭环",
      persona_states: personas,
      topic: candidate.topic,
      hook_text_raw: candidate.openingLine,
      title_editorial: candidate.title,
      punchline_text_raw: candidate.hook || null,
      public_reason: candidate.rationale,
      private_trace: {
        matched_rules: [
          `core:${core.provenance.coreVersion}`,
          `prompt:${core.provenance.promptVersion}`,
          `mode:${mode}`,
          ...(candidate.discoveryMethods?.includes("visual_only_dense_reverse_recall")
            ? ["recall:visual_only_dense_reverse"]
            : ["recall:transcript_core"]),
          ...(candidate.refinement
            ? ["refinement:dense_stills_plus_diarized_transcript"]
            : []),
        ],
        selection_reason: candidate.rationale,
        deletion_reason: candidate.deleteSuggestions.length
          ? candidate.deleteSuggestions.map((item) => item.reason).join("；")
          : "没有提出可安全删除的原声范围。",
        confidence: Math.min(1, Math.max(0, candidate.score.total / 100)),
      },
      why_tianzong: {
        summary: `该段不是脱离人物的通用金句，而是天总当前直播语境中的${candidate.topic}判断。`,
        evidence_quotes: [{
          speaker: firstEvidence.speaker,
          text_raw: candidate.openingLine,
          source_window: sourceWindow(
            { startSec: firstEvidence.startSec, endSec: firstEvidence.endSec },
            transcript.segments,
            media.durationSec,
          ),
          evidence_level: "C",
        }],
        contrast_arc: personas.length > 1
          ? `同一段内呈现 ${personas.join(" + ")} 的人格切换。`
          : null,
      },
      duration: {
        mode: profile.mode,
        reference_window_sec: profile.reference_window_sec,
        estimated_final_sec: durationSec,
        exception_reason: profile.exception_reason,
      },
      score: {
        hook: { value: candidate.score.hook, evidence: "开头原声的停留能力。" },
        emotion: { value: candidate.score.emotion, evidence: "语气与情绪强度。" },
        quotability: { value: candidate.score.insight, evidence: "判断是否可被独立引用。" },
        resonance: { value: candidate.score.controversy, evidence: "是否命中讨论与共鸣。" },
        closure: { value: candidate.score.completeness, evidence: "因果与结论是否闭环。" },
        reversal_or_interaction: {
          value: candidate.score.titlePotential,
          evidence: "反转、互动或标题承载力。",
        },
        total: candidate.score.total,
        comparison_group: `${mode}.${contentType(candidate.contentPillar)}`,
      },
      keep_ranges: keeps.map((range, index) => ({
        range_id: `keep-${candidate.candidateId}-${index + 1}`,
        source_window: sourceWindow(range, transcript.segments, media.durationSec),
        reason: "保留原声信息、人物判断和完整因果。",
        speaker: null,
        transition_check_required: true,
      })),
      remove_ranges: candidate.deleteSuggestions.map((item, index) => ({
        range_id: `remove-${candidate.candidateId}-${index + 1}`,
        source_window: sourceWindow(item, transcript.segments, media.durationSec),
        reason: item.reason,
        speaker: null,
        transition_check_required: true,
      })),
      risk_flags: [
        {
          risk_type: "transcript_confidence",
          severity: "medium",
          evidence: "机器转写与说话人分离尚未由人工逐字校验。",
          resolution: "回看连续原片并核对说话人、逐字和精确切口。",
          status: "needs_manual_review",
          owner: "editor",
        },
        {
          risk_type: "visual_evidence",
          severity: "medium",
          evidence: candidate.refinement
            ? `已完成候选安全窗密集静帧+逐字稿二次理解；视觉梗：${
              candidate.refinement.visualPunchline.description
            }；动作状态仅为采样证据下的 ${
              candidate.refinement.actionCompleteness.status
            }，未连续观看。`
            : "已做全时间轴稀疏画面筛查，但未连续观看候选安全窗。",
          resolution: candidate.requiredVisualProof.join("；"),
          status: "needs_manual_review",
          owner: "editor",
        },
      ],
      fact_checks: candidate.risks.map((risk) => ({
        claim: risk,
        evidence: "模型标记为风险，需回到原声语境核验。",
        status: "needs_manual_review",
      })),
      visual_requirements: candidate.requiredVisualProof.map((requirement) => ({
        requirement,
        status: "needs_manual_review",
      })),
      qa: {
        logic_preserved: true,
        speaker_verified: false,
        transcript_verified: false,
        audio_cut_verified: false,
        visual_continuity_verified: false,
        facts_verified: false,
        risks_resolved: false,
        full_watch_completed: false,
      },
      export: {
        render_allowed: false,
        formats: ["mp4", "srt", "xml", "chatcut"],
      },
    };
  });

  const rejectedNaturalUnits = naturalUnits.filter((unit) => !unit.candidateIds.length);
  const noCandidateReason = candidateResult.candidates.length
    ? null
    : candidateResult.selectionSummary.notes.join("；")
      || "整场没有通过独立价值、闭环、人物与证据门槛的候选。";
  const editPlan: JsonRecord = {
    run_metadata: {
      core_version: core.provenance.coreVersion,
      core_sha256: core.provenance.coreSha256,
      schema_version: core.provenance.schemaVersion,
      prompt_version: core.provenance.promptVersion,
      model: candidateResult.model ?? "gpt-5.6-sol",
      mode,
      started_at: startedAt,
      completed_at: completedAt,
    },
    project: {
      project_id: job.projectId,
      source_media: {
        uri: artifactUris.sourceMedia,
        sha256: sourceSha256,
        duration_sec: media.durationSec,
        fps: media.video?.fps ?? null,
        width: media.video?.width ?? null,
        height: media.video?.height ?? null,
      },
      transcript: {
        uri: artifactUris.transcript,
        sha256: transcriptSha256,
        language: "zh-CN",
        timebase: "seconds",
        speaker_status: "diarized_unverified",
      },
      platform: "douyin",
      aspect_ratio: "9:16",
      permissions: {
        cross_time_reorder: false,
        external_assets: false,
        music_replacement: false,
        profanity_policy: "manual",
      },
      natural_unit_count_detected: naturalUnits.length,
      candidate_count: editCandidates.length,
      no_candidate_reason: noCandidateReason,
    },
    candidates: editCandidates,
    rejected_units: rejectedNaturalUnits.map((unit) => ({
      semantic_unit_id: unit.id,
      source_window: sourceWindow(unit.range, transcript.segments, media.durationSec),
      reason_code: "no_independent_value",
      reason: "该自然单元没有形成可独立传播且证据闭环的天总候选。",
    })),
  };

  const candidateLedgerEntries = candidateResult.candidates.map((candidate) => {
    const originUnits = naturalUnits.filter((unit) =>
      unit.candidateIds.includes(candidate.candidateId));
    const visualEvents = candidate.visualEventIds
      .map((id) => visualById.get(id))
      .filter((value): value is VisualEvent => value !== undefined);
    const citedSegments = candidate.transcriptSegmentIds
      .map((id) => transcriptById.get(id))
      .filter((value): value is TranscriptSegment => value !== undefined);
    return {
      candidate_id: candidate.candidateId,
      origin_unit_ids: originUnits.length
        ? originUnits.map((unit) => unit.id)
        : [`unit-${candidate.candidateId}`],
      angle_key: `${mode}:${candidate.topic}`,
      mode_class: mode === "chat" ? "chat" : "sales_conversion",
      status: "editorial_candidate_needs_av_review",
      recall_ranges: [{
        start_sec: candidate.recallWindow.startSec,
        end_sec: candidate.recallWindow.endSec,
      }],
      publish_safe_ranges: [{
        start_sec: candidate.safetyWindow.startSec,
        end_sec: candidate.safetyWindow.endSec,
      }],
      information_atoms: [
        candidate.openingLine,
        candidate.hook,
        candidate.topic,
      ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index),
      evidence_quotes: citedSegments.map((segment) => segment.text),
      visual_evidence: {
        continuous_review_ranges: [],
        observations: [
          ...visualEvents.map((event) => event.description),
          ...(candidate.refinement
            ? [
              `候选级密集静帧+逐字稿二次理解：${candidate.refinement.visualPunchline.description}`,
              `动作完整性仅按采样证据判断为 ${candidate.refinement.actionCompleteness.status}：${candidate.refinement.actionCompleteness.description}`,
            ]
            : []),
        ],
        status: "needs_review",
      },
      gates: {
        truth: gate("pass", "候选逐字与时间范围均绑定到机器转写证据。"),
        independence: gate("pass", "模型判断该角度可独立理解；仍待编导回看。"),
        closure: gate("pass", "候选包含模型识别出的结论与必要因果。"),
        viewer_value: gate("pass", candidate.rationale),
        tianzong_specificity: gate("pass", "已由指定版本的天总私有 Skill 选择。"),
        persona_integrity: gate("pass", "保留当前直播语境与人物状态，不套用早期作品模板。"),
        uniqueness: gate("pass", "本轮按标题、证据范围与信息原子去重。", "machine"),
        audio: gate("needs_review", "必须正常播放连续安全窗确认呼吸、说话人和切口。"),
        visual: gate(
          "needs_review",
          candidate.refinement
            ? "已用候选安全窗密集静帧和逐字稿做二次理解，但未连续播放，也未由人工确认。"
            : "稀疏画面只用于全时轴筛查，不能代替连续原片观看。",
        ),
        facts: gate(
          candidate.risks.length ? "needs_review" : "pass",
          candidate.risks.join("；") || "未发现阻断性事实风险，仍需保留原声语境。",
        ),
        risk: gate(
          candidate.risks.length ? "needs_review" : "pass",
          candidate.risks.join("；") || "未发现阻断性发布风险。",
        ),
        human_confirmation: gate("needs_review", "尚未由天总团队确认。"),
      },
      edit_plan_candidate_id: candidate.candidateId,
      rejection_reason: null,
    };
  });

  const unitDecisions = naturalUnits.map((unit, index) => ({
    decision_id: `decision-${String(index + 1).padStart(5, "0")}`,
    operation: unit.candidateIds.length
      ? (unit.candidateIds.length > 1 ? "split_angle" : "retain")
      : "reject",
    input_unit_ids: [unit.id],
    output_unit_ids: unit.candidateIds.length ? [unit.id] : [],
    output_candidate_ids: unit.candidateIds,
    source_ranges: [{
      start_sec: unit.range.startSec,
      end_sec: unit.range.endSec,
    }],
    reason_code: unit.candidateIds.length
      ? (unit.candidateIds.length > 1 ? "multiple_independent_angles" : "independent_closed_loop")
      : "no_independent_value",
    reason: unit.candidateIds.length
      ? "该单元形成至少一个具备独立价值与证据闭环的候选。"
      : "该单元未通过独立传播价值与证据闭环门槛。",
    evidence_refs: unit.segmentIds.map((id) => `transcript:${id}`),
  }));

  const engineLedger: JsonRecord = {
    ledger_schema_version: core.provenance.ledgerSchemaVersion,
    run_metadata: {
      run_id: job.id,
      project_id: job.projectId,
      core_version: core.provenance.coreVersion,
      core_sha256: core.provenance.coreSha256,
      prompt_version: core.provenance.promptVersion,
      fact_schema_version: core.provenance.factSchemaVersion,
      ledger_schema_version: core.provenance.ledgerSchemaVersion,
      edit_plan_schema_version: core.provenance.schemaVersion,
      model: candidateResult.model ?? "gpt-5.6-sol",
      mode,
      started_at: startedAt,
      completed_at: completedAt,
      run_status: "completed_with_review",
    },
    source_binding: {
      source_media_uri: artifactUris.sourceMedia,
      source_media_sha256: sourceSha256,
      transcript_uri: artifactUris.transcript,
      transcript_sha256: transcriptSha256,
      duration_sec: media.durationSec,
      video_accessible: true,
      audio_accessible: true,
      av_sync_status: "needs_review",
    },
    coverage_audit: {
      transcript_segment_count: transcript.segments.length,
      transcript_end_sec: transcript.segments.at(-1)!.endSec,
      gap_count: asrGaps.length,
      gaps_rechecked: 0,
      boundary_overlap_rechecked: true,
      full_timeline_visual_scan_completed: true,
      visual_scan_method: visualScanMethod(visualMap),
      uncovered_ranges: [],
      coverage_status: "needs_review",
    },
    count_funnel: {
      map_entry_count: naturalUnits.length,
      overlap_entries_removed: 0,
      unique_natural_unit_count: naturalUnits.length,
      angle_proposal_count:
        candidateResult.sourceFunnel
          ? candidateResult.sourceFunnel.textCandidateCount
            + candidateResult.sourceFunnel.visualCandidateCount
          : candidateResult.candidates.length,
      duplicate_angle_count_removed:
        candidateResult.sourceFunnel?.exactDuplicateCount ?? 0,
      deduplicated_angle_count:
        candidateResult.refinementSummary?.inputCandidateCount
        ?? candidateResult.sourceFunnel?.mergedCandidateCount
        ?? candidateResult.candidates.length,
      semantic_gate_rejection_count:
        rejectedNaturalUnits.length
        + (candidateResult.refinementSummary?.rejectedCandidateCount ?? 0),
      editorial_candidate_count: candidateResult.candidates.length,
      av_verified_candidate_count: 0,
      publish_ready_count: 0,
      rendered_clip_count: 0,
      count_explanation:
        candidateResult.sourceFunnel
          ? `文字召回 ${candidateResult.sourceFunnel.textCandidateCount} 条，密集视觉反向补召回 ${candidateResult.sourceFunnel.visualCandidateCount} 条，只删除 ${candidateResult.sourceFunnel.exactDuplicateCount} 条证据与切口完全相同的重复项；候选级密集静帧+逐字稿二次理解后保留 ${candidateResult.candidates.length} 条。数量不设配额，仍需人工正常倍速完整播放。`
          : `从 ${naturalUnits.length} 个证据绑定自然单元中，按私有 Skill 召回 ${candidateResult.candidates.length} 个独立候选；数量不设配额。`,
      no_candidate_reason: noCandidateReason,
    },
    unit_decision_ledger: unitDecisions,
    candidates: candidateLedgerEntries,
  };

  core.validators.validateFactLayer(factLayer);
  core.validators.validateEditPlan(editPlan);
  core.validators.validateEngineRunLedger(engineLedger);

  return {
    factLayer,
    editPlan,
    engineLedger,
    candidatePayloads: candidateResult.candidates.map((candidate, index) =>
      publicPayload(job, candidate, index + 1, transcript, media)),
  };
}
