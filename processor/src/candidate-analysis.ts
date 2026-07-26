import type { LoadedTianClipCore } from "./core/index.js";
import { generateCandidates } from "./pipeline/candidates.mjs";

type TranscriptLike = {
  mediaDurationSec: number;
  segments: Array<{
    id: string;
    startSec: number;
    endSec: number;
    text: string;
    speaker: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

type VisualMapLike = {
  durationSec: number;
  events: Array<{
    id: string;
    startSec: number;
    endSec: number;
    [key: string]: unknown;
  }>;
  coverage: {
    fullTimelineScreeningComplete: true;
    continuousAudioVideoReviewed: false;
    limitation: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type CandidateLike = {
  candidateId: string;
  recallWindow: { startSec: number; endSec: number };
  safetyWindow: { startSec: number; endSec: number };
  openingLine: string;
  score: { total: number };
  [key: string]: unknown;
};

type OpenAIClientLike = {
  createStructuredResponse: (...args: any[]) => Promise<any>;
};

type RecallRun = {
  batchId: string;
  index: number;
  ownershipStartSec: number;
  ownershipEndSec: number;
  evidenceStartSec: number;
  evidenceEndSec: number;
  naturalBoundaryReason: string;
  transcriptSegmentCount: number;
  sparseVisualEventCount: number;
  recalledCount: number;
  responseId: string | null;
  model: string;
  usage: unknown;
};

type GeneratedCandidates = {
  candidates: CandidateLike[];
  selectionSummary: {
    qualifyingCount: number;
    rejectedThemes: string[];
    notes: string[];
  };
  recallRuns: RecallRun[];
};

/**
 * Compatibility wrapper for the worker.
 *
 * Window planning, private-core binding, evidence scoping, conservative global
 * merge/deduplication and progress are intentionally owned by
 * generateCandidates. Keeping a second fixed-window/deduplication layer here
 * previously allowed high-overlap but genuinely different editorial angles to
 * be discarded.
 */
export async function analyzeCandidateWindows(options: {
  transcript: TranscriptLike;
  visualMap: VisualMapLike;
  core: LoadedTianClipCore;
  mode: "chat" | "sales";
  client: OpenAIClientLike;
  model: "gpt-5.6-sol";
  analysisWindowSeconds: number;
  safetyIdentifier: string;
  onProgress?: (progress: {
    completed: number;
    total: number;
  }) => Promise<void>;
}): Promise<{
  candidates: CandidateLike[];
  selectionSummary: {
    qualifyingCount: number;
    rejectedThemes: string[];
    notes: string[];
  };
  windowRuns: Array<Record<string, unknown>>;
  mode: "chat" | "sales";
  coreBinding: LoadedTianClipCore["provenance"];
}> {
  const {
    transcript,
    visualMap,
    core,
    mode,
    client,
    model,
    analysisWindowSeconds,
    safetyIdentifier,
  } = options;

  const overlapSec = Math.min(
    60,
    Math.max(10, analysisWindowSeconds * 0.1),
  );
  const coreBundle = {
    coreId: core.provenance.coreId,
    coreVersion: core.provenance.coreVersion,
    coreSha256: core.provenance.coreSha256,
    promptVersion: core.provenance.promptVersion,
    privateKnowledge: core.prompt.text,
    modeRules:
      `执行已绑定的 ${mode} 私有 prompt bundle；不得退回通用短视频规则。`,
  };
  const generate = generateCandidates as (
    value: Record<string, unknown>
  ) => Promise<GeneratedCandidates>;
  const result = await generate({
    transcript,
    visualMap,
    coreBundle,
    mode,
    client,
    model,
    safetyIdentifier,
    recallConfig: {
      targetWindowSec: analysisWindowSeconds,
      maxWindowSec: Math.max(
        analysisWindowSeconds + overlapSec,
        analysisWindowSeconds * 1.2,
      ),
      minWindowSec: Math.min(150, analysisWindowSeconds),
      overlapSec,
    },
    onBatchProgress: options.onProgress,
  });

  return {
    candidates: result.candidates,
    selectionSummary: result.selectionSummary,
    windowRuns: result.recallRuns,
    mode,
    coreBinding: core.provenance,
  };
}
