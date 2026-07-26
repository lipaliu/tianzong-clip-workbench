import { readFile } from "node:fs/promises";
import { invariant } from "./errors.mjs";
import { assertPeriodicFrameCoverage } from "./frames.mjs";
import { validateCandidateResult } from "./candidates.mjs";

export const DENSE_VISUAL_RECALL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          proposalId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          eventType: {
            type: "string",
            enum: [
              "expression_reaction",
              "gesture_or_movement",
              "dance_or_music",
              "product_demonstration",
              "interaction_or_interruption",
              "cooking",
              "pet",
              "failure_or_comedy",
              "outfit_or_beauty",
              "onscreen_text",
              "scene_change",
              "other",
            ],
          },
          startSec: { type: "number" },
          endSec: { type: "number" },
          evidenceFrameIds: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
          },
          visualSignals: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
          },
          riskNotes: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: [
          "proposalId",
          "title",
          "description",
          "eventType",
          "startSec",
          "endSec",
          "evidenceFrameIds",
          "visualSignals",
          "riskNotes",
          "confidence",
        ],
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["proposals", "notes"],
};

function roundMillis(value) {
  return Math.round(value * 1_000) / 1_000;
}

function getModeRules(coreBundle, mode) {
  if (typeof coreBundle.modeRules === "string") return coreBundle.modeRules;
  return coreBundle.modeRules?.[mode] ?? coreBundle.modeRules?.default;
}

function arrayUnion(...values) {
  return [...new Set(values.flat().filter((value) => value !== undefined && value !== null))];
}

function overlaps(left, right) {
  return left.endSec >= right.startSec && left.startSec <= right.endSec;
}

function rangeOverlapRatio(left, right) {
  const intersection = Math.max(
    0,
    Math.min(left.endSec, right.endSec) - Math.max(left.startSec, right.startSec),
  );
  const shorter = Math.min(left.endSec - left.startSec, right.endSec - right.startSec);
  return shorter > 0 ? intersection / shorter : 0;
}

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function assertDenseManifest(frameManifest, expectedPeriodicIntervalSec) {
  invariant(
    frameManifest?.coverage?.fullTimelineScreeningExtracted === true
    && Array.isArray(frameManifest.frames)
    && frameManifest.frames.length > 0,
    "Dense full-timeline frame extraction has not been proven",
    {
      code: "DENSE_FRAME_SCREENING_INCOMPLETE",
      stage: "dense_visual_recall",
    },
  );
  invariant(
    Number.isFinite(frameManifest.periodicIntervalSec)
    && frameManifest.periodicIntervalSec <= expectedPeriodicIntervalSec + 0.001,
    "Dense frame interval is wider than the configured candidate-frame interval",
    {
      code: "DENSE_FRAME_INTERVAL_TOO_WIDE",
      stage: "dense_visual_recall",
      details: {
        actual: frameManifest.periodicIntervalSec,
        expectedMaximum: expectedPeriodicIntervalSec,
      },
    },
  );
  const periodicTimestamps = frameManifest.frames
    .filter((frame) => frame.reasons.includes("periodic"))
    .map((frame) => frame.timestampSec)
    .sort((left, right) => left - right);
  assertPeriodicFrameCoverage(periodicTimestamps, {
    durationSec: frameManifest.durationSec,
    intervalSec: frameManifest.periodicIntervalSec,
  });
}

export function buildDenseVisualRecallBatches(frameManifest, {
  framesPerBatch = 18,
  overlapFrames = 2,
} = {}) {
  invariant(Number.isInteger(framesPerBatch) && framesPerBatch >= 4, "Dense visual batch size is invalid", {
    code: "INVALID_DENSE_VISUAL_BATCH_SIZE",
    stage: "dense_visual_recall",
  });
  invariant(
    Number.isInteger(overlapFrames)
    && overlapFrames >= 0
    && overlapFrames < framesPerBatch,
    "Dense visual batch overlap is invalid",
    {
      code: "INVALID_DENSE_VISUAL_BATCH_OVERLAP",
      stage: "dense_visual_recall",
    },
  );
  const frames = [...frameManifest.frames].sort(
    (left, right) => left.timestampSec - right.timestampSec,
  );
  invariant(frames.length > 0, "Dense visual frame manifest is empty", {
    code: "DENSE_FRAME_MANIFEST_EMPTY",
    stage: "dense_visual_recall",
  });
  const stride = framesPerBatch - overlapFrames;
  const batches = [];
  for (let offset = 0; offset < frames.length; offset += stride) {
    const batchFrames = frames.slice(offset, offset + framesPerBatch);
    if (!batchFrames.length) break;
    const previous = frames[offset - 1];
    const next = frames[offset + batchFrames.length];
    batches.push({
      batchId: `dense_visual_${String(batches.length + 1).padStart(5, "0")}`,
      index: batches.length,
      windowStartSec: previous
        ? roundMillis((previous.timestampSec + batchFrames[0].timestampSec) / 2)
        : 0,
      windowEndSec: next
        ? roundMillis((batchFrames.at(-1).timestampSec + next.timestampSec) / 2)
        : frameManifest.durationSec,
      frames: batchFrames,
    });
    if (offset + batchFrames.length >= frames.length) break;
  }
  return batches;
}

