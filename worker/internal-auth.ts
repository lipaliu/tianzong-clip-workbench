const SESSION_COOKIE = "tianzong_internal_session";
const LEGACY_SESSION_TTL_SECONDS = 12 * 60 * 60;
// Chromium caps persistent cookies at roughly 400 days. The signed session
// itself has no idle expiry and this browser lifetime is renewed on every
// authenticated request. Logout, credential removal, or secret rotation still
// revokes access.
const PERSISTENT_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

const encoder = new TextEncoder();

export interface InternalAuthEnv {
  DB: D1Database;
  INTERNAL_AUTH_CREDENTIALS?: string;
  INTERNAL_AUTH_SESSION_SECRET?: string;
}

type SessionPayload = {
  iat: number;
  u: string;
  v: 2;
};

type LoginAttemptRow = {
  blocked_until: number | null;
  failure_count: number;
  window_started_at: number;
};

type LoginRateLimit = {
  allowed: boolean;
  keys: string[];
  retryAfter: number;
};

function parseCredentials(env: InternalAuthEnv): Map<string, string> {
  const raw = env.INTERNAL_AUTH_CREDENTIALS;
  if (!raw) return new Map();

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return new Map();

    const credentials = new Map<string, string>();
    for (const [username, password] of Object.entries(parsed)) {
      const normalizedUsername = username.trim().toLowerCase();
      if (
        normalizedUsername &&
        normalizedUsername.length <= 64 &&
        typeof password === "string" &&
        password.length >= 8 &&
        password.length <= 256
      ) {
        credentials.set(normalizedUsername, password);
      }
    }
    return credentials;
  } catch {
    return new Map();
  }
}

function sessionSecret(env: InternalAuthEnv): string | null {
  const secret = env.INTERNAL_AUTH_SESSION_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signValue(value: string, secret: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return new Uint8Array(signature);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function textToBase64Url(value: string): string {
  return bytesToBase64Url(encoder.encode(value));
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function base64UrlToText(value: string): string | null {
  const bytes = base64UrlToBytes(value);
  if (!bytes) return null;
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) return valueParts.join("=") || null;
  }
  return null;
}

export function authIsConfigured(env: InternalAuthEnv): boolean {
  return parseCredentials(env).size > 0 && sessionSecret(env) !== null;
}

export async function authenticateCredentials(
  env: InternalAuthEnv,
  username: string,
  password: string,
): Promise<string | null> {
  const normalizedUsername = username.trim().toLowerCase();
  const expectedPassword = parseCredentials(env).get(normalizedUsername);
  if (!expectedPassword) {
    await secureEqual(password, "invalid-credential-placeholder");
    return null;
  }
  return (await secureEqual(password, expectedPassword)) ? normalizedUsername : null;
}

export async function createSessionToken(
  env: InternalAuthEnv,
  username: string,
): Promise<string | null> {
  const secret = sessionSecret(env);
  if (!secret) return null;

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    iat: issuedAt,
    u: username,
    v: 2,
  };
  const encodedPayload = textToBase64Url(JSON.stringify(payload));
  const signature = await signValue(encodedPayload, secret);
  return `${encodedPayload}.${bytesToBase64Url(signature)}`;
}

export async function sessionUsername(
  request: Request,
  env: InternalAuthEnv,
): Promise<string | null> {
  const secret = sessionSecret(env);
  const token = readCookie(request, SESSION_COOKIE);
  if (!secret || !token) return null;

  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra) return null;
  const signature = base64UrlToBytes(encodedSignature);
  if (!signature) return null;

  const key = await hmacKey(secret);
  const validSignature = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(encodedPayload),
  );
  if (!validSignature) return null;

  const decodedPayload = base64UrlToText(encodedPayload);
  if (!decodedPayload) return null;

  try {
    const payload = JSON.parse(decodedPayload) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof payload.u !== "string" ||
      typeof payload.iat !== "number" ||
      payload.iat > now + 60
    ) {
      return null;
    }

    if (payload.v === 1) {
      if (
        typeof payload.exp !== "number" ||
        payload.exp <= now ||
        payload.exp - payload.iat > LEGACY_SESSION_TTL_SECONDS
      ) {
        return null;
      }
    } else if (payload.v !== 2) {
      return null;
    }
    return parseCredentials(env).has(payload.u) ? payload.u : null;
  } catch {
    return null;
  }
}

