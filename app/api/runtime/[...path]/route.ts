import { env } from "cloudflare:workers";

const REQUEST_TIMEOUT_MS = 30_000;
const MULTIPART_COMPLETE_TIMEOUT_MS = 120_000;

type ProcessorEnv = {
  PROCESSOR_API_URL?: string;
  PROCESSOR_KEY_ID?: string;
  PROCESSOR_API_SECRET?: string;
};

const TRUSTED_ACTOR_HEADER = "x-tianclip-authenticated-actor";
const SIGNED_ACTOR_HEADER = "x-tianclip-actor";

function processorConfig() {
  const runtimeEnv = env as unknown as ProcessorEnv;
  const baseUrl = runtimeEnv.PROCESSOR_API_URL?.trim().replace(/\/+$/, "");
  const keyId = runtimeEnv.PROCESSOR_KEY_ID?.trim();
  const secret = runtimeEnv.PROCESSOR_API_SECRET?.trim();

  if (!baseUrl || !keyId || !secret) {
    throw new Error(
      "真实分析服务尚未配置。需要 PROCESSOR_API_URL、PROCESSOR_KEY_ID 和 PROCESSOR_API_SECRET。",
    );
  }
  if (secret.length < 32) throw new Error("PROCESSOR_API_SECRET 长度不能少于 32 个字符。");

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("PROCESSOR_API_URL 不是有效网址。");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("PROCESSOR_API_URL 必须使用 HTTPS。");
  }

  return { baseUrl, keyId, secret };
}

function safePath(parts: string[]) {
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("无效的处理服务路径。");
  }
  return parts.map(encodeURIComponent).join("/");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function signedHeaders(options: {
  keyId: string;
  secret: string;
  actor: string;
  method: string;
  pathWithQuery: string;
  body: unknown;
}): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonceBytes = crypto.getRandomValues(new Uint8Array(24));
  const nonce = Array.from(nonceBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const contentSha256 = await sha256(
    options.body === undefined || options.body === null ? "" : canonicalJson(options.body),
  );
  const canonical = [
    "tianclip-v2",
    options.method.toUpperCase(),
    options.pathWithQuery,
    timestamp,
    nonce,
    contentSha256,
    options.actor,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = hex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)),
  );
  return {
    "x-tianclip-key-id": options.keyId,
    "x-tianclip-timestamp": timestamp,
    "x-tianclip-nonce": nonce,
    "x-tianclip-content-sha256": contentSha256,
    [SIGNED_ACTOR_HEADER]: options.actor,
    "x-tianclip-signature": signature,
  };
}

function trustedActor(request: Request): string {
  const actor = request.headers.get(TRUSTED_ACTOR_HEADER);
  if (
    !actor
    || actor !== actor.trim()
    || actor.length > 64
    || /[\u0000-\u001f\u007f]/.test(actor)
  ) {
    throw new Error("登录账号没有安全传递到处理服务。");
  }
  return actor;
}

async function forward(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const { baseUrl, keyId, secret } = processorConfig();
    const actor = trustedActor(request);
    const { path } = await context.params;
    const target = new URL(`/v1/${safePath(path)}`, `${baseUrl}/`);
    const incomingUrl = new URL(request.url);
    target.search = incomingUrl.search;

    const headers = new Headers({
      accept: "application/json",
      "x-tianclip-client": "tianzong-workbench",
    });
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    let body: string | undefined;
    let parsedBody: unknown;
    if (hasBody) {
      const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("application/json")) {
        return Response.json({ error: "请求格式必须为 JSON。" }, { status: 415 });
      }
      const rawBody = await request.text();
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        return Response.json({ error: "请求正文不是有效 JSON。" }, { status: 400 });
      }
      body = parsedBody === undefined ? undefined : canonicalJson(parsedBody);
      headers.set("content-type", "application/json");
    }
    if (request.method === "POST") {
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (!idempotencyKey) {
        return Response.json(
          { error: "该操作缺少 Idempotency-Key，未向处理服务发起请求。" },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
      headers.set("idempotency-key", idempotencyKey);
    }
    const pathWithQuery = `${target.pathname}${target.search}`;
    const signatureHeaders = await signedHeaders({
      keyId,
      secret,
      actor,
      method: request.method,
      pathWithQuery,
      body: parsedBody,
    });
    for (const [name, value] of Object.entries(signatureHeaders)) {
      headers.set(name, value);
    }

    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(
        target.pathname.endsWith("/multipart/complete")
          ? MULTIPART_COMPLETE_TIMEOUT_MS
          : REQUEST_TIMEOUT_MS,
      ),
    });
    const responseHeaders = new Headers({
      "cache-control": "no-store",
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    });
    const requestId = response.headers.get("x-request-id");
    if (requestId) responseHeaders.set("x-request-id", requestId);
    const replayed = response.headers.get("idempotency-replayed");
    if (replayed) responseHeaders.set("idempotency-replayed", replayed);

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "真实分析服务不可用。";
    const timeout = error instanceof DOMException && error.name === "TimeoutError";
    return Response.json(
      { error: timeout ? "真实分析服务响应超时，请稍后重试。" : message },
      { status: timeout ? 504 : 503, headers: { "cache-control": "no-store" } },
    );
  }
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const DELETE = forward;
