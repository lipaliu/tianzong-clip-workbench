import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";

import { buildApp } from "../app.js";
import { AppError, publicError } from "../errors.js";
import { ProcessorRepository } from "../repository.js";
import { registerRoutes } from "../routes.js";

const coreBytes = Buffer.from("pinned private core fixture");
const config = {
  nodeEnv: "test",
  port: 10_000,
  logLevel: "silent",
  databaseUrl: "postgresql://test:test@localhost/test",
  internalApiKeys: new Map([["test", "x".repeat(32)]]),
  signatureTtlSeconds: 300,
  r2: {
    endpoint: "https://example.invalid",
    accessKeyId: "test",
    secretAccessKey: "test",
    bucket: "test",
    region: "auto",
    presignTtlSeconds: 900,
    previewTtlSeconds: 600,
    maxUploadBytes: 9_000_000_000,
    singlePutMaxBytes: 4_900_000_000,
    multipartPartSizeBytes: 64 * 1024 * 1024,
    multipartPresignBatchSize: 12,
  },
  openai: {
    apiKey: "test",
    baseUrl: "https://api.openai.com/v1",
    transcriptionModel: "gpt-4o-transcribe-diarize",
    reasoningModel: "gpt-5.6-sol",
    visionModel: "gpt-5.6-sol",
  },
  core: {
    objectKey: "private/core.skill",
    sha256: createHash("sha256").update(coreBytes).digest("hex"),
    version: "1.2.0-private.1",
    promptVersion: "1.2.0",
    schemaVersion: "1.1.0",
    factSchemaVersion: "1.0.0",
    ledgerSchemaVersion: "1.0.0",
  },
  worker: {
    pollIntervalMs: 1_500,
    leaseSeconds: 120,
    maxAttempts: 3,
    heartbeatIntervalMs: 30_000,
    heartbeatMaxAgeSeconds: 120,
    transcriptionSegmentSeconds: 600,
    visionSampleSeconds: 12,
    visionBatchSize: 8,
    candidateFrameSeconds: 2,
    analysisWindowSeconds: 600,
    workDirectory: "/tmp/tianclip-test",
  },
};

function fakeDatabase(handler) {
  const calls = [];
  return {
    calls,
    database: {
      async query(text, values = []) {
        calls.push({ text, values });
        return await handler(text, values, calls);
      },
    },
  };
}

test("repository upserts worker liveness and queries the configured freshness window", async () => {
  const { database, calls } = fakeDatabase(async (text) => {
    if (text.includes("INSERT INTO worker_heartbeats")) {
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("FROM worker_heartbeats")) {
      return { rowCount: 1, rows: [{ active: true }] };
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const repository = new ProcessorRepository(database, config);

  await repository.touchWorkerHeartbeat("render-worker:test:1");
  assert.equal(await repository.hasRecentWorkerHeartbeat(), true);

  const upsert = calls.find((call) => call.text.includes("INSERT INTO worker_heartbeats"));
  assert.ok(upsert);
  assert.match(upsert.text, /ON CONFLICT\(worker_id\) DO UPDATE/);
  assert.deepEqual(upsert.values, ["render-worker:test:1"]);

  const freshness = calls.find((call) => call.text.includes("FROM worker_heartbeats"));
  assert.ok(freshness);
  assert.deepEqual(freshness.values, [120]);
});

test("job creation fails closed before queue insertion when no worker is recent", async () => {
  const { database, calls } = fakeDatabase(async (text) => {
    if (text.includes("SELECT * FROM media_uploads")) {
      return { rowCount: 1, rows: [{ status: "uploaded" }] };
    }
    if (text.includes("FROM worker_heartbeats")) {
      return { rowCount: 1, rows: [{ active: false }] };
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const repository = new ProcessorRepository(database, config);

  await assert.rejects(
    repository.createJob({ projectId: "project-1", uploadId: "upload-1" }),
    (error) => error?.code === "worker_unavailable" && error?.statusCode === 503,
  );
  assert.ok(!calls.some((call) => call.text.includes("INSERT INTO processing_jobs")));
});

async function readinessApp(workerActive) {
  const { database } = fakeDatabase(async (text) => {
    if (text === "SELECT 1") return { rowCount: 1, rows: [{ "?column?": 1 }] };
    throw new Error(`unexpected query: ${text}`);
  });
  const repository = {
    async hasRecentWorkerHeartbeat() {
      return workerActive;
    },
  };
  const storage = {
    async head() {
      return { ContentLength: coreBytes.byteLength };
    },
    async getBuffer() {
      return coreBytes;
    },
  };
  return await buildApp({ config, database, repository, storage });
}

test("/readyz reports the worker dependency when all gates are live", async () => {
  const app = await readinessApp(true);
  try {
    const response = await app.inject({ method: "GET", url: "/readyz" });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().ready, true);
    assert.equal(response.json().dependencies.backgroundWorker, true);
  } finally {
    await app.close();
  }
});

test("/readyz returns 503 when the worker heartbeat is stale", async () => {
  const app = await readinessApp(false);
  try {
    const response = await app.inject({ method: "GET", url: "/readyz" });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().ready, false);
    assert.equal(response.json().error.code, "not_ready");
  } finally {
    await app.close();
  }
});

test("job route preserves the fail-closed worker-unavailable response", async () => {
  const repository = {
    async withIdempotency(_scope, _key, _hash, operation) {
      return { ...(await operation()), replayed: false };
    },
    async createJob() {
      throw new AppError(
        503,
        "worker_unavailable",
        "后台处理服务暂不可用，请稍后重试。",
        { expose: true },
      );
    },
  };
  const app = Fastify({ logger: false });
  app.setErrorHandler(async (error, _request, reply) => {
    const response = publicError(error);
    return reply.code(response.statusCode).send(response.body);
  });
  await registerRoutes(app, { config, repository, storage: {} });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/projects/22222222-2222-4222-8222-222222222222/jobs",
      headers: { "idempotency-key": "worker-gate-route-1" },
      payload: { uploadId: "33333333-3333-4333-8333-333333333333" },
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error.code, "worker_unavailable");
  } finally {
    await app.close();
  }
});
