import { readFile } from "node:fs/promises";
import { invariant } from "./errors.mjs";
import { assertPeriodicFrameCoverage } from "./frames.mjs";

export const VISUAL_EVENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          startSec: { type: "number" },
          endSec: { type: "number" },
          eventType: {
            type: "string",
            enum: [
              "speaker_expression",
              "gesture",
              "product_display",
              "interaction",
              "movement",
              "scene_change",
              "onscreen_text",
              "other",
            ],
          },
          description: { type: "string" },
          people: { type: "array", items: { type: "string" } },
          actions: { type: "array", items: { type: "string" } },
          expressions: { type: "array", items: { type: "string" } },
          products: { type: "array", items: { type: "string" } },
          onscreenText: { type: "array", items: { type: "string" } },
          clipSignals: { type: "array", items: { type: "string" } },
          evidenceFrameIds: { type: "array", minItems: 1, items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          uncertainties: { type: "array", items: { type: "string" } },
        },
        required: [
          "id",
          "startSec",
          "endSec",
          "eventType",
          "description",
          "people",
          "actions",
          "expressions",
          "products",
          "onscreenText",
          "clipSignals",
          "evidenceFrameIds",
          "confidence",
          "uncertainties",
        ],
      },
    },
    batchSummary: {
      type: "object",
      additionalProperties: false,
      properties: {
        dominantScene: { type: "string" },
        visibleSpeakerCount: { type: "integer", minimum: 0 },
        notes: { type: "array", items: { type: "string" } },
      },
      required: ["dominantScene", "visibleSpeakerCount", "notes"],
    },
  },
  required: ["events", "batchSummary"],
};

export function buildVisualBatches(frameManifest, {
  framesPerBatch = 10,
} = {}) {
  invariant(frameManifest && Array.isArray(frameManifest.frames) && frameManifest.frames.length > 0, "Frame manifest is required", {
    code: "FRAME_MANIFEST_REQUIRED",
    stage: "visual_map",
  });
  invariant(Number.isInteger(framesPerBatch) && framesPerBatch > 0, "framesPerBatch must be a positive integer", {
    code: "INVALID_VISUAL_BATCH_SIZE",
    stage: "visual_map",
  });

  const frames = [...frameManifest.frames].sort((left, right) => left.timestampSec - right.timestampSec);
  const batches = [];
  for (let offset = 0; offset < frames.length; offset += framesPerBatch) {
    const batchFrames = frames.slice(offset, offset + framesPerBatch);
    const previousFrame = frames[offset - 1];
    const nextFrame = frames[offset + batchFrames.length];
    const firstFrame = batchFrames[0];
    const lastFrame = batchFrames.at(-1);
    batches.push({
      id: `visual_batch_${String(batches.length + 1).padStart(4, "0")}`,
      index: batches.length,
      windowStartSec: previousFrame
        ? (previousFrame.timestampSec + firstFrame.timestampSec) / 2
        : 0,
      windowEndSec: nextFrame
        ? (lastFrame.timestampSec + nextFrame.timestampSec) / 2
        : frameManifest.durationSec,
      frames: batchFrames,
    });
  }
  return batches;
}

async function frameToDataUrl(frame) {
  const bytes = await readFile(frame.path);
  invariant(bytes.length > 0, "Visual-analysis frame is empty", {
    code: "FRAME_ARTIFACT_EMPTY",
    stage: "visual_map",
    details: { frameId: frame.id, path: frame.path },
  });
  return `data:${frame.mimeType ?? "image/jpeg"};base64,${bytes.toString("base64")}`;
}

async function buildVisualInput(batch) {
  const content = [{
    type: "input_text",
    text: [
      `Analyze visual batch ${batch.id}.`,
      `Its screening window is ${batch.windowStartSec.toFixed(3)}s to ${batch.windowEndSec.toFixed(3)}s.`,
      "Frames are sparse evidence, not continuous video. Only report what the supplied frames support.",
      "Use evidenceFrameIds exactly as labelled. Keep event times inside the screening window.",
      "Mark uncertainty whenever motion, speaker identity, causality, or duration cannot be proven from still frames.",
    ].join("\n"),
  }];

  for (const frame of batch.frames) {
    content.push({
      type: "input_text",
      text: `FRAME ${frame.id} @ ${frame.timestampSec.toFixed(3)}s; extraction reasons: ${frame.reasons.join(", ")}`,
    });
    content.push({
      type: "input_image",
      image_url: await frameToDataUrl(frame),
      detail: "high",
    });
  }
  return [{ role: "user", content }];
}

