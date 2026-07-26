import assert from "node:assert/strict";
import test from "node:test";
import { deriveKeptRanges } from "../revision-render.js";
import type { CandidatePayload } from "../types.js";

function candidate(): CandidatePayload {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "聊播",
    index: "01",
    title: "测试候选",
    sourceStart: 10,
    sourceEnd: 30,
    originalSafetyStart: 10,
    originalSafetyEnd: 30,
    mediaDurationSeconds: 120,
    durationSeconds: 20,
    score: 80,
    summary: "测试",
    contentType: "商业判断",
    personaModes: ["practical_boss"],
    personaReason: "测试",
    durationMode: "standard",
    durationWindow: "20 秒",
    durationReason: "完整因果",
    selectionReasons: ["证据闭环"],
    scoreBreakdown: [],
    priority: "A",
    factGate: "待人工复核",
    calibrationStatus: "待连续原片视听校准",
    transcript: [
      {
        id: "line-1",
        start: 12,
        end: 15,
        text: "保留",
        speaker: "speaker_0",
        defaultDecision: "keep",
        reason: "主句",
        evidenceLevel: "逐字稿摘录",
      },
      {
        id: "line-2",
        start: 17,
        end: 20,
        text: "删除",
        speaker: "speaker_0",
        defaultDecision: "remove",
        reason: "口头禅",
        evidenceLevel: "逐字稿摘录",
      },
    ],
    previewUrl: null,
    reviewStatus: "proxy_rendered_needs_human_normal_playback",
    renderStatus: "rough_ready",
    previewKind: "rough_cut",
    previewVersion: "rough_test",
    isFinal: false,
    sourceMedia: {
      originalFileName: "直播原片.mp4",
      durationSeconds: 120,
      width: 1080,
      height: 1920,
      frameRate: {
        numerator: 30000,
        denominator: 1001,
        rational: "30000/1001",
        fps: 30000 / 1001,
        source: "avg_frame_rate",
      },
      audioChannels: 2,
      metadataStatus: "verified_ffprobe",
      missingFields: [],
    },
  };
}

test("revision ranges remove selected transcript lines without deleting context", () => {
  assert.deepEqual(
    deriveKeptRanges(candidate(), {
      sourceStart: 10,
      sourceEnd: 30,
      transcriptDecisions: [{ lineId: "line-2", decision: "remove" }],
    }),
    [
      { start: 10, end: 17 },
      { start: 20, end: 30 },
    ],
  );
});

test("revision ranges fail closed on unknown transcript evidence", () => {
  assert.throws(
    () => deriveKeptRanges(candidate(), {
      sourceStart: 10,
      sourceEnd: 30,
      transcriptDecisions: [{ lineId: "invented", decision: "remove" }],
    }),
    /逐字稿行/,
  );
});

test("revision ranges fail closed outside the original safety window", () => {
  assert.throws(
    () => deriveKeptRanges(candidate(), {
      sourceStart: 9.9,
      sourceEnd: 30,
      transcriptDecisions: [],
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "render_window_outside_candidate",
  );
});

test("revision ranges cap the final rendered duration", () => {
  const longCandidate = {
    ...candidate(),
    sourceStart: 0,
    sourceEnd: 700,
    originalSafetyStart: 0,
    originalSafetyEnd: 700,
    mediaDurationSeconds: 700,
    durationSeconds: 700,
    transcript: [],
  };
  assert.throws(
    () => deriveKeptRanges(longCandidate, {
      sourceStart: 0,
      sourceEnd: 700,
      transcriptDecisions: [],
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "render_duration_exceeds_limit",
  );
});
