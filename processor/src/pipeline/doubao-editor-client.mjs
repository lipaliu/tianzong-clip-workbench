import { PipelineError, invariant } from "./errors.mjs";
import { parseStructuredResponse } from "./openai-client.mjs";

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Doubao editor request timed out")),
    timeoutMs,
  );
  timer.unref?.();
  return {
    signal: signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function pause(milliseconds, signal) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Doubao editor retry aborted"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function requestWithRetry(fetchImpl, url, init, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      if (
        attempt === maxAttempts
        || (response.status !== 429 && response.status < 500)
      ) {
        return response;
      }
      await response.arrayBuffer().catch(() => undefined);
    } catch (error) {
      lastError = error;
      if (init.signal?.aborted || attempt === maxAttempts) throw error;
    }
    await pause(Math.min(500 * (2 ** (attempt - 1)), 5_000), init.signal);
  }
  throw lastError ?? new Error("Doubao editor request failed");
}

async function parseJsonResponse(response) {
  const raw = await response.text();
  let payload;
  try {
    payload = raw.length ? JSON.parse(raw) : {};
  } catch (error) {
    throw new PipelineError("Doubao editor returned a non-JSON response", {
      code: "DOUBAO_EDITOR_INVALID_JSON",
      stage: "doubao_editor_responses",
      details: { status: response.status },
      cause: error,
    });
  }
  if (!response.ok) {
    throw new PipelineError("Doubao editor request failed", {
      code: "DOUBAO_EDITOR_REQUEST_FAILED",
      stage: "doubao_editor_responses",
      details: {
        status: response.status,
        errorType: payload?.error?.type,
        errorCode: payload?.error?.code,
      },
    });
  }
  return payload;
}

/**
 * Ark Responses adapter implementing the same structured-response contract
 * used by the Tianzong candidate engine. The private Skill and evidence
 * payload are therefore identical across the OpenAI and Doubao editors.
 */
export function createDoubaoEditorClient({
  apiKey = process.env.DOUBAO_ARK_API_KEY,
  baseUrl = process.env.DOUBAO_ARK_BASE_URL
    ?? "https://ark.cn-beijing.volces.com/api/v3",
  model = process.env.DOUBAO_EDITOR_MODEL
    ?? "doubao-seed-2-0-pro-260215",
  fetchImpl = globalThis.fetch,
  timeoutMs = 10 * 60 * 1_000,
} = {}) {
  invariant(
    typeof apiKey === "string" && apiKey.trim().length > 0,
    "DOUBAO_ARK_API_KEY is required",
    {
      code: "DOUBAO_EDITOR_API_KEY_MISSING",
      stage: "doubao_editor_client",
    },
  );
  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, "");
  invariant(
    normalizedBaseUrl.startsWith("https://"),
    "DOUBAO_ARK_BASE_URL must use HTTPS",
    {
      code: "DOUBAO_EDITOR_BASE_URL_UNSAFE",
      stage: "doubao_editor_client",
    },
  );

  return {
    provider: "doubao",
    model,
    async createStructuredResponse({
      instructions,
      input,
      schema,
      schemaName,
      maxOutputTokens = 16_000,
      signal = undefined,
    } = {}) {
      invariant(
        typeof instructions === "string"
        && instructions.length > 0
        && Array.isArray(input)
        && input.length > 0
        && schema
        && typeof schemaName === "string",
        "Doubao editor structured request is incomplete",
        {
          code: "DOUBAO_EDITOR_REQUEST_INVALID",
          stage: "doubao_editor_responses",
        },
      );
      const timeout = withTimeout(signal, timeoutMs);
      try {
        const response = await requestWithRetry(
          fetchImpl,
          `${normalizedBaseUrl}/responses`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              instructions,
              input,
              thinking: { type: "enabled" },
              max_output_tokens: maxOutputTokens,
              store: false,
              text: {
                format: {
                  type: "json_schema",
                  name: schemaName,
                  strict: true,
                  schema,
                },
              },
            }),
            signal: timeout.signal,
          },
        );
        const payload = await parseJsonResponse(response);
        return {
          parsed: parseStructuredResponse(payload),
          responseId: payload.id ?? null,
          model: payload.model ?? model,
          usage: payload.usage ?? null,
          raw: payload,
          provider: "doubao",
        };
      } catch (error) {
        if (error instanceof PipelineError) throw error;
        throw new PipelineError("Doubao editor request failed", {
          code: "DOUBAO_EDITOR_NETWORK_FAILED",
          stage: "doubao_editor_responses",
          cause: error,
        });
      } finally {
        timeout.clear();
      }
    },
  };
}
