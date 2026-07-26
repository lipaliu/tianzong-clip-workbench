/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  handleLogin,
  handleLogout,
  secureAppResponse,
  sessionUsername,
  unauthorizedResponse,
  type InternalAuthEnv,
} from "./internal-auth";

interface Env extends InternalAuthEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__auth/login" && request.method === "POST") {
      return handleLogin(request, env);
    }

    if (url.pathname === "/__auth/logout" && request.method === "POST") {
      return handleLogout(request);
    }

    const authenticatedUsername = await sessionUsername(request, env);
    if (!authenticatedUsername) {
      return unauthorizedResponse(request);
    }

    // This header is a private trust boundary between the outer authenticated
    // Sites Worker and the server-side runtime route. Always overwrite the
    // browser's value so a client cannot choose the feedback actor.
    const trustedHeaders = new Headers(request.headers);
    trustedHeaders.set("x-tianclip-authenticated-actor", authenticatedUsername);
    const trustedRequest = new Request(request, { headers: trustedHeaders });

    const safeMethod = request.method === "GET" || request.method === "HEAD";
    if (!safeMethod) {
      const origin = request.headers.get("origin");
      let sameOrigin = false;
      try {
        sameOrigin = Boolean(origin) && new URL(origin as string).origin === url.origin;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        return secureAppResponse(Response.json({ error: "请求来源无效。" }, { status: 403 }));
      }
      if (
        url.pathname.startsWith("/api/") &&
        !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      ) {
        return secureAppResponse(Response.json({ error: "请求格式无效。" }, { status: 415 }));
      }
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const response = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return secureAppResponse(response);
    }

    return secureAppResponse(await handler.fetch(trustedRequest, env, ctx));
  },
};

export default worker;