async function frameToDataUrl(frame) {
  const bytes = await readFile(frame.path);
  invariant(bytes.length > 0, "Dense visual frame is empty", {
    code: "DENSE_FRAME_EMPTY",
    stage: "dense_visual_recall",
    details: { frameId: frame.id, path: frame.path },
  });
  return `data:${frame.mimeType ?? "image/jpeg"};base64,${bytes.toString("base64")}`;
}

async function buildVisualOnlyInput(batch) {
  const content = [{
    type: "input_text",
    text: [
      `VISUAL-ONLY reverse-recall batch ${batch.batchId}.`,
      `Evidence window: ${batch.windowStartSec.toFixed(3)}s–${batch.windowEndSec.toFixed(3)}s.`,
      "No transcript or audio evidence is supplied in this stage.",
      "Find visually self-evident moments that a transcript-first pass could miss.",
      "Still frames do not prove continuous motion, audio, causality, exact action boundaries, or completion.",
      "Use only the exact labelled frame ids. Keep every proposed range inside this evidence window.",
      "Return zero proposals when the frames do not justify a distinct visual clipping angle.",
    ].join("\n"),
  }];
  for (const frame of batch.frames) {
    content.push({
      type: "input_text",
      text:
        `FRAME ${frame.id} @ ${frame.timestampSec.toFixed(3)}s; `
        + `reasons=${frame.reasons.join(",")}`,
    });
    content.push({
      type: "input_image",
      image_url: await frameToDataUrl(frame),
      detail: "high",
    });
  }
  return [{ role: "user", content }];
}

export function validateDenseVisualRecallBatch(result, batch) {
  invariant(result && Array.isArray(result.proposals) && Array.isArray(result.notes), "Dense visual recall result is malformed", {
    code: "DENSE_VISUAL_RESULT_INVALID",
    stage: "dense_visual_recall",
    details: { batchId: batch.batchId },
  });
  const frameById = new Map(batch.frames.map((frame) => [frame.id, frame]));
  const ids = new Set();
  for (const proposal of result.proposals) {
    invariant(
      typeof proposal.proposalId === "string"
      && proposal.proposalId.length > 0
      && !ids.has(proposal.proposalId),
      "Dense visual proposal id is missing or duplicated inside a batch",
      {
        code: "DENSE_VISUAL_PROPOSAL_ID_INVALID",
        stage: "dense_visual_recall",
        details: { batchId: batch.batchId, proposalId: proposal.proposalId },
      },
    );
    ids.add(proposal.proposalId);
    invariant(
      Number.isFinite(proposal.startSec)
      && Number.isFinite(proposal.endSec)
      && proposal.endSec > proposal.startSec
      && proposal.startSec >= batch.windowStartSec - 0.05
      && proposal.endSec <= batch.windowEndSec + 0.05,
      "Dense visual proposal range falls outside its supplied evidence batch",
      {
        code: "DENSE_VISUAL_PROPOSAL_OUTSIDE_BATCH",
        stage: "dense_visual_recall",
        details: { batchId: batch.batchId, proposal },
      },
    );
    invariant(
      Array.isArray(proposal.evidenceFrameIds)
      && proposal.evidenceFrameIds.length > 0
      && proposal.evidenceFrameIds.every((frameId) => frameById.has(frameId)),
      "Dense visual proposal cites an unavailable frame",
      {
        code: "DENSE_VISUAL_EVIDENCE_INVALID",
        stage: "dense_visual_recall",
        details: {
          batchId: batch.batchId,
          proposalId: proposal.proposalId,
          evidenceFrameIds: proposal.evidenceFrameIds,
        },
      },
    );
    invariant(
      proposal.evidenceFrameIds.some((frameId) => {
        const frame = frameById.get(frameId);
        return frame.timestampSec >= proposal.startSec - 0.1
          && frame.timestampSec <= proposal.endSec + 0.1;
      }),
      "Dense visual proposal has no cited frame inside its proposed range",
      {
        code: "DENSE_VISUAL_EVIDENCE_OUTSIDE_PROPOSAL",
        stage: "dense_visual_recall",
        details: { batchId: batch.batchId, proposalId: proposal.proposalId },
      },
    );
  }
  return true;
}

