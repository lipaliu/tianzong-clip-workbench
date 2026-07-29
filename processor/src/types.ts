export type TianClipMode = "聊播" | "带货";
export type EditorialModelMode = "openai" | "doubao" | "compare";
export type JobStatus =
  | "queued"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ProjectApi = {
  id: string;
  title: string;
  projectDate: string;
  sourceName: string;
  mode: TianClipMode;
  editorMode: EditorialModelMode;
  status: string;
  stage: string;
  progress: number;
  clipCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JobApi = {
  id: string;
  projectId: string;
  uploadId: string;
  status: JobStatus;
  stage: string;
  progress: number;
  clipCount: number;
  error: string | null;
  attempt: number;
  maxAttempts: number;
  coreVersion: string | null;
  coreSha256: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type CandidateTranscriptLine = {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker: string;
  defaultDecision: "keep" | "remove";
  reason: string;
  evidenceLevel: "原声逐字" | "逐字稿摘录" | "策划摘要";
};

export type CandidateScorePart = {
  label: string;
  score: number;
  max: number;
};

export type CandidateSourceMedia = {
  originalFileName: string;
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: {
    numerator: number;
    denominator: number;
    rational: string;
    fps: number;
    source: "avg_frame_rate" | "r_frame_rate";
  } | null;
  audioChannels: number | null;
  metadataStatus: "verified_ffprobe" | "incomplete_ffprobe";
  missingFields: string[];
};

export type CandidatePayload = {
  id: string;
  kind: TianClipMode;
  index: string;
  title: string;
  sourceStart: number;
  sourceEnd: number;
  /**
   * Immutable machine-selected safety bounds. Older stored candidates may not
   * have these fields; render validation then falls back to sourceStart/end,
   * which is stricter after a revision.
   */
  originalSafetyStart?: number;
  originalSafetyEnd?: number;
  mediaDurationSeconds?: number;
  durationSeconds: number;
  score: number;
  summary: string;
  contentType: string;
  personaModes: string[];
  personaReason: string;
  durationMode: "micro" | "standard" | "deep_dive" | "custom";
  durationWindow: string;
  durationReason: string;
  selectionReasons: string[];
  scoreBreakdown: CandidateScorePart[];
  priority: "S" | "A" | "B";
  factGate: string;
  calibrationStatus: string;
  transcript: CandidateTranscriptLine[];
  previewUrl: string | null;
  reviewStatus: CandidateReviewStatus;
  renderStatus: CandidateRenderStatus;
  previewKind: "rough_cut" | "revised_cut";
  previewVersion: string;
  isFinal: boolean;
  sourceMedia: CandidateSourceMedia;
  editorProvider?: "openai" | "doubao";
};

export type CandidateReviewStatus =
  | "editorial_candidate_needs_av_review"
  | "proxy_rendered_needs_human_normal_playback"
  | "human_review_needs_changes"
  | "human_review_rejected"
  | "human_av_verified_normal_playback";

export type CandidateRenderStatus =
  | "rough_ready"
  | "revision_queued"
  | "revision_rendering"
  | "revision_ready"
  | "render_failed";

export type ClaimedJob = {
  id: string;
  workerId: string;
  projectId: string;
  uploadId: string;
  objectKey: string;
  sourceName: string;
  expectedSizeBytes: number;
  expectedSha256: string | null;
  mode: TianClipMode;
  editorMode: EditorialModelMode;
  attempt: number;
  maxAttempts: number;
};

export type CandidateRenderSpec = {
  sourceStart: number;
  sourceEnd: number;
  transcriptDecisions: Array<{
    lineId: string;
    decision: "keep" | "remove";
    reason?: string;
  }>;
  title?: string;
  notes?: string;
};

export type ClaimedRender = {
  id: string;
  workerId: string;
  candidateId: string;
  projectId: string;
  uploadId: string;
  objectKey: string;
  spec: CandidateRenderSpec;
  approvalTarget: boolean;
  attempt: number;
  maxAttempts: number;
  payload: CandidatePayload;
};

export type TranscriptSegment = {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker: string;
};

export type VisualEvent = {
  timestamp: number;
  description: string;
  participants: string[];
  action: string;
  expression: string;
  product: string;
  visualQuality: "usable" | "uncertain" | "unusable";
  risks: string[];
};

export type CandidateProposal = {
  sourceStart: number;
  sourceEnd: number;
  title: string;
  summary: string;
  contentType: string;
  personaModes: string[];
  personaReason: string;
  selectionReasons: string[];
  transcript: CandidateTranscriptLine[];
  scoreBreakdown: CandidateScorePart[];
  factGate: string;
  durationReason: string;
  calibrationStatus: string;
  reviewStatus: "editorial_candidate_needs_av_review";
  visualEvidence: Record<string, unknown>;
};
