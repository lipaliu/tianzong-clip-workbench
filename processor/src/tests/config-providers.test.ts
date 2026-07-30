import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../config.js";

const baseEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  INTERNAL_API_KEYS: JSON.stringify({ "sites-proxy": "x".repeat(32) }),
  R2_ENDPOINT: "https://example.invalid",
  R2_ACCESS_KEY_ID: "test",
  R2_SECRET_ACCESS_KEY: "test",
  R2_BUCKET: "test",
  OPENAI_API_KEY: "test",
  OPENAI_TRANSCRIPTION_MODEL: "gpt-4o-transcribe-diarize",
  OPENAI_REASONING_MODEL: "gpt-5.6-sol",
  OPENAI_VISION_MODEL: "gpt-5.6-sol",
  TIANCLIP_CORE_S3_KEY: "private/core.skill",
  TIANCLIP_CORE_SHA256: "a".repeat(64),
  TIANCLIP_CORE_VERSION: "1.2.2-private.1",
  TIANCLIP_PROMPT_VERSION: "1.2.2",
  TIANCLIP_SCHEMA_VERSION: "1.1.0",
  TIANCLIP_FACT_SCHEMA_VERSION: "1.0.0",
  TIANCLIP_LEDGER_SCHEMA_VERSION: "1.0.0",
};

test("provider routing defaults preserve the existing OpenAI and sampled-still path", () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.providers.transcription, "openai");
  assert.equal(config.providers.candidateAvReview, "sampled_stills");
  assert.equal(config.providers.transcriptionFallbackToOpenai, true);
  assert.equal(config.providers.avReviewFallbackToSampledStills, true);
  assert.equal(config.doubao.asr.resourceId, "volc.bigasr.auc");
  assert.equal(config.doubao.ark.avModel, "doubao-seed-2-0-lite-260428");
});

test("Doubao routes fail closed when their server-side credentials are absent", () => {
  assert.throws(
    () => loadConfig({
      ...baseEnv,
      TRANSCRIPTION_PROVIDER: "doubao",
    }),
    /DOUBAO_ASR_APP_KEY and DOUBAO_ASR_ACCESS_KEY/,
  );
  assert.throws(
    () => loadConfig({
      ...baseEnv,
      CANDIDATE_AV_REVIEW_PROVIDER: "doubao",
    }),
    /DOUBAO_ARK_API_KEY/,
  );
});

test("Doubao routes pin the intended services and parse explicit false fallbacks", () => {
  const config = loadConfig({
    ...baseEnv,
    TRANSCRIPTION_PROVIDER: "doubao",
    TRANSCRIPTION_FALLBACK_TO_OPENAI: "false",
    CANDIDATE_AV_REVIEW_PROVIDER: "doubao",
    AV_REVIEW_FALLBACK_TO_SAMPLED_STILLS: "0",
    DOUBAO_ASR_APP_KEY: "app-key",
    DOUBAO_ASR_ACCESS_KEY: "access-key",
    DOUBAO_ARK_API_KEY: "ark-key",
  });

  assert.equal(config.providers.transcription, "doubao");
  assert.equal(config.providers.transcriptionFallbackToOpenai, false);
  assert.equal(config.providers.candidateAvReview, "doubao");
  assert.equal(config.providers.avReviewFallbackToSampledStills, false);
  assert.equal(config.doubao.asr.appKey, "app-key");
  assert.equal(config.doubao.asr.accessKey, "access-key");
  assert.equal(
    config.doubao.ark.baseUrl,
    "https://ark.cn-beijing.volces.com/api/v3",
  );
});