function sameBoundaryDuplicate(left, right) {
  const evidenceIntersection = left.evidenceFrameIds.some(
    (frameId) => right.evidenceFrameIds.includes(frameId),
  );
  return evidenceIntersection
    && rangeOverlapRatio(left, right) >= 0.82
    && normalizedText(left.description) === normalizedText(right.description);
}

function dedupeBoundaryProposals(proposals) {
  const kept = [];
  for (const proposal of [...proposals].sort(
    (left, right) => left.startSec - right.startSec || left.endSec - right.endSec,
  )) {
    const duplicateIndex = kept.findIndex((existing) =>
      sameBoundaryDuplicate(existing, proposal));
    if (duplicateIndex === -1) {
      kept.push(proposal);
      continue;
    }
    const existing = kept[duplicateIndex];
    kept[duplicateIndex] = {
      ...(proposal.confidence > existing.confidence ? proposal : existing),
      startSec: Math.min(existing.startSec, proposal.startSec),
      endSec: Math.max(existing.endSec, proposal.endSec),
      evidenceFrameIds: arrayUnion(
        existing.evidenceFrameIds,
        proposal.evidenceFrameIds,
      ),
      visualSignals: arrayUnion(existing.visualSignals, proposal.visualSignals),
      riskNotes: arrayUnion(existing.riskNotes, proposal.riskNotes),
      sourceBatches: arrayUnion(existing.sourceBatches, proposal.sourceBatches),
    };
  }
  return kept;
}

function distanceToRange(segment, range) {
  if (overlaps(segment, range)) return 0;
  if (segment.endSec < range.startSec) return range.startSec - segment.endSec;
  return segment.startSec - range.endSec;
}

function bindProposalToTranscript(proposal, transcript, durationSec, {
  adjacentPaddingSec = 8,
  nearestTranscriptMaxDistanceSec = 20,
  safetyPaddingSec = 4,
} = {}) {
  const adjacentWindow = {
    startSec: Math.max(0, proposal.startSec - adjacentPaddingSec),
    endSec: Math.min(durationSec, proposal.endSec + adjacentPaddingSec),
  };
  let segments = transcript.segments.filter((segment) =>
    overlaps(segment, adjacentWindow));
  if (!segments.length) {
    const nearest = [...transcript.segments]
      .map((segment) => ({
        segment,
        distance: distanceToRange(segment, proposal),
      }))
      .sort((left, right) => left.distance - right.distance)[0];
    if (nearest && nearest.distance <= nearestTranscriptMaxDistanceSec) {
      segments = [nearest.segment];
    }
  }
  if (!segments.length) return null;

  segments.sort((left, right) => left.startSec - right.startSec);
  const recallWindow = {
    startSec: roundMillis(Math.max(
      0,
      Math.min(proposal.startSec, segments[0].startSec),
    )),
    endSec: roundMillis(Math.min(
      durationSec,
      Math.max(proposal.endSec, segments.at(-1).endSec),
    )),
  };
  const safetyWindow = {
    startSec: roundMillis(Math.max(0, recallWindow.startSec - safetyPaddingSec)),
    endSec: roundMillis(Math.min(durationSec, recallWindow.endSec + safetyPaddingSec)),
  };
  return { segments, recallWindow, safetyWindow };
}

function scoreVisualCandidate(confidence) {
  const hook = Math.min(20, Math.round(8 + confidence * 8));
  const emotion = Math.min(15, Math.round(5 + confidence * 8));
  const insight = 6;
  const controversy = 4;
  const completeness = 8;
  const titlePotential = Math.min(15, Math.round(7 + confidence * 6));
  return {
    hook,
    emotion,
    insight,
    controversy,
    completeness,
    titlePotential,
    total: hook + emotion + insight + controversy + completeness + titlePotential,
  };
}

