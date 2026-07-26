import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import {
  buildMultipartPartPlan,
  normalizeMultipartEtag,
} from "../multipart.js";
import { registerRoutes } from "../routes.js";

const knownJuly3RecordingBytes = 8_242_271_965;
const partSizeBytes = 64 * 1024 * 1024;

const config = {
  r2: {
    maxUploadBytes: 9_000_000_000,
    singlePutMaxBytes: 4_900_000_000,
    multipartPartSizeBytes: partSizeBytes,
    multipartPresignBatchSize: 12,
    presignTtlSeconds: 3_600,
  },
};

function baseRepository(overrides = {}) {
  return {
    async withIdempotency(_scope, _key, _hash, operation) {
      return { ...(await operation()), replayed: false };
    },
    async createUpload(input) {
      return {
        id: "db0d9f6f-9e6f-4c73-8f67-c6fa04fc9650",
        objectKey: `uploads/${input.projectId}/source.mp4`,
      };
    },
    async beginMultipartUpload() {},
    async finishMultipartUploadState() {},
    ...overrides,
  };
}

async function multipartApp(repository, storage) {
  const app = Fastify({ logger: false });
  await registerRoutes(app, { config, repository, storage });
  return app;
}

test("known 8.24 GB July 3 recording is planned below the internal limit", () => {
  assert.ok(knownJuly3RecordingBytes < config.r2.maxUploadBytes);
  const plan = buildMultipartPartPlan(knownJuly3RecordingBytes, partSizeBytes);
  assert.equal(plan.length, 123);
  assert.equal(plan[0].sizeBytes, partSizeBytes);
  assert.equal(plan.at(-1).sizeBytes, 54_990_557);
  assert.equal(
    plan.reduce((sum, part) => sum + part.sizeBytes, 0),
    knownJuly3RecordingBytes,
  );
  assert.deepEqual(
    plan.map((part) => part.partNumber),
    Array.from({ length: 123 }, (_, index) => index + 1),
  );
});

test("multipart init records the R2 upload ID and the exact part plan", async () => {
  let createdInput;
  let initializedInput;
  const repository = baseRepository({
    async createUpload(input) {
      createdInput = input;
      return {
        id: "db0d9f6f-9e6f-4c73-8f67-c6fa04fc9650",
        objectKey: `uploads/${input.projectId}/source.mp4`,
      };
    },
    async beginMultipartUpload(input) {
      initializedInput = input;
    },
  });
  const storage = {
    async createMultipartUpload() {
      return { multipartUploadId: "r2-multipart-id" };
    },
  };
  const app = await multipartApp(repository, storage);
  try {
    const projectId = "b2bb75ef-a939-407a-9297-d17c71a51ca2";
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/uploads/presign`,
      headers: { "idempotency-key": "multipart-init-test" },
      payload: {
        sourceName: "已转码_天总_2026年7月3日.mp4",
        contentType: "video/mp4",
        sizeBytes: knownJuly3RecordingBytes,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const payload = response.json();
    assert.equal(payload.upload.strategy, "multipart");
    assert.equal(payload.upload.partSizeBytes, partSizeBytes);
    assert.equal(payload.upload.partCount, 123);
    assert.equal(createdInput.strategy, "multipart");
    assert.equal(initializedInput.multipartUploadId, "r2-multipart-id");
    assert.equal(initializedInput.parts.length, 123);
  } finally {
    await app.close();
  }
});

test("multipart completion verifies count, size and ETag before publishing", async () => {
  const projectId = "b2bb75ef-a939-407a-9297-d17c71a51ca2";
  const uploadId = "db0d9f6f-9e6f-4c73-8f67-c6fa04fc9650";
  const expected = [
    { partNumber: 1, sizeBytes: partSizeBytes },
    { partNumber: 2, sizeBytes: 9_000_000 },
  ];
  const clientParts = [
    { partNumber: 1, etag: "\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"" },
    { partNumber: 2, etag: "\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"" },
  ];
  let recorded;
  let completed;
  let finalUpload;
  const repository = baseRepository({
    async getUpload() {
      return {
        upload_strategy: "multipart",
        multipart_upload_id: "r2-multipart-id",
        multipart_part_count: 2,
        status: "uploading",
        object_key: `uploads/${projectId}/${uploadId}/source.mp4`,
        expected_size_bytes: partSizeBytes + 9_000_000,
        expected_sha256: null,
      };
    },
    async getMultipartPartPlan() {
      return expected;
    },
    async recordMultipartParts(input) {
      recorded = input.parts;
    },
    async markMultipartCompleting() {},
    async completeUpload(input) {
      finalUpload = input;
    },
  });
  const storage = {
    async listMultipartParts() {
      return [
        {
          partNumber: 2,
          sizeBytes: 9_000_000,
          etag: "\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"",
        },
        {
          partNumber: 1,
          sizeBytes: partSizeBytes,
          etag: "\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"",
        },
      ];
    },
    async completeMultipartUpload(input) {
      completed = input.parts;
      return { etag: "\"combined\"" };
    },
    async head() {
      return {
        ContentLength: partSizeBytes + 9_000_000,
        ETag: "\"combined\"",
        Metadata: { "project-id": projectId },
      };
    },
    async abortMultipartUpload() {
      throw new Error("must not abort a verified upload");
    },
    async delete() {
      throw new Error("must not delete a verified upload");
    },
  };
  const app = await multipartApp(repository, storage);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/uploads/${uploadId}/multipart/complete`,
      headers: { "idempotency-key": "multipart-complete-test" },
      payload: { parts: clientParts },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(recorded.map((part) => part.partNumber), [1, 2]);
    assert.deepEqual(completed.map((part) => part.partNumber), [1, 2]);
    assert.equal(finalUpload.actualSizeBytes, partSizeBytes + 9_000_000);
  } finally {
    await app.close();
  }
});

