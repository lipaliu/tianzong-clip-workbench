/**
 * 真实分片上传与断点续传验证。
 *
 * 模拟浏览器行为：申请分片凭证 -> 只上传前半部分分片（模拟断网/刷新）
 * -> 通过分片状态接口对账已上传分片 -> 续传剩余分片 -> 完成合并。
 * 全部 PUT 均直接打到预签名返回的主机，因此可验证浏览器可达性。
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.PROCESSOR_BASE_URL;
const secretPath = process.env.PROCESSOR_SECRET_PATH;
if (!baseUrl || !secretPath) throw new Error("缺少 PROCESSOR_BASE_URL 或 PROCESSOR_SECRET_PATH。");
const secret = (await readFile(secretPath, "utf8")).trim();
const actor = "resumable-upload-verification";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
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
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

const log = (obj) => console.log(JSON.stringify(obj));

// 构造一个刚好超过分片阈值的原片体（分片阈值为 512MB，此处用较小分片配置无法触发，
// 因此改为直接构造超过阈值的字节数，并按处理器返回的分片计划上传真实字节）。
// 为控制验证时长，使用稀疏内容而非真实视频：本脚本只验证传输链路与续传对账。
const partSizeTarget = Number(process.env.VERIFY_TOTAL_BYTES ?? 700 * 1024 * 1024);

const projectId = randomUUID();
await signedRequest("POST", "/v1/projects", {
  id: projectId,
  title: "断点续传验证",
  projectDate: "2026-08-13",
  sourceName: "resumable-verification.mp4",
  mode: "聊播",
  editorMode: "doubao",
}, { idempotencyKey: `verify-project-${projectId}` });
log({ step: "project_created", projectId });

const body = Buffer.alloc(partSizeTarget, 7);
const presign = await signedRequest("POST", `/v1/projects/${projectId}/uploads/presign`, {
  sourceName: "resumable-verification.mp4",
  contentType: "video/mp4",
  purpose: "source_video",
  sizeBytes: body.byteLength,
  sha256: sha256(body),
}, { idempotencyKey: `verify-presign-${randomUUID()}` });

const upload = presign.upload;
if (upload.strategy !== "multipart") {
  throw new Error(`预期分片上传，实际为 ${upload.strategy}（总字节 ${body.byteLength}）`);
}
const uploadId = upload.id;
const partSizeBytes = upload.partSizeBytes;
const partCount = upload.partCount;
// 处理器只返回分片数量与分片大小，分片边界由客户端按同一规则推导。
const plan = Array.from({ length: partCount }, (_, index) => {
  const start = index * partSizeBytes;
  return {
    partNumber: index + 1,
    sizeBytes: Math.min(partSizeBytes, body.byteLength - start),
  };
});
log({
  step: "multipart_presign",
  uploadId,
  partCount,
  partSizeBytes,
});

function sliceForPart(index) {
  const start = index * partSizeBytes;
  return body.subarray(start, start + plan[index].sizeBytes);
}

async function presignParts(partNumbers) {
  const urls = new Map();
  // 每次签发存在批量上限，按批请求。
  for (let index = 0; index < partNumbers.length; index += 20) {
    const batch = partNumbers.slice(index, index + 20);
    const result = await signedRequest(
      "POST",
      `/v1/projects/${projectId}/uploads/${uploadId}/multipart/parts`,
      { partNumbers: batch },
      { idempotencyKey: `verify-parts-${randomUUID()}` },
    );
    for (const part of result.parts) urls.set(part.partNumber, part.putUrl);
  }
  return urls;
}

async function putPart(partNumber, url, chunk, refresh) {
  let lastError;
  // 沙箱到北京为跟境外链路，单片可能失速；与前端一致地重试并重签。
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const target = attempt === 0 ? url : (await refresh(partNumber)) ?? url;
      const response = await fetch(target, {
        method: "PUT",
        body: chunk,
        signal: AbortSignal.timeout(600_000),
      });
      if (!response.ok) {
        throw new Error(`分片 ${partNumber} -> ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const etag = response.headers.get("etag");
      if (!etag) throw new Error(`分片 ${partNumber} 未返回 ETag`);
      return etag;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function refreshPartUrl(partNumber) {
  const urls = await presignParts([partNumber]);
  return urls.get(partNumber);
}

// 阶段一：只上传一半分片，模拟断网或刷新页面
const half = Math.max(1, Math.floor(plan.length / 2));
const firstBatch = plan.slice(0, half).map((part) => part.partNumber);
const firstUrls = await presignParts(firstBatch);
for (const partNumber of firstBatch) {
  await putPart(partNumber, firstUrls.get(partNumber), sliceForPart(partNumber - 1), refreshPartUrl);
}
log({ step: "interrupted_after_partial_upload", uploadedParts: firstBatch.length, totalParts: plan.length });

// 阶段二：云端对账，确认真实断点
const status = await signedRequest(
  "GET",
  `/v1/projects/${projectId}/uploads/${uploadId}/multipart/status`,
  undefined,
);
log({
  step: "resume_status_reconciled",
  reportedStatus: status.status,
  partCount: status.partCount,
  uploadedParts: status.uploadedParts.length,
});
if (status.uploadedParts.length !== firstBatch.length) {
  throw new Error(`断点对账不一致：云端 ${status.uploadedParts.length}，实际已传 ${firstBatch.length}`);
}

// 阶段三：只续传缺失分片
const uploadedNumbers = new Set(status.uploadedParts.map((part) => part.partNumber));
const remaining = plan.map((part) => part.partNumber).filter((n) => !uploadedNumbers.has(n));
const remainingUrls = await presignParts(remaining);
for (const partNumber of remaining) {
  await putPart(partNumber, remainingUrls.get(partNumber), sliceForPart(partNumber - 1), refreshPartUrl);
}
log({ step: "resumed_remaining_parts", resumed: remaining.length });

// 阶段四：完成合并
const finalStatus = await signedRequest(
  "GET",
  `/v1/projects/${projectId}/uploads/${uploadId}/multipart/status`,
  undefined,
);
const allParts = finalStatus.uploadedParts
  .map((part) => ({ partNumber: part.partNumber, etag: part.etag }))
  .sort((a, b) => a.partNumber - b.partNumber);
const completed = await signedRequest(
  "POST",
  `/v1/projects/${projectId}/uploads/${uploadId}/multipart/complete`,
  { parts: allParts },
  { idempotencyKey: `verify-complete-${randomUUID()}`, timeoutMs: 180_000 },
);
log({
  step: "multipart_completed",
  status: completed.upload?.status,
  sizeBytes: completed.upload?.sizeBytes,
  expectedBytes: body.byteLength,
  partCount: completed.upload?.partCount,
  sizeMatches: completed.upload?.sizeBytes === body.byteLength,
});
