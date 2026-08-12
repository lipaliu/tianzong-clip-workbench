import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const baseUrl = process.env.PROCESSOR_BASE_URL;
const secretPath = process.env.PROCESSOR_SECRET_PATH;
const videoPath = process.env.E2E_VIDEO_PATH;
const subtitlePath = process.env.E2E_SUBTITLE_PATH;
const remoteHost = process.env.E2E_REMOTE_HOST;
const sshKeyPath = process.env.E2E_SSH_KEY;
if (!baseUrl || !secretPath || !videoPath || !subtitlePath || !remoteHost || !sshKeyPath) {
  throw new Error("缺少验收运行配置。");
}
const secret = (await readFile(secretPath, "utf8")).trim();
const actor = "deployment-e2e-verifier";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
async function signedRequest(method, path, body, options = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(24).toString("hex");
  const serialized = body === undefined ? "" : canonicalJson(body);
  const contentSha256 = sha256(serialized);
  const canonical = ["tianclip-v2", method, path, timestamp, nonce, contentSha256, actor].join("\n");
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  const headers = {
    "x-tianclip-key-id": "sites-proxy",
    "x-tianclip-timestamp": timestamp,
    "x-tianclip-nonce": nonce,
    "x-tianclip-content-sha256": contentSha256,
    "x-tianclip-actor": actor,
    "x-tianclip-signature": signature,
    accept: "application/json",
    ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers,
    ...(body === undefined ? {} : { body: serialized }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runRemote(command, label) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      execFileSync("ssh", [
        "-i", sshKeyPath,
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=15",
        "-o", "ConnectionAttempts=3",
        "-o", "ServerAliveInterval=5",
        "-o", "ServerAliveCountMax=3",
        `root@${remoteHost}`,
        command,
      ], { stdio: "ignore" });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${label}因北京实例短暂SSH抖动未完成，请稍后重试。`);
}

function copyToBeijing(localPath, remotePath, label) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      execFileSync("scp", [
        "-i", sshKeyPath,
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=15",
        "-o", "ConnectionAttempts=3",
        localPath,
        `root@${remoteHost}:${remotePath}`,
      ], { stdio: "ignore" });
      return;
    } catch {
      // Retrying the same immutable file transfer is safe.
    }
  }
  throw new Error(`${label}未能稳定传入北京实例，请稍后重试。`);
}

async function uploadFromBeijingInstance(filePath, putUrl, requiredHeaders) {
  const transferId = randomUUID();
  const remoteFilePath = `/tmp/changdao-e2e-${transferId}`;
  const remoteConfigPath = `/tmp/changdao-e2e-${transferId}.json`;
  const localConfigPath = `/tmp/changdao-e2e-${transferId}.json`;
  const remoteHelperPath = "/tmp/changdao-presigned-put.mjs";
  await writeFile(localConfigPath, JSON.stringify({
    putUrl,
    headers: requiredHeaders,
    filePath: remoteFilePath,
  }), { mode: 0o600 });
  try {
    copyToBeijing(filePath, remoteFilePath, "测试文件");
    copyToBeijing("/home/ubuntu/tianzong-clip-workbench/scripts/put-presigned-from-config.mjs", remoteHelperPath, "上传助手");
    copyToBeijing(localConfigPath, remoteConfigPath, "临时上传配置");
    runRemote([
      "set -euo pipefail",
      `node ${shellQuote(remoteHelperPath)} ${shellQuote(remoteConfigPath)}`,
      `rm -f ${shellQuote(remoteFilePath)} ${shellQuote(remoteConfigPath)}`,
    ].join("; "), "预签名对象上传");
  } finally {
    await writeFile(localConfigPath, "", { mode: 0o600 }).catch(() => undefined);
  }
}

async function uploadArtifact(projectId, filePath, sourceName, contentType, purpose) {
  const bytes = await readFile(filePath);
  const body = {
    sourceName,
    contentType,
    purpose,
    sizeBytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
  const signed = await signedRequest(
    "POST",
    `/v1/projects/${projectId}/uploads/presign`,
    body,
    { idempotencyKey: `e2e-presign-${purpose}-${randomUUID()}` },
  );
  const upload = signed.upload;
  if (!upload || upload.strategy !== "single" || !upload.putUrl) {
    throw new Error(`${purpose} 未获得单次上传凭证。`);
  }
  await uploadFromBeijingInstance(filePath, upload.putUrl, upload.requiredHeaders);
  await signedRequest(
    "POST",
    `/v1/projects/${projectId}/uploads/${upload.id}/complete`,
    {},
    { idempotencyKey: `e2e-complete-${purpose}-${randomUUID()}` },
  );
  return upload.id;
}

const projectId = randomUUID();
const project = await signedRequest(
  "POST",
  "/v1/projects",
  {
    id: projectId,
    title: "部署验收 · 字幕优先小样本",
    projectDate: "2026-08-12",
    sourceName: "processor-e2e-sample.mp4",
    mode: "聊播",
    editorMode: "doubao",
  },
  { idempotencyKey: `e2e-project-${projectId}` },
);
console.log(JSON.stringify({ checkpoint: "project_created", projectId: project.project.id }));

const videoUploadId = await uploadArtifact(
  projectId,
  videoPath,
  "processor-e2e-sample.mp4",
  "video/mp4",
  "source_video",
);
console.log(JSON.stringify({ checkpoint: "video_uploaded", uploadId: videoUploadId }));

const subtitleUploadId = await uploadArtifact(
  projectId,
  subtitlePath,
  "processor-e2e-sample.srt",
  "application/x-subrip",
  "subtitle_srt",
);
console.log(JSON.stringify({ checkpoint: "subtitle_uploaded", uploadId: subtitleUploadId }));

const started = await signedRequest(
  "POST",
  `/v1/projects/${projectId}/jobs`,
  { uploadId: videoUploadId, subtitleUploadId },
  { idempotencyKey: `e2e-job-${randomUUID()}` },
);
const jobId = started.job.id;
console.log(JSON.stringify({ checkpoint: "job_started", jobId, transcriptSource: started.job.transcriptSource }));

let cursor = 0;
for (let attempt = 0; attempt < 40; attempt += 1) {
  const eventPayload = await signedRequest("GET", `/v1/jobs/${jobId}/events?after=${cursor}`);
  for (const event of eventPayload.events ?? []) {
    cursor = Math.max(cursor, Number(event.id) || 0);
    console.log(JSON.stringify({ checkpoint: "event", stage: event.stage, progress: event.progress, message: event.message }));
  }
  const current = await signedRequest("GET", `/v1/jobs/${jobId}`);
  const job = current.job;
  if (["succeeded", "failed", "cancelled"].includes(job.status)) {
    const candidates = await signedRequest("GET", `/v1/projects/${projectId}/candidates`);
    const cost = await signedRequest("GET", `/v1/jobs/${jobId}/cost`);
    console.log(JSON.stringify({
      checkpoint: "complete",
      projectId,
      jobId,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      transcriptSource: job.transcriptSource,
      clipCount: job.clipCount,
      error: job.error,
      candidateCount: candidates.candidates?.length ?? 0,
      totalCny: cost.cost?.totalCny ?? null,
    }));
    process.exit(job.status === "succeeded" ? 0 : 1);
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}
throw new Error("验收任务在120秒内未完成。");
