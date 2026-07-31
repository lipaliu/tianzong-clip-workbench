const ALLOWED_PATHS = new Set([
  "/v1/audio/transcriptions",
  "/v1/models",
  "/v1/responses",
]);
const OPENAI_ORIGIN = "https://api.openai.com";
const SITES_RESPONSES_ORIGIN =
  "https://cutline-tianzong.lipaliu514.chatgpt.site/api/openai/v1/responses";

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function json(status, payload) {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const provided = request.headers
    .get("OAI-Sites-Authorization")
    ?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = env.RELAY_AUTH_TOKEN ?? "";
  if (!provided || !expected || !constantTimeEqual(provided, expected)) {
    return json(401, { error: "relay_auth_required" });
  }
  if (!ALLOWED_PATHS.has(url.pathname)) {
    return json(404, { error: "relay_path_not_allowed" });
  }
  if (!["GET", "POST"].includes(request.method)) {
    return json(405, { error: "relay_method_not_allowed" });
  }

  const upstreamUrl =
    url.pathname === "/v1/responses"
      ? new URL(SITES_RESPONSES_ORIGIN + url.search)
      : new URL(url.pathname + url.search, OPENAI_ORIGIN);
  const headers = new Headers(request.headers);
  headers.delete("OAI-Sites-Authorization");
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-proto");
  const response = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" ? undefined : request.body,
    redirect: "manual",
  });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-content-type-options", "nosniff");
  responseHeaders.delete("set-cookie");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