function visualEventType(proposal) {
  const map = {
    expression_reaction: "speaker_expression",
    gesture_or_movement: "movement",
    dance_or_music: "movement",
    product_demonstration: "product_display",
    interaction_or_interruption: "interaction",
    cooking: "other",
    pet: "other",
    failure_or_comedy: "other",
    outfit_or_beauty: "other",
    onscreen_text: "onscreen_text",
    scene_change: "scene_change",
    other: "other",
  };
  return map[proposal.eventType] ?? "other";
}

function createBoundVisualCandidate(
  proposal,
  event,
  binding,
  coreBundle,
  periodicIntervalSec,
) {
  const openingSegment = binding.segments[0];
  return {
    candidateId: `visual_source_${event.id}`,
    title: proposal.title,
    hook: proposal.description,
    openingLine: openingSegment.text,
    topic: proposal.title,
    contentPillar: proposal.eventType === "product_demonstration"
      ? "产品视觉证据"
      : "视觉事件与人物反差",
    rationale:
      `视觉反向召回：${proposal.description}。该候选先由密集画面发现，`
      + "再绑定相邻逐字稿；不能仅凭静帧确认动作完整性。",
    recallWindow: binding.recallWindow,
    safetyWindow: binding.safetyWindow,
    transcriptSegmentIds: binding.segments.map((segment) => segment.id),
    visualEventIds: [event.id],
    requiredVisualProof: [
      "以正常倍速完整播放安全窗，确认动作从起点到落点没有被截断。",
      "确认画面反应、原声语义和说话人属于同一时刻且没有错位。",
      ...proposal.riskNotes,
    ],
    deleteSuggestions: [],
    score: scoreVisualCandidate(proposal.confidence),
    risks: arrayUnion(
      `视觉反向召回来自每 ${periodicIntervalSec} 秒及镜头变化静帧，仍不能证明连续动作和音画同步。`,
      proposal.riskNotes,
    ),
    validationStatus: "editorial_candidate_needs_av_review",
    coreBinding: {
      coreId: coreBundle.coreId,
      coreVersion: coreBundle.coreVersion,
      coreSha256: coreBundle.coreSha256,
      promptVersion: coreBundle.promptVersion,
    },
    evidenceBinding: {
      transcriptSegmentIds: binding.segments.map((segment) => segment.id),
      visualEventIds: [event.id],
      visualEvidenceStatus:
        "dense_still_visual_reverse_recall_needs_candidate_refinement_and_human_normal_playback",
      continuousAudioVideoReviewed: false,
      audioVideoVerified: false,
    },
    recallProvenance: {
      sources: proposal.sourceBatches.map((batchId) => ({
        batchId,
        sourceCandidateId: proposal.proposalId,
        discoveryMethod: "visual_only_dense_reverse_recall",
      })),
    },
  };
}

