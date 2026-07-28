import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDoubaoAvReviewRequest,
  createDoubaoAvReviewProvider,
  normalizeDoubaoAvReview,
} from "../doubao-av-review.mjs";

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function fixtureInput() {
  return {
    candidateId: "cand_001",
    videoUrl:
      "https://example.com/private/cand_001.mp4?X-Signature=redacted-test",
    sourceOffsetSec: 100,
    candidate: {
      candidateId: "cand_001",
      title: "带货是长线的",
      openingLine: "带货是长线的",
      rationale: "保留完整因果，删除场外个人计划。",
      recallWindow: { startSec: 102, endSec: 124 },
      safetyWindow: { startSec: 100, endSec: 130 },
      requiredVisualProof: ["确认场外插话与天总发言边界。"],
      risks: [],
    },
    transcript: {
      segments: [
        {
          id: "seg_1",
          speaker: "天总",
          startSec: 102,
          endSec: 105,
          text: "带货是长线的。",
        },
        {
          id: "seg_2",
          speaker: "场外",
          startSec: 106,
          endSec: 112,
          text: "那我想做的那个电商……",
        },
        {
          id: "seg_3",
          speaker: "天总",
          startSec: 114,
          endSec: 124,
          text: "上来做电商需要学两年。",
        },
      ],
    },
    coreBundle: {
      coreId: "tianzong-core",
      coreVersion: "1.1.0",
      coreSha256: "abc123",
      privateKnowledge:
        "天总是有实战能力、嘴很快、主意很正的女老板。只报告有证据的动作和音画信息。",
      modeRules: {
        chat: "聊播保留完整因果和必要上下文。",
        sales: "带货保留长期价值判断、产品证据和真实使用动作。",
      },
    },
    mode: "sales",
  };
}

function validModelResult() {
  return {
    candidateId: "cand_001",
    mode: "sales",
    reviewDecision: "supported",
    summary: "天总先给出长线判断，场外插话后重新给出两年学习结论。",
    evidence: [
      {
        evidenceId: "ev_1",
        evidenceType: "expression",
        localStartSec: 2,
        localEndSec: 4.5,
        description: "天总面向镜头给出明确结论，表情严肃。",
        actors: ["天总"],
        audibleSpeaker: "天总",
        productNames: [],
        transcriptSegmentIds: ["seg_1"],
        confidence: 0.91,
      },
      {
        evidenceId: "ev_2",
        evidenceType: "offscreen_speech",
        localStartSec: 6,
        localEndSec: 12,
        description: "场外人员持续插话，内容偏离天总的核心判断。",
        actors: [],
        audibleSpeaker: "场外",
        productNames: [],
        transcriptSegmentIds: ["seg_2"],
        confidence: 0.87,
      },
      {
        evidenceId: "ev_3",
        evidenceType: "audio_tone",
        localStartSec: 14,
        localEndSec: 24,
        description: "天总恢复主讲，语气笃定并给出两年学习结论。",
        actors: ["天总"],
        audibleSpeaker: "天总",
        productNames: [],
        transcriptSegmentIds: ["seg_3"],
        confidence: 0.93,
      },
    ],
    boundarySuggestion: {
      extendBeforeSec: 1,
      extendAfterSec: 2,
      openingStatus: "supported",
      closingStatus: "needs_more_context",
      reason: "结尾需要补足一句落点。",
    },
    audioAssessment: {
      availability: "present",
      toneSummary: "天总语气直接，场外插话较弱。",
      backgroundSoundSummary: "轻微直播间环境声。",
      musicPresent: false,
      offscreenSpeechPresent: true,
    },
    transcriptAlignment: {
      status: "aligned",
      notes: ["三段说话人与逐字稿一致。"],
    },
    uncertainties: ["无法仅凭模型确认最终人工剪点。"],
    reviewContract: {
      machineReviewMethod: "doubao_seed_2_lite_native_audio_video",
      nativeAudioVideoInputReviewed: true,
      continuousFrameByFrameReviewed: false,
      humanNormalPlaybackRequired: true,
      validationStatus:
        "candidate_native_av_model_review_needs_human_normal_playback",
    },
  };
}

