import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProcessorRepository } from "../repository.js";
import { PrivateObjectStorage } from "../storage.js";

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
    maxUploadBytes: 4_900_000_000,
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
    sha256: "a".repeat(64),
    version: "1.2.3-private.1",
    promptVersion: "1.2.3",
    schemaVersion: "1.1.0",
    factSchemaVersion: "1.0.0",
    ledgerSchemaVersion: "1.0.0",
  },
  worker: {
    pollIntervalMs: 1_500,
    leaseSeconds: 120,
    maxAttempts: 3,
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
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      return await handler(text, values, calls);
    },
    release() {},
  };
  return {
    calls,
    database: {
      async connect() {
        return client;
      },
      async query(text, values = []) {
        calls.push({ text, values });
        return await handler(text, values, calls);
      },
    },
  };
}

const claimedJob = {
  id: "job-1",
  workerId: "worker-new",
  projectId: "project-1",
  uploadId: "upload-1",
  objectKey: "uploads/project-1/source.mp4",
  sourceName: "source.mp4",
  expectedSizeBytes: 1,
  expectedSha256: null,
  mode: "聊播",
  attempt: 1,
  maxAttempts: 3,
};

const claimedRender = {
  id: "render-1",
  workerId: "worker-new",
  candidateId: "candidate-1",
  projectId: "project-1",
  uploadId: "upload-1",
  objectKey: "uploads/project-1/source.mp4",
  spec: {
    sourceStart: 1,
    sourceEnd: 2,
    transcriptDecisions: [],
  },
  approvalTarget: false,
  attempt: 1,
  maxAttempts: 3,
  payload: {},
};

test("stage writes are fenced by worker identity and a live lease", async () => {
  const { database, calls } = fakeDatabase(async (text) => {
    if (text.includes("UPDATE processing_jobs")) {
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const repository = new ProcessorRepository(database, config);

  await assert.rejects(
    repository.updateJobStage(
      claimedJob.id,
      claimedJob.workerId,
      "transcribing",
      20,
      "progress",
    ),
    (error) => error?.code === "job_lease_lost",
  );

  const write = calls.find((call) => call.text.includes("UPDATE processing_jobs"));
  assert.ok(write);
  assert.match(write.text, /worker_id = \$4/);
  assert.match(write.text, /lease_expires_at > now\(\)/);
  assert.equal(write.values[3], claimedJob.workerId);
  assert.ok(calls.some((call) => call.text === "ROLLBACK"));
  assert.ok(!calls.some((call) => call.text.includes("UPDATE projects")));
});

test("candidate publication aborts before destructive writes when lease is stale", async () => {
  const { database, calls } = fakeDatabase(async (text) => {
    if (text.includes("SELECT project_id") && text.includes("FOR UPDATE")) {
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const repository = new ProcessorRepository(database, config);

  await assert.rejects(
    repository.storeCandidates(
      claimedJob,
      [],
      { version: config.core.version, sha256: config.core.sha256 },
      {},
    ),
    (error) => error?.code === "job_lease_lost",
  );

  const fence = calls.find((call) => call.text.includes("SELECT project_id"));
  assert.ok(fence);
  assert.match(fence.text, /worker_id = \$2/);
  assert.match(fence.text, /lease_expires_at > now\(\)/);
  assert.deepEqual(fence.values, [claimedJob.id, claimedJob.workerId]);
  assert.ok(!calls.some((call) => call.text.includes("DELETE FROM candidates")));
  assert.ok(!calls.some((call) => call.text.includes("INSERT INTO candidates")));
});

test("stale render completion cannot publish a candidate revision", async () => {
  const { database, calls } = fakeDatabase(async (text) => {
    if (text.includes("UPDATE candidate_renders")) {
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const repository = new ProcessorRepository(database, config);

  await assert.rejects(
    repository.completeRender(
      claimedRender,
      "revisions/project-1/candidate-1/render-1.mp4",
      {},
    ),
    (error) => error?.code === "render_lease_lost",
  );

  const write = calls.find((call) => call.text.includes("UPDATE candidate_renders"));
  assert.ok(write);
  assert.match(write.text, /worker_id = \$3/);
  assert.match(write.text, /lease_expires_at > now\(\)/);
  assert.equal(write.values[2], claimedRender.workerId);
  assert.ok(!calls.some((call) => call.text.includes("UPDATE candidates")));
});

test("a stale worker's failure handler becomes a no-op", async () => {
  const { database, calls } = fakeDatabase(async (text) => {
    if (text.includes("UPDATE processing_jobs")) {
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const repository = new ProcessorRepository(database, config);

  assert.equal(
    await repository.failOrRetryJob(
      claimedJob,
      "public",
      "internal",
      true,
    ),
    false,
  );
  assert.ok(!calls.some((call) => call.text.includes("UPDATE projects")));
  assert.ok(!calls.some((call) => call.text.includes("INSERT INTO job_events")));
  assert.ok(calls.some((call) => call.text === "COMMIT"));
});

test("uploadFile streams from disk and writes verified integrity metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tianclip-storage-"));
  const file = join(directory, "preview.mp4");
  const body = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
  await writeFile(file, body);
  const expectedSha256 = createHash("sha256").update(body).digest("hex");
  const storage = new PrivateObjectStorage(config);
  let captured;

  storage.client.send = async (command) => {
    captured = command.input;
    assert.ok(captured.Body);
    assert.equal(Buffer.isBuffer(captured.Body), false);
    const chunks = [];
    for await (const chunk of captured.Body) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), body);
    return {};
  };

  try {
    const integrity = await storage.uploadFile(
      "previews/project-1/candidate-1.mp4",
      file,
      "video/mp4",
      { kind: "rough-preview", sha256: "caller-cannot-override" },
    );
    assert.deepEqual(integrity, {
      sha256: expectedSha256,
      sizeBytes: body.length,
    });
    assert.equal(captured.ContentLength, body.length);
    assert.equal(captured.Metadata.sha256, expectedSha256);
    assert.equal(captured.Metadata["size-bytes"], String(body.length));
    assert.equal(captured.Metadata.kind, "rough-preview");
  } finally {
    storage.client.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