export function validateVisualBatchResult(result, batch) {
  invariant(result && Array.isArray(result.events) && result.batchSummary, "Visual batch result is malformed", {
    code: "INVALID_VISUAL_BATCH_RESULT",
    stage: "visual_map",
    details: { batchId: batch.id },
  });
  const allowedFrameIds = new Set(batch.frames.map((frame) => frame.id));
  const seenEventIds = new Set();
  for (const event of result.events) {
    invariant(typeof event.id === "string" && event.id.length > 0 && !seenEventIds.has(event.id), "Visual event id is missing or duplicated", {
      code: "INVALID_VISUAL_EVENT_ID",
      stage: "visual_map",
      details: { batchId: batch.id, eventId: event.id },
    });
    seenEventIds.add(event.id);
    invariant(
      Number.isFinite(event.startSec)
      && Number.isFinite(event.endSec)
      && event.startSec <= event.endSec
      && event.startSec >= batch.windowStartSec - 0.05
      && event.endSec <= batch.windowEndSec + 0.05,
      "Visual event timestamps fall outside the supplied screening window",
      {
        code: "VISUAL_EVENT_OUTSIDE_BATCH",
        stage: "visual_map",
        details: {
          batchId: batch.id,
          eventId: event.id,
          startSec: event.startSec,
          endSec: event.endSec,
        },
      },
    );
    invariant(
      Array.isArray(event.evidenceFrameIds)
      && event.evidenceFrameIds.length > 0
      && event.evidenceFrameIds.every((frameId) => allowedFrameIds.has(frameId)),
      "Visual event cites an unknown frame",
      {
        code: "VISUAL_EVENT_EVIDENCE_INVALID",
        stage: "visual_map",
        details: { batchId: batch.id, eventId: event.id, evidenceFrameIds: event.evidenceFrameIds },
      },
    );
  }
  return true;
}

export async function analyzeVisualTimeline({
  frameManifest,
  client,
  model = "gpt-5.6-sol",
  framesPerBatch = 10,
  signal = undefined,
  safetyIdentifier = undefined,
  onProgress = undefined,
} = {}) {
  invariant(client && typeof client.createStructuredResponse === "function", "An OpenAI client is required", {
    code: "OPENAI_CLIENT_REQUIRED",
    stage: "visual_map",
  });
  invariant(frameManifest?.coverage?.fullTimelineScreeningExtracted === true, "Full-timeline frame extraction has not been proven", {
    code: "FRAME_SCREENING_INCOMPLETE",
    stage: "visual_map",
  });

  const periodicTimestamps = frameManifest.frames
    .filter((frame) => frame.reasons.includes("periodic"))
    .map((frame) => frame.timestampSec)
    .sort((left, right) => left - right);
  assertPeriodicFrameCoverage(periodicTimestamps, {
    durationSec: frameManifest.durationSec,
    intervalSec: frameManifest.periodicIntervalSec,
  });

  const batches = buildVisualBatches(frameManifest, { framesPerBatch });
  const events = [];
  const batchSummaries = [];
  const modelResponses = [];
  const seenEventIds = new Set();

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const response = await client.createStructuredResponse({
      model,
      reasoningEffort: "medium",
      instructions: [
        "You create an evidence-bound visual event map for a livestream clipping pipeline.",
        "Do not infer unseen motion or dialogue from a still image.",
        "Do not call any candidate publish-ready or audio-video verified.",
        "Describe expressions, gestures, products, interactions, visual punchlines, interruptions, exits, entrances, and on-screen text only when visible.",
        "The resulting map is a sparse full-timeline screening layer. Continuous candidate review happens later.",
      ].join("\n"),
      input: await buildVisualInput(batch),
      schema: VISUAL_EVENT_SCHEMA,
      schemaName: "tianzong_visual_event_batch",
      safetyIdentifier,
      signal,
    });
    validateVisualBatchResult(response.parsed, batch);

    for (const [eventIndex, event] of response.parsed.events.entries()) {
      // Model-generated ids are only trustworthy inside the batch contract.
      // Providers commonly restart at event_1 for every request, so bind each
      // event to its immutable batch before it enters the global evidence map.
      const eventId =
        `${batch.id}_event_${String(eventIndex + 1).padStart(4, "0")}`;
      invariant(!seenEventIds.has(eventId), "Visual event ids must be unique across batches", {
        code: "DUPLICATE_VISUAL_EVENT_ID",
        stage: "visual_map",
        details: { eventId },
      });
      seenEventIds.add(eventId);
      events.push({ ...event, id: eventId, batchId: batch.id });
    }
    batchSummaries.push({
      batchId: batch.id,
      windowStartSec: batch.windowStartSec,
      windowEndSec: batch.windowEndSec,
      ...response.parsed.batchSummary,
    });
    modelResponses.push({
      batchId: batch.id,
      responseId: response.responseId,
      model: response.model,
      usage: response.usage,
    });
    await onProgress?.({
      stage: "visual_map",
      completed: index + 1,
      total: batches.length,
      batchId: batch.id,
    });
  }

  events.sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec);
  return {
    model,
    method: "periodic_and_scene_change_still_screening",
    durationSec: frameManifest.durationSec,
    events,
    batchSummaries,
    frameIds: frameManifest.frames.map((frame) => frame.id),
    modelResponses,
    coverage: {
      fullTimelineScreeningComplete: true,
      periodicIntervalSec: frameManifest.periodicIntervalSec,
      frameCount: frameManifest.frames.length,
      batchCount: batches.length,
      continuousAudioVideoReviewed: false,
      limitation: "Sparse still frames screen the whole timeline but cannot prove continuous motion, audio-video sync, or exact edit boundaries.",
    },
    validationStatus: "visual_screening_complete_needs_candidate_av_review",
    generatedAt: new Date().toISOString(),
  };
}
