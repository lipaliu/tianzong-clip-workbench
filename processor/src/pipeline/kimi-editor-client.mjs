import { PipelineError, invariant } from "./errors.mjs";

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Kimi editor request timed out")),
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
      reject(signal.reason ?? new Error("Kimi editor retry aborted"));
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
  throw lastError ?? new Error("Kimi editor request failed");
}

async function parseJsonResponse(response) {
  const raw = await response.text();
  let payload;
  try {
    payload = raw.length ? JSON.parse(raw) : {};
  } catch (error) {
    throw new PipelineError("Kimi editor returned a non-JSON response", {
      code: "KIMI_EDITOR_INVALID_JSON",
      stage: "kimi_editor_chat_completions",
      details: { status: response.status },
      cause: error,
    });
  }
  if (!response.ok) {
    throw new PipelineError("Kimi editor request failed", {
      code: "KIMI_EDITOR_REQUEST_FAILED",
      stage: "kimi_editor_chat_completions",
      details: {
        status: response.status,
        errorType: payload?.error?.type,
        errorCode: payload?.error?.code,
      },
    });
  }
  return payload;
}

function chatContentItem(item) {
  if (item?.type === "input_text" || item?.type === "text") {
    invariant(typeof item.text === "string", "Kimi text input is invalid", {
      code: "KIMI_EDITOR_INPUT_INVALID",
      stage: "kimi_editor_client",
    });
    return { type: "text", text: item.text };
  }
  if (item?.type === "input_image" || item?.type === "image_url") {
    const url = item.image_url?.url ?? item.image_url;
    invariant(typeof url === "string" && url.length > 0, "Kimi image input is invalid", {
      code: "KIMI_EDITOR_INPUT_INVALID",
      stage: "kimi_editor_client",
    });
    return {
      type: "image_url",
      image_url: { url },
    };
  }
  throw new PipelineError("Kimi editor received an unsupported input type", {
    code: "KIMI_EDITOR_INPUT_UNSUPPORTED",
    stage: "kimi_editor_client",
    details: { type: item?.type ?? null },
  });
}

function chatMessage(item) {
  const role = item?.role === "assistant" ? "assistant" : "user";
  if (typeof item?.content === "string") {
    return { role, content: item.content };
  }
  invariant(Array.isArray(item?.content), "Kimi message content is invalid", {
    code: "KIMI_EDITOR_INPUT_INVALID",
    stage: "kimi_editor_client",
  });
  return { role, content: item.content.map(chatContentItem) };
}

function extractStructuredContent(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  invariant(
    typeof content === "string" && content.trim().length > 0,
    "Kimi editor response has no structured content",
    {
      code: "KIMI_EDITOR_OUTPUT_TEXT_MISSING",
      stage: "kimi_editor_chat_completions",
      details: { finishReason: choice?.finish_reason ?? null },
    },
  );
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new PipelineError("Kimi editor returned invalid structured output", {
      code: "KIMI_EDITOR_STRUCTURED_OUTPUT_INVALID",
      stage: "kimi_editor_chat_completions",
      details: { finishReason: choice?.finish_reason ?? null },
      cause: error,
    });
  }
}

/**
 * Kimi K3 Chat Completions adapter implementing the same structured-response
 * contract as the OpenAI and Doubao editors. It receives the exact same
 * private Tianzong Skill and evidence instead of a shortened provider prompt.
 */
export function createKimiEditorClient({
  apiKey = process.env.KIMI_API_KEY,
  baseUrl = process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai/v1",
  model = process.env.KIMI_EDITOR_MODEL ?? "kimi-k3",
  reasoningEffort = process.env.KIMI_REASONING_EFFORT ?? "max",
  fetchImpl = globalThis.fetch,
  timeoutMs = 10 * 60 * 1_000,
} = {}) {
  invariant(
    typeof apiKey === "string" && apiKey.trim().length > 0,
    "KIMI_API_KEY is required",
    {
      code: "KIMI_EDITOR_API_KEY_MISSING",
      stage: "kimi_editor_client",
    },
  );
  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, "");
  invariant(
    normalizedBaseUrl.startsWith("https://"),
    "KIMI_BASE_URL must use HTTPS",
    {
      code: "KIMI_EDITOR_BASE_URL_UNSAFE",
      stage: "kimi_editor_client",
    },
  );
  invariant(
    ["low", "high", "max"].includes(reasoningEffort),
    "KIMI_REASONING_EFFORT must be low, high, or max",
    {
      code: "KIMI_EDITOR_REASONING_EFFORT_INVALID",
      stage: "kimi_editor_client",
    },
  );

  return {
    provider: "kimi",
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
        "Kimi editor structured request is incomplete",
        {
          code: "KIMI_EDITOR_REQUEST_INVALID",
          stage: "kimi_editor_chat_completions",
        },
      );
      const timeout = withTimeout(signal, timeoutMs);
      try {
        const response = await requestWithRetry(
          fetchImpl,
          `${normalizedBaseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: instructions },
                ...input.map(chatMessage),
              ],
              reasoning_effort: reasoningEffort,
              max_completion_tokens: maxOutputTokens,
              response_format: {
                type: "json_schema",
                json_schema: {
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
          parsed: extractStructuredContent(payload),
          responseId: payload.id ?? null,
          model: payload.model ?? model,
          usage: payload.usage ?? null,
          raw: payload,
          provider: "kimi",
        };
      } catch (error) {
        if (error instanceof PipelineError) throw error;
        throw new PipelineError("Kimi editor request failed", {
          code: "KIMI_EDITOR_NETWORK_FAILED",
          stage: "kimi_editor_chat_completions",
          cause: error,
        });
      } finally {
        timeout.clear();
      }
    },
  };
}