export async function analyzeDenseVisualRecall({
  frameManifest,
  transcript,
  coreBundle,
  mode,
  client,
  model = "gpt-5.6-sol",
  expectedPeriodicIntervalSec = 2,
  framesPerBatch = 18,
  overlapFrames = 2,
  signal = undefined,
  safetyIdentifier = undefined,
  onProgress = undefined,
} = {}) {
  invariant(mode === "chat" || mode === "sales", "Dense visual recall mode is invalid", {
    code: "INVALID_CLIPPING_MODE",
    stage: "dense_visual_recall",
  });
  invariant(
    client && typeof client.createStructuredResponse === "function",
    "An OpenAI client is required for dense visual recall",
    {
      code: "OPENAI_CLIENT_REQUIRED",
      stage: "dense_visual_recall",
    },
  );
  invariant(
    transcript
    && Array.isArray(transcript.segments)
    && transcript.segments.length > 0,
    "A transcript is required to bind dense visual recall",
    {
      code: "TRANSCRIPT_REQUIRED",
      stage: "dense_visual_recall",
    },
  );
  const privateKnowledge = coreBundle?.privateKnowledge ?? coreBundle?.instructions;
  const modeRules = getModeRules(coreBundle, mode);
  invariant(
    typeof privateKnowledge === "string"
    && privateKnowledge.trim().length > 0
    && typeof modeRules === "string"
    && modeRules.trim().length > 0,
    "Dense visual recall is not bound to the private Tianzong core",
    {
      code: "TIANZONG_CORE_REQUIRED",
      stage: "dense_visual_recall",
    },
  );
  assertDenseManifest(frameManifest, expectedPeriodicIntervalSec);
  const batches = buildDenseVisualRecallBatches(frameManifest, {
    framesPerBatch,
    overlapFrames,
  });
  const rawProposals = [];
  const runs = [];
  const notes = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const response = await client.createStructuredResponse({
      model,
      reasoningEffort: "high",
      maxOutputTokens: 12_000,
      instructions: [
        `Execute private Tianzong clipping core ${coreBundle.coreVersion} (${coreBundle.coreSha256}).`,
        "This is a VISUAL-ONLY reverse-recall pass. Do not use or invent dialogue.",
        "Look specifically for moments a transcript pass misses: expression changes, gestures, dancing, product handling, entrances/exits, interruptions, cooking/pet beats, failure/comedy, and visual reversals.",
        "Do not propose ordinary static talking-head frames unless a visible change itself has an independent clipping reason.",
        "Different visual cuts from the same theme remain separate when their action boundaries or evidence frames differ.",
        "Still images are sampled evidence, not continuous playback. Explicitly state uncertainty about motion boundaries and completion.",
        "<private_tianzong_knowledge>",
        privateKnowledge,
        "</private_tianzong_knowledge>",
        `<${mode}_rules>`,
        modeRules,
        `</${mode}_rules>`,
      ].join("\n"),
      input: await buildVisualOnlyInput(batch),
      schema: DENSE_VISUAL_RECALL_SCHEMA,
      schemaName: "tianzong_dense_visual_reverse_recall",
      safetyIdentifier,
      signal,
    });
    validateDenseVisualRecallBatch(response.parsed, batch);
    response.parsed.proposals.forEach((proposal, proposalIndex) => {
      rawProposals.push({
        ...proposal,
        proposalId:
          `${batch.batchId}_${String(proposalIndex + 1).padStart(3, "0")}`,
        sourceBatches: [batch.batchId],
      });
    });
    notes.push(...response.parsed.notes);
    runs.push({
      batchId: batch.batchId,
      windowStartSec: batch.windowStartSec,
      windowEndSec: batch.windowEndSec,
      frameCount: batch.frames.length,
      proposalCount: response.parsed.proposals.length,
      responseId: response.responseId ?? null,
      model: response.model ?? model,
      usage: response.usage ?? null,
    });
    await onProgress?.({
      stage: "dense_visual_recall",
      completed: index + 1,
      total: batches.length,
      batchId: batch.batchId,
    });
  }

  const proposals = dedupeBoundaryProposals(rawProposals);
  const events = [];
  const candidates = [];
  const unboundProposals = [];
  for (let index = 0; index < proposals.length; index += 1) {
    const proposal = proposals[index];
    const binding = bindProposalToTranscript(
      proposal,
      transcript,
      frameManifest.durationSec,
    );
    if (!binding) {
      unboundProposals.push({
        proposalId: proposal.proposalId,
        reason: "没有可证据绑定的相邻逐字稿，按 fail-closed 不进入候选。",
      });
      continue;
    }
    const event = {
      id: `dense_visual_event_${String(events.length + 1).padStart(5, "0")}`,
      startSec: roundMillis(proposal.startSec),
      endSec: roundMillis(proposal.endSec),
      eventType: visualEventType(proposal),
      description: proposal.description,
      people: ["天总"],
      actions: proposal.visualSignals,
      expressions: proposal.eventType === "expression_reaction"
        ? proposal.visualSignals
        : [],
      products: proposal.eventType === "product_demonstration"
        ? proposal.visualSignals
        : [],
      onscreenText: proposal.eventType === "onscreen_text"
        ? proposal.visualSignals
        : [],
      clipSignals: [
        `visual_only_reverse_recall:${proposal.eventType}`,
        ...proposal.visualSignals,
      ],
      evidenceFrameIds: proposal.evidenceFrameIds,
      confidence: proposal.confidence,
      uncertainties: arrayUnion(
        proposal.riskNotes,
        "密集静帧不等于连续逐帧观看，动作起止与音画同步仍需人工正常倍速确认。",
      ),
      observationMethod: "dense_still_visual_reverse_recall",
      continuousRangeReviewed: false,
      sourceBatches: proposal.sourceBatches,
    };
    events.push(event);
    candidates.push(
      createBoundVisualCandidate(
        proposal,
        event,
        binding,
        coreBundle,
        frameManifest.periodicIntervalSec,
      ),
    );
  }

  const visualMapAugmentation = {
    method:
      `dense_${frameManifest.periodicIntervalSec}s_periodic_plus_scene_change_visual_only_reverse_recall`,
    durationSec: frameManifest.durationSec,
    events,
    frameIds: frameManifest.frames.map((frame) => frame.id),
    coverage: {
      fullTimelineScreeningComplete: true,
      periodicIntervalSec: frameManifest.periodicIntervalSec,
      frameCount: frameManifest.frames.length,
      batchCount: batches.length,
      continuousAudioVideoReviewed: false,
      limitation:
        "Every configured dense interval plus shot changes was screened as still images for visual-only recall; this is not continuous video playback and cannot prove motion completion or audio-video sync.",
    },
    validationStatus:
      "dense_visual_reverse_recall_complete_needs_candidate_refinement_and_human_normal_playback",
  };
  const candidateResult = {
    candidates,
    selectionSummary: {
      qualifyingCount: candidates.length,
      rejectedThemes: [],
      notes: arrayUnion(
        notes,
        "这是先看密集画面、不读取逐字稿的反向补召回；之后才绑定相邻原声证据。",
        "视觉候选数量按证据自然产生，不设配额。",
        ...unboundProposals.map((item) =>
          `${item.proposalId}: ${item.reason}`),
      ),
    },
  };
  const augmentedVisualMap = {
    ...visualMapAugmentation,
    coverage: {
      ...visualMapAugmentation.coverage,
      unboundProposalCount: unboundProposals.length,
    },
  };
  validateCandidateResult(candidateResult, {
    transcript,
    visualMap: augmentedVisualMap,
    durationSec: transcript.mediaDurationSec,
  });

  return {
    model,
    method: visualMapAugmentation.method,
    frameManifestCoverage: frameManifest.coverage,
    events,
    candidates,
    selectionSummary: candidateResult.selectionSummary,
    runs,
    unboundProposals,
    visualMapAugmentation: augmentedVisualMap,
    coverage: visualMapAugmentation.coverage,
    generatedAt: new Date().toISOString(),
  };
}

