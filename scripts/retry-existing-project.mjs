import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

const apiBase = String(
  process.env.TIANCLIP_PROCESSOR_API_URL ?? "http://api:10000",
).replace(/\/+$/, "");
const keyId = process.env.PROCESSOR_KEY_ID ?? "sites-proxy";
const actor = process.env.TIANCLIP_ACTOR ?? "production-retry";
const projectId = process.env.TIANCLIP_PROJECT_ID?.trim();
const uploadId = process.env.TIANCLIP_UPLOAD_ID?.trim();

if (!projectId || !uploadId) {
  throw new Error("TIANCLIP_PROJECT_ID and TIANCLIP_UPLOAD_ID are required");
}

const configuredKeys = JSON.parse(process.env.INTERNAL_API_KEYS ?? "{}");
const secret = process.env.PROCESSOR_API_SECRET?.trim() ?? configuredKeys[keyId];
if (typeof secret !== "string" || secret.length < 32) {
  throw new Error(`Missing internal API secret for key ${keyId}`);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function signedHeaders(method, path, body) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = randomBytes(18).toString("base64url");
  const digest = createHash("sha256")
    .update(body === undefined ? "" : canonicalJson(body))
    .digest("hex");
  const canonical = [
    "tianclip-v2",
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    digest,
    actor,
  ].join("\n");
  return {
    "content-type": "application/json",
    "idempotency-key": `retry-${randomUUID()}`,
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

const path = `/v1/projects/${projectId}/jobs`;
const body = { uploadId };
const response = await fetch(`${apiBase}${path}`, {
  method: "POST",
  headers: signedHeaders("POST", path, body),
  body: canonicalJson(body),
  signal: AbortSignal.timeout(120_000),
});
const raw = await response.text();
if (!response.ok) {
  throw new Error(`Job creation failed HTTP ${response.status}: ${raw}`);
}
const payload = JSON.parse(raw);
process.stdout.write(`${JSON.stringify({
  projectId,
  uploadId,
  jobId: payload.job?.id ?? null,
  status: payload.job?.status ?? null,
})}\n`);