test("multipart part signing is limited to the persisted plan", async () => {
  const projectId = "b2bb75ef-a939-407a-9297-d17c71a51ca2";
  const uploadId = "db0d9f6f-9e6f-4c73-8f67-c6fa04fc9650";
  const signedNumbers = [];
  let markedUploading = false;
  const repository = baseRepository({
    async getUpload() {
      return {
        upload_strategy: "multipart",
        multipart_upload_id: "r2-multipart-id",
        status: "multipart_initiated",
        object_key: "uploads/project/source.mp4",
      };
    },
    async getMultipartPartPlan() {
      return [
        { partNumber: 1, sizeBytes: partSizeBytes },
        { partNumber: 2, sizeBytes: 9_000_000 },
      ];
    },
    async markMultipartUploading() {
      markedUploading = true;
    },
  });
  const storage = {
    async presignMultipartPart(input) {
      signedNumbers.push(input.partNumber);
      return {
        url: `https://upload.invalid/part-${input.partNumber}`,
        expiresIn: 3_600,
      };
    },
  };
  const app = await multipartApp(repository, storage);
  try {
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/uploads/${uploadId}/multipart/parts`,
      headers: { "idempotency-key": "multipart-parts-test" },
      payload: { partNumbers: [1, 2] },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(signedNumbers, [1, 2]);
    assert.equal(markedUploading, true);

    const rejected = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/uploads/${uploadId}/multipart/parts`,
      headers: { "idempotency-key": "multipart-parts-bad-test" },
      payload: { partNumbers: [3] },
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
  } finally {
    await app.close();
  }
});

test("a mismatched multipart ETag fails closed and aborts the R2 upload", async () => {
  const projectId = "b2bb75ef-a939-407a-9297-d17c71a51ca2";
  const uploadId = "db0d9f6f-9e6f-4c73-8f67-c6fa04fc9650";
  let abortCount = 0;
  let failedStatus = null;
  const repository = baseRepository({
    async getUpload() {
      return {
        upload_strategy: "multipart",
        multipart_upload_id: "r2-multipart-id",
        multipart_part_count: 2,
        status: "uploading",
        object_key: "uploads/project/source.mp4",
        expected_size_bytes: 12_000_000,
        expected_sha256: null,
      };
    },
    async getMultipartPartPlan() {
      return [
        { partNumber: 1, sizeBytes: 6_000_000 },
        { partNumber: 2, sizeBytes: 6_000_000 },
      ];
    },
    async finishMultipartUploadState(_projectId, _uploadId, status) {
      failedStatus = status;
    },
  });
  const storage = {
    async listMultipartParts() {
      return [
        {
          partNumber: 1,
          sizeBytes: 6_000_000,
          etag: "\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"",
        },
        {
          partNumber: 2,
          sizeBytes: 6_000_000,
          etag: "\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"",
        },
      ];
    },
    async abortMultipartUpload() {
      abortCount += 1;
    },
  };
  const app = await multipartApp(repository, storage);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/uploads/${uploadId}/multipart/complete`,
      headers: { "idempotency-key": "multipart-mismatch-test" },
      payload: {
        parts: [
          { partNumber: 1, etag: "\"cccccccccccccccccccccccccccccccc\"" },
          { partNumber: 2, etag: "\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"" },
        ],
      },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(abortCount, 1);
    assert.equal(failedStatus, "failed");
  } finally {
    await app.close();
  }
});

test("ETag normalization accepts quoted R2 values and rejects control text", () => {
  assert.equal(
    normalizeMultipartEtag("\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\""),
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.throws(() => normalizeMultipartEtag("\"bad etag\""));
});