function exactSourceDuplicate(left, right) {
  const sameRange =
    Math.abs(left.recallWindow.startSec - right.recallWindow.startSec) <= 0.05
    && Math.abs(left.recallWindow.endSec - right.recallWindow.endSec) <= 0.05
    && Math.abs(left.safetyWindow.startSec - right.safetyWindow.startSec) <= 0.05
    && Math.abs(left.safetyWindow.endSec - right.safetyWindow.endSec) <= 0.05;
  const sameTranscript =
    [...left.transcriptSegmentIds].sort().join("|")
    === [...right.transcriptSegmentIds].sort().join("|");
  const sameVisual =
    [...left.visualEventIds].sort().join("|")
    === [...right.visualEventIds].sort().join("|");
  return sameRange && sameTranscript && sameVisual;
}

export function augmentVisualMapWithDenseRecall(sparseVisualMap, denseRecall) {
  invariant(
    sparseVisualMap?.coverage?.fullTimelineScreeningComplete === true
    && denseRecall?.coverage?.fullTimelineScreeningComplete === true,
    "Both sparse and dense visual coverage must be complete before augmentation",
    {
      code: "VISUAL_COVERAGE_INCOMPLETE",
      stage: "dense_visual_recall",
    },
  );
  const events = [...sparseVisualMap.events, ...denseRecall.events];
  const eventIds = new Set();
  for (const event of events) {
    invariant(!eventIds.has(event.id), "Sparse and dense visual event ids collide", {
      code: "VISUAL_EVENT_ID_COLLISION",
      stage: "dense_visual_recall",
      details: { eventId: event.id },
    });
    eventIds.add(event.id);
  }
  return {
    ...sparseVisualMap,
    method:
      `${sparseVisualMap.method} + ${denseRecall.method}`,
    events,
    denseVisualRecall: {
      eventCount: denseRecall.events.length,
      candidateCount: denseRecall.candidates.length,
      unboundProposalCount: denseRecall.unboundProposals.length,
      frameCount: denseRecall.coverage.frameCount,
      periodicIntervalSec: denseRecall.coverage.periodicIntervalSec,
      batchCount: denseRecall.coverage.batchCount,
    },
    coverage: {
      ...sparseVisualMap.coverage,
      denseVisualReverseRecallComplete: true,
      densePeriodicIntervalSec: denseRecall.coverage.periodicIntervalSec,
      denseFrameCount: denseRecall.coverage.frameCount,
      continuousAudioVideoReviewed: false,
      limitation:
        `${sparseVisualMap.coverage.limitation} `
        + `${denseRecall.coverage.limitation}`,
    },
  };
}