test("Chat request uses Ark OpenAI-compatible video_url with original audio model", () => {
  const request = buildDoubaoAvReviewRequest({
    apiMode: "chat",
    model: "doubao-seed-2-0-lite-260428",
    videoUrl: "https://example.com/candidate.mp4",
    videoFps: 2,
    instructions: "review evidence",
    evidencePayload: { candidateId: "cand_001" },
    maxOutputTokens: 8_000,
  });
  assert.equal(request.path, "/chat/completions");
  assert.equal(request.body.model, "doubao-seed-2-0-lite-260428");
  assert.equal(request.body.thinking.type, "enabled");
  assert.equal(request.body.response_format.type, "json_object");
  assert.deepEqual(request.body.messages[1].content[1], {
    type: "video_url",
    video_url: {
      url: "https://example.com/candidate.mp4",
      fps: 2,
    },
  });
});

test("Responses request uses input_video and strict JSON schema", () => {
  const request = buildDoubaoAvReviewRequest({
    apiMode: "responses",
    model: "doubao-seed-2-0-lite-260428",
    videoUrl: "https://example.com/candidate.mp4",
    videoFps: 2,
    instructions: "review evidence",
    evidencePayload: { candidateId: "cand_001" },
    maxOutputTokens: 8_000,
  });
  assert.equal(request.path, "/responses");
  assert.deepEqual(request.body.input[0].content[1], {
    type: "input_video",
    video_url: "https://example.com/candidate.mp4",
    fps: 2,
  });
  assert.equal(request.body.text.format.type, "json_schema");
  assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.store, false);
});

test("provider sends private core, local transcript evidence, and returns normalized global evidence", async () => {
  let captured;
  const apiKey = "ark-secret-that-must-not-be-returned";
  const provider = createDoubaoAvReviewProvider({
    apiKey,
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return jsonResponse({
        id: "chatcmpl_1",
        model: "doubao-seed-2-0-lite-260428",
        choices: [{
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify(validModelResult()),
          },
        }],
        usage: { total_tokens: 123 },
      });
    },
  });

  const result = await provider.reviewCandidate(fixtureInput());
  assert.equal(
    captured.url,
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
  );
  assert.equal(captured.init.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(
    captured.body.messages[1].content[1].video_url.url,
    fixtureInput().videoUrl,
  );
  assert.match(
    captured.body.messages[0].content,
    /private_tianzong_knowledge/,
  );
  const evidencePayload = JSON.parse(
    captured.body.messages[1].content[0].text,
  );
  assert.equal(
    evidencePayload.diarizedTranscriptEvidence[0].localStartSec,
    2,
  );
  assert.equal(evidencePayload.localVideoTimebase.sourceOffsetSec, 100);

  assert.equal(
    result.normalized.visualEvidence.expressions[0]
      .globalTimecode.startSec,
    102,
  );
  assert.equal(
    result.normalized.visualEvidence.offscreenSpeech[0]
      .globalTimecode.endSec,
    112,
  );
  assert.equal(result.normalized.visualEvents[1].eventType, "interaction");
  assert.equal(
    result.normalized.visualEvents[1].continuousFrameByFrameReviewed,
    false,
  );
  assert.equal(result.normalized.boundarySuggestion.suggestedSourceWindow.startSec, 99);
  assert.equal(result.normalized.boundarySuggestion.suggestedSourceWindow.endSec, 132);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
  assert.equal(JSON.stringify(result).includes("X-Signature"), false);
});