function requestIsSecure(request: Request): boolean {
  return (
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https"
  );
}

export function sessionCookie(request: Request, token: string): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    requestIsSecure(request) ? "Secure" : "",
    `Max-Age=${PERSISTENT_COOKIE_MAX_AGE_SECONDS}`,
  ].filter(Boolean).join("; ");
}

export function expiredSessionCookie(request: Request): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    requestIsSecure(request) ? "Secure" : "",
    "Max-Age=0",
  ].filter(Boolean).join("; ");
}

async function loginAttemptKeys(
  request: Request,
  env: InternalAuthEnv,
  username: string,
): Promise<string[]> {
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const secret = sessionSecret(env);
  if (!secret) throw new Error("Internal authentication is not configured.");

  const normalizedUsername = username.trim().toLowerCase();
  const accountBucket = parseCredentials(env).has(normalizedUsername)
    ? normalizedUsername
    : "__unknown_account__";
  const [ipDigest, accountDigest] = await Promise.all([
    signValue(`ip:${ip}`, secret),
    signValue(`account:${accountBucket}`, secret),
  ]);

  return [
    `ip:${bytesToBase64Url(ipDigest.slice(0, 18))}`,
    `account:${bytesToBase64Url(accountDigest.slice(0, 18))}`,
  ];
}

async function cleanupStaleLoginAttempts(env: InternalAuthEnv, now: number): Promise<void> {
  const cleanupBefore = now - 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    `DELETE FROM auth_login_attempts
     WHERE key IN (
       SELECT key FROM auth_login_attempts
       WHERE updated_at < ?
       ORDER BY updated_at ASC
       LIMIT 100
     )`,
  ).bind(cleanupBefore).run();
}

export async function reserveLoginAttempt(
  request: Request,
  env: InternalAuthEnv,
  username: string,
): Promise<LoginRateLimit> {
  const keys = await loginAttemptKeys(request, env, username);
  const now = Date.now();
  await cleanupStaleLoginAttempts(env, now);

  for (const key of keys) {
    const row = await env.DB.prepare(
      `INSERT INTO auth_login_attempts (key, window_started_at, failure_count, blocked_until, updated_at)
       VALUES (?, ?, 1, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET
         window_started_at = CASE
           WHEN auth_login_attempts.blocked_until IS NOT NULL
             AND auth_login_attempts.blocked_until > excluded.updated_at
             THEN auth_login_attempts.window_started_at
           WHEN excluded.updated_at - auth_login_attempts.window_started_at >= ?
             THEN excluded.updated_at
           ELSE auth_login_attempts.window_started_at
         END,
         failure_count = CASE
           WHEN auth_login_attempts.blocked_until IS NOT NULL
             AND auth_login_attempts.blocked_until > excluded.updated_at
             THEN auth_login_attempts.failure_count
           WHEN excluded.updated_at - auth_login_attempts.window_started_at >= ?
             THEN 1
           WHEN auth_login_attempts.failure_count >= ?
             THEN auth_login_attempts.failure_count
           ELSE auth_login_attempts.failure_count + 1
         END,
         blocked_until = CASE
           WHEN auth_login_attempts.blocked_until IS NOT NULL
             AND auth_login_attempts.blocked_until > excluded.updated_at
             THEN auth_login_attempts.blocked_until
           WHEN excluded.updated_at - auth_login_attempts.window_started_at >= ?
             THEN NULL
           WHEN auth_login_attempts.failure_count >= ?
             THEN excluded.updated_at + ?
           ELSE NULL
         END,
         updated_at = excluded.updated_at
       RETURNING window_started_at, failure_count, blocked_until`,
    ).bind(
      key,
      now,
      now,
      LOGIN_WINDOW_MS,
      LOGIN_WINDOW_MS,
      MAX_FAILURES,
      LOGIN_WINDOW_MS,
      MAX_FAILURES,
      LOGIN_BLOCK_MS,
    ).first<LoginAttemptRow>();

    if (!row) throw new Error("Unable to reserve the login attempt.");
    if (row?.blocked_until && row.blocked_until > now) {
      return {
        allowed: false,
        keys,
        retryAfter: Math.max(1, Math.ceil((row.blocked_until - now) / 1000)),
      };
    }
  }

  return { allowed: true, keys, retryAfter: 0 };
}

