import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyRequest } from "fastify";
import {
  authHeaders,
  buildSignedHeaders,
  verifyInternalRequest,
} from "../auth.js";
import type { ProcessorConfig } from "../config.js";
import type { Database } from "../db.js";

const secret = "s".repeat(32);
const config = {
  internalApiKeys: new Map([["sites-proxy", secret]]),
  signatureTtlSeconds: 300,
} as unknown as ProcessorConfig;

function database(): Database {
  return {
    async query() {
      return { rowCount: 1, rows: [{ nonce: "stored" }] };
    },
  } as unknown as Database;
}

function requestWith(
  headers: Record<string, string>,
  body: unknown,
): FastifyRequest {
  const path = "/v1/candidates/11111111-1111-4111-8111-111111111111/feedback";
  return {
    body,
    headers,
    method: "POST",
    raw: { url: path },
    url: path,
  } as unknown as FastifyRequest;
}

test("the authenticated actor is bound into the internal HMAC signature", async () => {
  const body = { decision: "note", notes: "reviewed" };
  const path =
    "/v1/candidates/11111111-1111-4111-8111-111111111111/feedback";
  const headers = buildSignedHeaders({
    actor: "tianzong",
    body,
    keyId: "sites-proxy",
    method: "POST",
    nonce: "1234567890abcdef",
    pathWithQuery: path,
    secret,
  });

  const verified = await verifyInternalRequest(
    requestWith(headers, body),
    config,
    database(),
  );
  assert.deepEqual(verified, {
    actor: "tianzong",
    keyId: "sites-proxy",
  });
});

test("changing the actor header without resigning is rejected", async () => {
  const body = { decision: "note", notes: "reviewed" };
  const path =
    "/v1/candidates/11111111-1111-4111-8111-111111111111/feedback";
  const headers = buildSignedHeaders({
    actor: "tianzong",
    body,
    keyId: "sites-proxy",
    method: "POST",
    nonce: "abcdef1234567890",
    pathWithQuery: path,
    secret,
  });
  headers[authHeaders.actor] = "attacker";

  await assert.rejects(
    verifyInternalRequest(requestWith(headers, body), config, database()),
    (error: unknown) =>
      (error as { code?: string }).code === "signature_invalid",
  );
});