test("strict schema and semantic validation fail closed", () => {
  const base = validModelResult();
  const context = {
    candidateId: "cand_001",
    mode: "sales",
    sourceOffsetSec: 100,
    durationSec: 30,
    transcriptSegmentIds: ["seg_1", "seg_2", "seg_3"],
  };

  assert.throws(
    () => normalizeDoubaoAvReview({
      ...base,
      extraUntrustedField: true,
    }, context),
    (error) => error.code === "DOUBAO_RESULT_SCHEMA_INVALID",
  );
  assert.throws(
    () => normalizeDoubaoAvReview({
      ...base,
      evidence: [{
        ...base.evidence[0],
        localEndSec: 31,
      }],
    }, context),
    (error) => error.code === "DOUBAO_EVIDENCE_TIMECODE_INVALID",
  );
  assert.throws(
    () => normalizeDoubaoAvReview({
      ...base,
      evidence: [{
        ...base.evidence[0],
        transcriptSegmentIds: ["fabricated"],
      }],
    }, context),
    (error) => error.code === "DOUBAO_TRANSCRIPT_CITATION_INVALID",
  );
});

test("provider rejects non-JSON model output and unsafe video URLs without exposing secrets", async () => {
  const provider = createDoubaoAvReviewProvider({
    apiKey: "top-secret",
    fetchImpl: async () => jsonResponse({
      choices: [{
        finish_reason: "stop",
        message: { content: "```json\n{}\n```" },
      }],
    }),
  });
  await assert.rejects(
    () => provider.reviewCandidate(fixtureInput()),
    (error) =>
      error.code === "DOUBAO_OUTPUT_INVALID_JSON"
      && !JSON.stringify(error).includes("top-secret"),
  );

  await assert.rejects(
    () => provider.reviewCandidate({
      ...fixtureInput(),
      videoUrl: "http://127.0.0.1/private.mp4?secret=yes",
    }),
    (error) =>
      error.code === "DOUBAO_VIDEO_URL_UNSAFE"
      && !JSON.stringify(error).includes("secret=yes"),
  );
  await assert.rejects(
    () => provider.reviewCandidate({
      ...fixtureInput(),
      videoUrl: "https://[::1]/private.mp4",
    }),
    (error) => error.code === "DOUBAO_VIDEO_URL_UNSAFE",
  );
});

test("provider sanitizes HTTP failures and never returns provider body or signed URL", async () => {
  let requestCount = 0;
  const provider = createDoubaoAvReviewProvider({
    apiKey: "top-secret",
    fetchImpl: async () => {
      requestCount += 1;
      return jsonResponse({
        error: {
          code: "InvalidParameter",
          type: "invalid_request_error",
          message:
            "could not fetch https://example.com/video.mp4?X-Signature=private",
        },
      }, 400, { "x-request-id": "request-safe-id" });
    },
  });

  await assert.rejects(
    () => provider.reviewCandidate(fixtureInput()),
    (error) =>
      error.code === "DOUBAO_REQUEST_FAILED"
      && error.details.requestId === "request-safe-id"
      && !JSON.stringify(error).includes("X-Signature")
      && !JSON.stringify(error).includes("top-secret"),
  );
  assert.equal(requestCount, 1);
});

test("provider retries throttling and transient server failures with bounded backoff", async () => {
  let requestCount = 0;
  const delays = [];
  const provider = createDoubaoAvReviewProvider({
    apiKey: "top-secret",
    maxAttempts: 3,
    retryBaseDelayMs: 25,
    sleepImpl: async (delay) => {
      delays.push(delay);
    },
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return jsonResponse({
          error: { code: "RateLimit", type: "throttled" },
        }, 429);
      }
      if (requestCount === 2) {
        return jsonResponse({
          error: { code: "InternalError", type: "server_error" },
        }, 503);
      }
      return jsonResponse({
        id: "chatcmpl_retry_success",
        model: "doubao-seed-2-0-lite-260428",
        choices: [{
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify(validModelResult()),
          },
        }],
      });
    },
  });

  const result = await provider.reviewCandidate(fixtureInput());
  assert.equal(result.responseId, "chatcmpl_retry_success");
  assert.equal(requestCount, 3);
  assert.deepEqual(delays, [25, 50]);
});