export async function releaseLoginAttempt(
  env: InternalAuthEnv,
  keys: string[],
): Promise<void> {
  const now = Date.now();
  for (const key of keys) {
    await env.DB.prepare(
      `UPDATE auth_login_attempts
       SET failure_count = CASE
             WHEN failure_count > 0 THEN failure_count - 1
             ELSE 0
           END,
           blocked_until = CASE
             WHEN blocked_until IS NOT NULL
               AND blocked_until > ?
               AND failure_count - 1 >= ?
               THEN blocked_until
             ELSE NULL
           END,
           updated_at = ?
       WHERE key = ?`,
    ).bind(now, MAX_FAILURES, now, key).run();
  }
}

function requestHasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get("vary");
  const values = new Set(
    (current ? current.split(",") : []).map((item) => item.trim()).filter(Boolean),
  );
  values.add(value);
  headers.set("vary", [...values].join(", "));
}

export function secureAppResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("content-security-policy", "frame-ancestors 'none'");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  appendVary(headers, "Cookie");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function secureAuthenticatedResponse(
  request: Request,
  response: Response,
  env: InternalAuthEnv,
  username: string,
): Promise<Response> {
  const secured = secureAppResponse(response);
  const token = await createSessionToken(env, username);
  if (token) {
    secured.headers.append("set-cookie", sessionCookie(request, token));
  }
  return secured;
}

function jsonResponse(
  payload: Record<string, unknown>,
  status: number,
  headers?: Record<string, string>,
): Response {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "vary": "Cookie",
      ...headers,
    },
  });
}

export async function handleLogin(
  request: Request,
  env: InternalAuthEnv,
): Promise<Response> {
  if (!authIsConfigured(env)) {
    return jsonResponse({ error: "登录服务尚未配置，请联系管理员。" }, 503);
  }

  if (!requestHasSameOrigin(request)) {
    return jsonResponse({ error: "请求来源无效。" }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "请求格式无效。" }, 415);
  }

  let payload: { password?: unknown; username?: unknown };
  try {
    const rawBody = await request.text();
    if (encoder.encode(rawBody).byteLength > 2048) {
      return jsonResponse({ error: "请求无效。" }, 413);
    }
    payload = JSON.parse(rawBody) as { password?: unknown; username?: unknown };
  } catch {
    return jsonResponse({ error: "请求无效。" }, 400);
  }

  const username = typeof payload.username === "string" ? payload.username : "";
  const password = typeof payload.password === "string" ? payload.password : "";
  if (!username || username.length > 64 || !password || password.length > 256) {
    return jsonResponse({ error: "用户名或密码错误。" }, 401);
  }

  let rateLimit: LoginRateLimit;
  try {
    rateLimit = await reserveLoginAttempt(request, env, username);
  } catch {
    return jsonResponse({ error: "登录服务暂不可用，请稍后再试。" }, 503);
  }
  if (!rateLimit.allowed) {
    return jsonResponse(
      { error: "尝试次数过多，请稍后再试。" },
      429,
      { "retry-after": String(rateLimit.retryAfter) },
    );
  }

  const authenticatedUsername = await authenticateCredentials(env, username, password);
  if (!authenticatedUsername) {
    return jsonResponse({ error: "用户名或密码错误。" }, 401);
  }

  try {
    await releaseLoginAttempt(env, rateLimit.keys);
  } catch {
    return jsonResponse({ error: "登录服务暂不可用，请稍后再试。" }, 503);
  }

  const token = await createSessionToken(env, authenticatedUsername);
  if (!token) return jsonResponse({ error: "登录服务暂不可用。" }, 503);

  return jsonResponse(
    { ok: true },
    200,
    { "set-cookie": sessionCookie(request, token) },
  );
}

