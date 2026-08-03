import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const inputPath = resolve(process.env.TIANCLIP_INPUT_PATH ?? "");
const apiBase = String(
  process.env.TIANCLIP_PROCESSOR_API_URL ?? "http://api:10000",
).replace(/\/+$/, "");
const keyId = process.env.PROCESSOR_KEY_ID ?? "sites-proxy";
const actor = process.env.TIANCLIP_ACTOR ?? "production-e2e";
const mode = process.env.TIANCLIP_MODE === "带货" ? "带货" : "聊播";
const editorMode = ["openai", "doubao", "kimi", "compare", "compare_all"].includes(
  process.env.TIANCLIP_EDITOR_MODE,
)
  ? process.env.TIANCLIP_EDITOR_MODE
  : "doubao";
const outputDirectory = resolve(
  process.env.TIANCLIP_OUTPUT_DIRECTORY ?? "./production-e2e-output",
);
const pollIntervalMs = Number(process.env.TIANCLIP_POLL_INTERVAL_MS ?? 5_000);
const timeoutMs = Number(process.env.TIANCLIP_TIMEOUT_MS ?? 90 * 60 * 1_000);

function resolveSecret() {
  const direct = process.env.PROCESSOR_API_SECRET?.trim();
  if (direct) return direct;
  const configured = JSON.parse(process.env.INTERNAL_API_KEYS ?? "{}");
  const value = configured[keyId];
  if (typeof value !== "string" || value.length < 32) {
    throw new Error(`Missing internal API secret for key ${keyId}`);
  }
  return value;
}

const secret = resolveSecret();

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function contentSha256(body) {
  const source = body === undefined || body === null ? "" : canonicalJson(body);
  return createHash("sha256").update(source).digest("hex");
}

function signedHeaders(method, pathWithQuery, body) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = randomBytes(18).toString("base64url");
  const digest = contentSha256(body);
  const canonical = [
    "tianclip-v2",
    method.toUpperCase(),
    pathWithQuery,
    timestamp,
    nonce,
    digest,
    actor,
  ].join("\n");
  return {
    "x-tianclip-key-id": keyId,
    "x-tianclip-timestamp": timestamp,
    "x-tianclip-nonce": nonce,
    "x-tianclip-content-sha256": digest,
    "x-tianclip-actor": actor,
    "x-tianclip-signature": createHmac("sha256", secret)
      .update(canonical)
      .digest("hex"),
  };
}

async function api(method, path, body, { idempotent = false } = {}) {
  const url = new URL(path, `${apiBase}/`);
  const serialized = body === undefined ? undefined : canonicalJson(body);
  const headers = {
    accept: "application/json",
    ...signedHeaders(method, `${url.pathname}${url.search}`, body),
  };
  if (serialized !== undefined) headers["content-type"] = "application/json";
  if (idempotent) headers["idempotency-key"] = `e2e-${randomUUID()}`;
  const response = await fetch(url, {
    method,
    headers,
    body: serialized,
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${method} ${path} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(
      `${method} ${path} failed HTTP ${response.status}: ${
        payload?.error?.message ?? payload?.error ?? "unknown error"
      }`,
    );
  }
  return payload;
}

async function putFile(url, headers, filePath, sizeBytes) {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      ...headers,
      "content-length": String(sizeBytes),
    },
    body: createReadStream(filePath),
    duplex: "half",
    signal: AbortSignal.timeout(30 * 60 * 1_000),
  });
  if (!response.ok) {
    throw new Error(`Presigned upload failed HTTP ${response.status}`);
  }
}

async function download(url, destination) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15 * 60 * 1_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Candidate download failed HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

async function waitForJob(jobId) {
  const startedAt = Date.now();
  let lastStage = "";
  while (Date.now() - startedAt < timeoutMs) {
    const { job } = await api("GET", `/v1/jobs/${jobId}`);
    const stage = `${job.status}:${job.stage}:${job.progress}`;
    if (stage !== lastStage) {
      process.stdout.write(
        `${new Date().toISOString()} ${job.status} ${job.progress}% ${job.stage}\n`,
      );
      lastStage = stage;
    }
    if (job.status === "ready" || job.status === "succeeded") return job;
    if (job.status === "failed") {
      throw new Error(`Processor job failed: ${job.error ?? "unknown error"}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollIntervalMs));
  }
  throw new Error(`Processor job timed out after ${timeoutMs}ms`);
}

async function main() {
  if (!inputPath || inputPath === resolve(".")) {
    throw new Error("TIANCLIP_INPUT_PATH is required");
  }
  const source = await stat(inputPath);
  if (!source.isFile() || source.size <= 0) throw new Error("Input video is empty");
  await mkdir(outputDirectory, { recursive: true });

  const projectId = randomUUID();
  const sourceName = basename(inputPath);
  const projectDate = new Date().toISOString().slice(0, 10);
  process.stdout.write(
    `Creating real ${mode}/${editorMode} project for ${sourceName} (${source.size} bytes)\n`,
  );

  await api(
    "POST",
    "/v1/projects",
    {
      id: projectId,
      title: `${projectDate} · 生产链验收`,
      projectDate,
      sourceName,
      mode,
      editorMode,
    },
    { idempotent: true },
  );

  const { upload } = await api(
    "POST",
    `/v1/projects/${projectId}/uploads/presign`,
    {
      sourceName,
      contentType: "video/mp4",
      sizeBytes: source.size,
    },
    { idempotent: true },
  );
  if (upload.strategy !== "single") {
    throw new Error("This verifier currently requires a single-part input below 4.9GB");
  }

  process.stdout.write("Uploading original video to private object storage\n");
  await putFile(upload.putUrl, upload.requiredHeaders, inputPath, source.size);
  await api(
    "POST",
    `/v1/projects/${projectId}/uploads/${upload.id}/complete`,
    {},
    { idempotent: true },
  );
  const { job } = await api(
    "POST",
    `/v1/projects/${projectId}/jobs`,
    { uploadId: upload.id },
    { idempotent: true },
  );
  const completedJob = await waitForJob(job.id);
  const { candidates } = await api(
    "GET",
    `/v1/projects/${projectId}/candidates`,
  );
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("Real model run completed without any candidates");
  }

  const manifestPath = resolve(outputDirectory, `${projectId}.json`);
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        projectId,
        jobId: job.id,
        mode,
        editorMode,
        sourceName,
        result: completedJob.result,
        candidates,
      },
      null,
      2,
    ),
    "utf8",
  );

  const downloaded = [];
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate.previewUrl) continue;
    const outputPath = resolve(
      outputDirectory,
      `${String(index + 1).padStart(2, "0")}-${candidate.id}.mp4`,
    );
    await download(candidate.previewUrl, outputPath);
    downloaded.push(outputPath);
  }
  if (downloaded.length === 0) {
    throw new Error("Candidates were returned but no real preview MP4 was downloadable");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        projectId,
        jobId: job.id,
        candidateCount: candidates.length,
        downloadedCount: downloaded.length,
        outputDirectory,
        manifestPath,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
