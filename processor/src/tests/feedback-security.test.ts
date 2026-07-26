import assert from "node:assert/strict";
import Fastify from "fastify";
import test from "node:test";
import type { ProcessorConfig } from "../config.js";
import { publicError } from "../errors.js";
import type { ProcessorRepository } from "../repository.js";
import { registerRoutes } from "../routes.js";
import type { PrivateObjectStorage } from "../storage.js";
import type { CandidatePayload } from "../types.js";

const candidateId = "11111111-1111-4111-8111-111111111111";

function candidate(): CandidatePayload {
  return {
    id: candidateId,
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
    transcript: [{
      id: "line-1",
      start: 12,
      end: 15,
      text: "保留",
      speaker: "speaker_0",
      defaultDecision: "keep",
      reason: "主句",
      evidenceLevel: "逐字稿摘录",
    }],
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

async function feedbackApp() {
  let capturedInput: Record<string, unknown> | null = null;
  const payload = candidate();
  const repository = {
    async getCandidate() {
      return {
        payload,
        projectId: "22222222-2222-4222-8222-222222222222",
        uploadId: "33333333-3333-4333-8333-333333333333",
        previewObjectKey: null,
      };
    },
    async withIdempotency(
      _scope: string,
      _key: string,
      _hash: string,
      operation: () => Promise<{ statusCode: number; payload: unknown }>,
    ) {
      return { ...(await operation()), replayed: false };
    },
    async createFeedback(input: Record<string, unknown>) {
      capturedInput = input;
      return {
        id: "44444444-4444-4444-8444-444444444444",
        createdAt: new Date(0).toISOString(),
        reviewStatus: payload.reviewStatus,
        renderStatus: payload.renderStatus,
      };
    },
  } as unknown as ProcessorRepository;
  const app = Fastify({ logger: false });
  app.setErrorHandler(async (error, _request, reply) => {
    const response = publicError(error);
    return reply.code(response.statusCode).send(response.body);
  });
  app.addHook("preHandler", async (request) => {
    request.internalKeyId = "sites-proxy";
    request.internalActor = "tianzong";
  });
  await registerRoutes(app, {
    config: {} as ProcessorConfig,
    repository,
    storage: {} as PrivateObjectStorage,
  });
  return {
    app,
    capturedInput: () => capturedInput,
  };
}

test("feedback records the authenticated Sites username, not the proxy key", async () => {
  const { app, capturedInput } = await feedbackApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/candidates/${candidateId}/feedback`,
      headers: { "idempotency-key": "feedback-real-actor-1" },
      payload: { decision: "note", notes: "人工回标" },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(capturedInput()?.submittedBy, "tianzong");
    assert.notEqual(capturedInput()?.submittedBy, "sites-proxy");
  } finally {
    await app.close();
  }
});

test("feedback trim outside the immutable candidate safety window is rejected", async () => {
  const { app, capturedInput } = await feedbackApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/candidates/${candidateId}/feedback`,
      headers: { "idempotency-key": "feedback-outside-window-1" },
      payload: {
        decision: "adjust",
        trim: { sourceStart: 8, sourceEnd: 30 },
      },
    });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error.code, "render_window_outside_candidate");
    assert.equal(capturedInput(), null);
  } finally {
    await app.close();
  }
});