export function handleLogout(request: Request): Response {
  if (!requestHasSameOrigin(request)) {
    return jsonResponse({ error: "请求来源无效。" }, 403);
  }
  return jsonResponse(
    { ok: true },
    200,
    { "set-cookie": expiredSessionCookie(request) },
  );
}

function randomNonce(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export function loginPage(): Response {
  const nonce = randomNonce();
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow,noarchive" />
  <title>登录 · 天总直播切片系统</title>
  <style>
    :root { color-scheme: light; --ink:#282426; --muted:#81777b; --pink:#d889a8; --line:#eadde2; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; padding:28px; color:var(--ink); background:radial-gradient(circle at 22% 12%,#fff 0 14%,transparent 35%),linear-gradient(145deg,#f8f4f5 0%,#f2e7ec 48%,#faf8f8 100%); font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
    .shell { width:min(100%,440px); }
    .edition { margin:0 0 18px; text-align:center; color:#a47d8d; font-size:11px; letter-spacing:.2em; }
    .card { position:relative; overflow:hidden; padding:42px 40px 38px; border:1px solid rgba(255,255,255,.9); border-radius:26px; background:rgba(255,255,255,.9); box-shadow:0 24px 80px rgba(74,49,59,.13); backdrop-filter:blur(18px); }
    .card::before { content:""; position:absolute; inset:0 auto 0 0; width:5px; background:linear-gradient(#efb5cb,var(--pink)); }
    h1 { margin:0; font-family:"Songti SC","STSong",serif; font-size:34px; font-weight:400; letter-spacing:-.04em; }
    .intro { margin:10px 0 30px; color:var(--muted); font-size:14px; line-height:1.7; }
    label { display:block; margin:18px 0 8px; font-size:13px; color:#665d61; }
    input { width:100%; height:50px; border:1px solid var(--line); border-radius:14px; padding:0 15px; color:var(--ink); background:#fff; font:inherit; outline:none; transition:border-color .2s,box-shadow .2s; }
    input:focus { border-color:var(--pink); box-shadow:0 0 0 4px rgba(216,137,168,.13); }
    button { width:100%; height:50px; margin-top:24px; border:0; border-radius:999px; color:#fff; background:#2b2729; font:600 15px/1 inherit; cursor:pointer; transition:transform .2s,opacity .2s; }
    button:hover { transform:translateY(-1px); }
    button:disabled { cursor:wait; opacity:.58; transform:none; }
    .message { min-height:22px; margin:12px 2px 0; color:#b34b70; font-size:13px; line-height:1.6; }
    .private { margin:18px 0 0; text-align:center; color:#aaa0a4; font-size:11px; }
    @media (max-width:520px) { body{padding:18px}.card{padding:34px 24px 30px;border-radius:22px}h1{font-size:30px} }
  </style>
</head>
<body>
  <main class="shell">
    <p class="edition">TIANZONG · INTERNAL BETA 1.0</p>
    <section class="card" aria-labelledby="login-title">
      <h1 id="login-title">天总直播切片系统</h1>
      <p class="intro">内部工作台，请使用团队账号进入。</p>
      <form id="login-form">
        <label for="username">用户名</label>
        <input id="username" name="username" autocomplete="username" maxlength="64" required autofocus />
        <label for="password">密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required />
        <button id="submit" type="submit">进入工作台</button>
        <p class="message" id="message" role="alert" aria-live="polite"></p>
      </form>
    </section>
    <p class="private">仅供天总团队内部使用</p>
  </main>
  <script nonce="${nonce}">
    const form = document.getElementById("login-form");
    const button = document.getElementById("submit");
    const message = document.getElementById("message");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      message.textContent = "正在验证…";
      try {
        const response = await fetch("/__auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: document.getElementById("username").value,
            password: document.getElementById("password").value,
          }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "登录失败，请稍后再试。");
        window.location.replace("/");
      } catch (error) {
        message.textContent = error instanceof Error ? error.message : "登录失败，请稍后再试。";
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "vary": "Cookie",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

export function unauthorizedResponse(request: Request): Response {
  const acceptsHtml = request.headers.get("accept")?.includes("text/html");
  if ((request.method === "GET" || request.method === "HEAD") && acceptsHtml) {
    return loginPage();
  }
  return jsonResponse({ error: "请先登录。" }, 401);
}
