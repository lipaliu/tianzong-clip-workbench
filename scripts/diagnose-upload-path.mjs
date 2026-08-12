import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.PROCESSOR_BASE_URL;
const secretPath = process.env.PROCESSOR_SECRET_PATH;
if (!baseUrl || !secretPath) throw new Error("缺少诊断配置。");
const secret = (await readFile(secretPath, "utf8")).trim();
const actor = "upload-path-diagnostic";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
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
    signal: AbortSignal.timeout(options.timeoutMs ?? 40_000),
  });
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 400) }; }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

const projectId = randomUUID();
await signedRequest("POST", "/v1/projects", {
  id: projectId,
  title: "上传链路诊断",
  projectDate: "2026-08-13",
  sourceName: "diagnostic.mp4",
  mode: "聊播",
  editorMode: "doubao",
}, { idempotencyKey: `diag-project-${projectId}` });
console.log(JSON.stringify({ step: "project_created", projectId }));

// 1) 小文件单次上传凭证
const small = Buffer.from("diagnostic-single-upload-body");
const singlePresign = await signedRequest("POST", `/v1/projects/${projectId}/uploads/presign`, {
  sourceName: "diagnostic-small.mp4",
  contentType: "video/mp4",
  purpose: "source_video",
  sizeBytes: small.byteLength,
  sha256: sha256(small),
}, { idempotencyKey: `diag-single-${randomUUID()}` });
console.log(JSON.stringify({
  step: "single_presign",
  strategy: singlePresign.upload?.strategy,
  hasPutUrl: Boolean(singlePresign.upload?.putUrl),
  requiredHeaders: singlePresign.upload?.requiredHeaders,
  putHost: singlePresign.upload?.putUrl ? new URL(singlePresign.upload.putUrl).host : null,
}));

// 2) 从沙箱直接 PUT，模拟浏览器直传
const putResponse = await fetch(singlePresign.upload.putUrl, {
  method: "PUT",
  headers: singlePresign.upload.requiredHeaders ?? {},
  body: small,
  signal: AbortSignal.timeout(60_000),
});
const putBody = await putResponse.text();
console.log(JSON.stringify({
  step: "browser_style_put",
  status: putResponse.status,
  ok: putResponse.ok,
  body: putBody.slice(0, 600),
  allowOrigin: putResponse.headers.get("access-control-allow-origin"),
}));

// 3) CORS 预检，浏览器直传的前置条件
const preflight = await fetch(singlePresign.upload.putUrl, {
  method: "OPTIONS",
  headers: {
    origin: "https://tianzong-clip-workbench.lipaliu514.workers.dev",
    "access-control-request-method": "PUT",
    "access-control-request-headers": Object.keys(singlePresign.upload.requiredHeaders ?? {}).join(","),
  },
  signal: AbortSignal.timeout(30_000),
});
console.log(JSON.stringify({
  step: "cors_preflight",
  status: preflight.status,
  allowOrigin: preflight.headers.get("access-control-allow-origin"),
  allowMethods: preflight.headers.get("access-control-allow-methods"),
  allowHeaders: preflight.headers.get("access-control-allow-headers"),
  exposeHeaders: preflight.headers.get("access-control-expose-headers"),
}));

// 4) 大文件分片凭证
const bigPresign = await signedRequest("POST", `/v1/projects/${projectId}/uploads/presign`, {
  sourceName: "diagnostic-large.mp4",
  contentType: "video/mp4",
  purpose: "source_video",
  sizeBytes: 3 * 1024 * 1024 * 1024,
  sha256: sha256(Buffer.from("large-placeholder")),
}, { idempotencyKey: `diag-multipart-${randomUUID()}` });
console.log(JSON.stringify({
  step: "multipart_presign",
  strategy: bigPresign.upload?.strategy,
  partSize: bigPresign.upload?.partSizeBytes,
  partCount: bigPresign.upload?.parts?.length ?? bigPresign.upload?.partCount ?? null,
  firstPartHost: bigPresign.upload?.parts?.[0]?.putUrl ? new URL(bigPresign.upload.parts[0].putUrl).host : null,
}));
