import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { ProcessorConfig } from "./config.js";
import { requestBodySha256 } from "./canonical.js";
import type { Database } from "./db.js";
import { AppError } from "./errors.js";

export const authHeaders = {
  keyId: "x-tianclip-key-id",
  timestamp: "x-tianclip-timestamp",
  nonce: "x-tianclip-nonce",
  contentSha256: "x-tianclip-content-sha256",
  actor: "x-tianclip-actor",
  signature: "x-tianclip-signature",
} as const;

export type VerifiedInternalRequest = {
  actor: string;
  keyId: string;
};

export function canonicalSignatureInput(input: {
  method: string;
  pathWithQuery: string;
  timestamp: string;
  nonce: string;
  contentSha256: string;
  actor: string;
}): string {
  return [
    "tianclip-v2",
    input.method.toUpperCase(),
    input.pathWithQuery,
    input.timestamp,
    input.nonce,
    input.contentSha256,
    input.actor,
  ].join("\n");
}

export function signInternalRequest(
  secret: string,
  input: {
    method: string;
    pathWithQuery: string;
    timestamp: string;
    nonce: string;
    contentSha256: string;
    actor: string;
  },
): string {
  return createHmac("sha256", secret)
    .update(canonicalSignatureInput(input))
    .digest("hex");
}

export function buildSignedHeaders(options: {
  keyId: string;
  secret: string;
  method: string;
  pathWithQuery: string;
  body?: unknown;
  actor: string;
  timestamp?: number;
  nonce?: string;
}): Record<string, string> {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1_000));
  const nonce = options.nonce ?? randomBytes(18).toString("base64url");
  const contentSha256 = requestBodySha256(options.body);
  return {
    [authHeaders.keyId]: options.keyId,
    [authHeaders.timestamp]: timestamp,
    [authHeaders.nonce]: nonce,
    [authHeaders.contentSha256]: contentSha256,
    [authHeaders.actor]: options.actor,
    [authHeaders.signature]: signInternalRequest(options.secret, {
      method: options.method,
      pathWithQuery: options.pathWithQuery,
      timestamp,
      nonce,
      contentSha256,
      actor: options.actor,
    }),
  };
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value) {
    throw new AppError(401, "signature_missing", "内部请求签名缺失。");
  }
  return value;
}

export async function verifyInternalRequest(
  request: FastifyRequest,
  config: ProcessorConfig,
  database: Database,
): Promise<VerifiedInternalRequest> {
  const keyId = requiredHeader(request, authHeaders.keyId);
  const timestamp = requiredHeader(request, authHeaders.timestamp);
  const nonce = requiredHeader(request, authHeaders.nonce);
  const contentSha256 = requiredHeader(request, authHeaders.contentSha256);
  const actor = requiredHeader(request, authHeaders.actor);
  const signature = requiredHeader(request, authHeaders.signature);
  const secret = config.internalApiKeys.get(keyId);
  if (!secret) throw new AppError(401, "signature_invalid", "内部请求签名无效。");

  if (!/^\d{10,13}$/.test(timestamp)) {
    throw new AppError(401, "signature_invalid", "内部请求签名无效。");
  }
  const timestampSeconds = Number(timestamp.length === 13 ? Number(timestamp) / 1_000 : timestamp);
  const age = Math.abs(Date.now() / 1_000 - timestampSeconds);
  if (!Number.isFinite(age) || age > config.signatureTtlSeconds) {
    throw new AppError(401, "signature_expired", "内部请求签名已过期。");
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new AppError(401, "signature_invalid", "内部请求签名无效。");
  }
  if (
    actor !== actor.trim()
    || actor.length > 64
    || /[\u0000-\u001f\u007f]/.test(actor)
  ) {
    throw new AppError(401, "signature_invalid", "内部请求签名无效。");
  }

  const actualContentSha256 = requestBodySha256(request.body);
  if (
    !/^[a-f0-9]{64}$/.test(contentSha256) ||
    !timingSafeEqual(Buffer.from(contentSha256), Buffer.from(actualContentSha256))
  ) {
    throw new AppError(401, "body_digest_mismatch", "请求正文校验失败。");
  }

  const expected = signInternalRequest(secret, {
    method: request.method,
    pathWithQuery: request.raw.url ?? request.url,
    timestamp,
    nonce,
    contentSha256,
    actor,
  });
  if (
    !/^[a-f0-9]{64}$/.test(signature) ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    throw new AppError(401, "signature_invalid", "内部请求签名无效。");
  }

  const inserted = await database.query(
    `INSERT INTO internal_request_nonces(key_id, nonce, expires_at)
     VALUES($1, $2, now() + ($3 * interval '1 second'))
     ON CONFLICT DO NOTHING
     RETURNING nonce`,
    [keyId, nonce, config.signatureTtlSeconds],
  );
  if (!inserted.rowCount) {
    throw new AppError(409, "signature_replayed", "该内部请求已经处理过。");
  }
  return { actor, keyId };
}
