import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../config.js";
import { PrivateObjectStorage } from "../storage.js";

const internalEndpoint = "https://tos-s3-cn-beijing.ivolces.com";
const publicEndpoint = "https://tos-s3-cn-beijing.volces.com";

const baseEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  INTERNAL_API_KEYS: JSON.stringify({ "sites-proxy": "x".repeat(32) }),
  R2_ENDPOINT: internalEndpoint,
  R2_PROVIDER_ENDPOINT: publicEndpoint,
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_BUCKET: "changdao-clip-test",
  R2_REGION: "cn-beijing",
  OPENAI_API_KEY: "test",
  OPENAI_TRANSCRIPTION_MODEL: "gpt-4o-transcribe-diarize",
  OPENAI_REASONING_MODEL: "gpt-5.6-sol",
  OPENAI_VISION_MODEL: "gpt-5.6-sol",
  TIANCLIP_CORE_S3_KEY: "private/core.skill",
  TIANCLIP_CORE_SHA256: "a".repeat(64),
  TIANCLIP_CORE_VERSION: "1.2.3-private.1",
  TIANCLIP_PROMPT_VERSION: "1.2.3",
  TIANCLIP_SCHEMA_VERSION: "1.1.0",
  TIANCLIP_FACT_SCHEMA_VERSION: "1.0.0",
  TIANCLIP_LEDGER_SCHEMA_VERSION: "1.0.0",
};

// A visitor's browser resolves DNS on the public internet, where the TOS
// internal endpoint (.ivolces.com) has no reachable route. Any presigned URL
// handed to the browser must therefore target the public endpoint, otherwise
// large uploads hang until the request times out.
test("single-file browser uploads are presigned against the public TOS endpoint", async () => {
  const storage = new PrivateObjectStorage(loadConfig(baseEnv));
  const presigned = await storage.presignUpload({
    objectKey: "projects/demo/source.mp4",
    contentType: "video/mp4",
    sha256: "b".repeat(64),
    projectId: "demo-project",
  });

  const host = new URL(presigned.url).host;
  assert.ok(host.endsWith("tos-s3-cn-beijing.volces.com"), `unexpected host: ${host}`);
  assert.ok(!host.includes("ivolces.com"), `internal endpoint leaked to browser: ${host}`);
  assert.equal(presigned.requiredHeaders["content-type"], "video/mp4");
});

test("resumable multipart part uploads are presigned against the public TOS endpoint", async () => {
  const storage = new PrivateObjectStorage(loadConfig(baseEnv));
  const presigned = await storage.presignMultipartPart({
    objectKey: "projects/demo/source.mp4",
    multipartUploadId: "test-multipart-upload-id",
    partNumber: 7,
  });

  const host = new URL(presigned.url).host;
  assert.ok(host.endsWith("tos-s3-cn-beijing.volces.com"), `unexpected host: ${host}`);
  assert.ok(!host.includes("ivolces.com"), `internal endpoint leaked to browser: ${host}`);
});

test("provider downloads stay public while processor-side access stays internal", async () => {
  const config = loadConfig(baseEnv);
  const storage = new PrivateObjectStorage(config);

  const providerDownload = await storage.presignDownload("projects/demo/audio.mp3");
  assert.ok(new URL(providerDownload.url).host.endsWith("tos-s3-cn-beijing.volces.com"));

  const internalResolved = await storage.client.config.endpoint?.();
  assert.equal(internalResolved?.hostname, "tos-s3-cn-beijing.ivolces.com");
});