export function mergeTextAndVisualCandidateResults({
  textResult,
  visualResult,
  transcript,
  visualMap,
  coreBundle,
  mode,
  model = "gpt-5.6-sol",
} = {}) {
  invariant(textResult?.selectionSummary && visualResult?.selectionSummary, "Both candidate sources are required", {
    code: "CANDIDATE_SOURCE_MISSING",
    stage: "candidate_source_merge",
  });
  const merged = [];
  let exactDuplicateCount = 0;
  for (const sourceCandidate of [
    ...textResult.candidates.map((candidate) => ({
      ...candidate,
      discoveryMethods: arrayUnion(
        candidate.discoveryMethods,
        "transcript_core_recall",
      ),
    })),
    ...visualResult.candidates.map((candidate) => ({
      ...candidate,
      discoveryMethods: arrayUnion(
        candidate.discoveryMethods,
        "visual_only_dense_reverse_recall",
      ),
    })),
  ]) {
    const exactIndex = merged.findIndex((candidate) =>
      exactSourceDuplicate(candidate, sourceCandidate));
    if (exactIndex === -1) {
      merged.push(sourceCandidate);
      continue;
    }
    exactDuplicateCount += 1;
    const existing = merged[exactIndex];
    merged[exactIndex] = {
      ...(sourceCandidate.score.total > existing.score.total
        ? sourceCandidate
        : existing),
      requiredVisualProof: arrayUnion(
        existing.requiredVisualProof,
        sourceCandidate.requiredVisualProof,
      ),
      risks: arrayUnion(existing.risks, sourceCandidate.risks),
      discoveryMethods: arrayUnion(
        existing.discoveryMethods,
        sourceCandidate.discoveryMethods,
      ),
      recallProvenance: {
        sources: arrayUnion(
          existing.recallProvenance?.sources ?? [],
          sourceCandidate.recallProvenance?.sources ?? [],
        ),
      },
    };
  }

  const candidates = merged
    .sort(
      (left, right) =>
        left.recallWindow.startSec - right.recallWindow.startSec
        || left.recallWindow.endSec - right.recallWindow.endSec
        || right.score.total - left.score.total,
    )
    .map((candidate, index) => ({
      ...candidate,
      candidateId: `candidate_${String(index + 1).padStart(4, "0")}`,
      coreBinding: {
        coreId: coreBundle.coreId,
        coreVersion: coreBundle.coreVersion,
        coreSha256: coreBundle.coreSha256,
        promptVersion: coreBundle.promptVersion,
      },
      evidenceBinding: {
        transcriptSegmentIds: [...candidate.transcriptSegmentIds],
        visualEventIds: [...candidate.visualEventIds],
        visualEvidenceStatus:
          "sparse_semantic_map_plus_dense_visual_reverse_recall_needs_candidate_refinement_and_human_normal_playback",
        continuousAudioVideoReviewed: false,
        audioVideoVerified: false,
      },
    }));
  const result = {
    candidates,
    selectionSummary: {
      qualifyingCount: candidates.length,
      rejectedThemes: arrayUnion(
        textResult.selectionSummary.rejectedThemes,
        visualResult.selectionSummary.rejectedThemes,
      ),
      notes: arrayUnion(
        textResult.selectionSummary.notes,
        visualResult.selectionSummary.notes,
        "文字召回与视觉反向召回已合并；只消除证据、切口和安全窗完全相同的重复项。",
        "同一主题、同一原片段的不同视觉动作边界不会因主题相似而被删除。",
      ),
    },
    sourceFunnel: {
      textCandidateCount: textResult.candidates.length,
      visualCandidateCount: visualResult.candidates.length,
      exactDuplicateCount,
      mergedCandidateCount: candidates.length,
    },
    mode,
    model,
    coreBinding: {
      coreId: coreBundle.coreId,
      coreVersion: coreBundle.coreVersion,
      coreSha256: coreBundle.coreSha256,
      promptVersion: coreBundle.promptVersion,
    },
  };
  validateCandidateResult(result, {
    transcript,
    visualMap,
    durationSec: transcript.mediaDurationSec,
  });
  return result;
}
