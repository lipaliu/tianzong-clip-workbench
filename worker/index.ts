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
  /** Server-only processor settings. These must be configured as Worker vars/secrets. */
  PROCESSOR_API_URL?: string;
  PROCESSOR_KEY_ID?: string;
  PROCESSOR_API_SECRET?: string;
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

    // Built client bundles and the curated workbench images are stored in the
    // static ASSETS binding. They are still session-gated above, but must not
    // be sent through the dynamic vinext router (which returns 404 for them).
    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/photos/")) {
      return secureAppResponse(await env.ASSETS.fetch(request));
    }

    // This header is a private trust boundary between the outer authenticated
    // Sites Worker and the server-side runtime route. Always overwrite the
    // browser's value so a client cannot choose the feedback actor.
    const trustedHeaders = new Headers(request.headers);
    trustedHeaders.set("x-tianclip-authenticated-actor", authenticatedUsername);

    // The outer Worker receives bindings on every request. Forward the
    // server-only values only to the inner app-router request, after
    // overwriting every client-supplied value. This avoids relying on a
    // module-level runtime binding import inside Git-built Worker versions.
    trustedHeaders.set("x-tianclip-processor-api-url", env.PROCESSOR_API_URL ?? "");
    trustedHeaders.set("x-tianclip-processor-key-id", env.PROCESSOR_KEY_ID ?? "");
    trustedHeaders.set("x-tianclip-processor-api-secret", env.PROCESSOR_API_SECRET ?? "");
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
