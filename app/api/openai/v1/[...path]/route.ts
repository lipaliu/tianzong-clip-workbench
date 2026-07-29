import { env } from "cloudflare:workers";

type RelayEnv = {
  OPENAI_API_KEY?: string;
};

const ALLOWED_PATHS = new Set(["responses"]);
const OPENAI_ORIGIN = "https://api.openai.com/v1";
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;

async function relay(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const configuredKey = (env as unknown as RelayEnv).OPENAI_API_KEY?.trim();
  if (!configuredKey) {
    return Response.json({ error: "OpenAI 中继尚未配置。" }, { status: 503 });
  }

  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${configuredKey}`) {
    return Response.json({ error: "未授权的模型请求。" }, { status: 401 });
  }

  const { path } = await context.params;
  const safePath = path.join("/");
  if (!ALLOWED_PATHS.has(safePath)) {
    return Response.json({ error: "该 OpenAI 路径未开放。" }, { status: 404 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "模型请求过大。" }, { status: 413 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "模型请求过大。" }, { status: 413 });
  }

  const headers = new Headers({
    authorization: `Bearer ${configuredKey}`,
    "content-type": request.headers.get("content-type") ?? "application/json",
    accept: request.headers.get("accept") ?? "application/json",
  });
  const clientRequestId = request.headers.get("x-client-request-id");
  if (clientRequestId) headers.set("x-client-request-id", clientRequestId);

  try {
    const upstream = await fetch(`${OPENAI_ORIGIN}/${safePath}`, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(300_000),
    });
    const responseHeaders = new Headers({
      "cache-control": "no-store",
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    for (const name of ["x-request-id", "openai-processing-ms"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return Response.json({ error: "OpenAI 中继暂时不可用。" }, { status: 502 });
  }
}

export const POST = relay;
