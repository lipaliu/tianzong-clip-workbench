import { PipelineError, invariant } from "./errors.mjs";

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Kimi editor timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  const abort = () => controller.abort(signal?.reason ?? new Error("Kimi editor request aborted"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
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
      if (attempt === maxAttempts || (response.status !== 429 && response.status < 500)) {
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
      details: { status: response.status, bodyPreview: raw.slice(0, 500) },
      cause: error,
    });
  }
  if (!response.ok) {
    throw new PipelineError(
      payload?.error?.message ?? "Kimi editor request failed",
      {
        code: "KIMI_EDITOR_REQUEST_FAILED",
        stage: "kimi_editor_chat_completions",
        details: {
          status: response.status,
          errorType: payload?.error?.type,
          errorCode: payload?.error?.code,
        },
      },
    );
  }
  return payload;
}

function toKimiContent(content) {
  if (typeof content === "string") return content;
  invariant(Array.isArray(content), "Kimi editor input content must be text or an array", {
    code: "KIMI_EDITOR_INPUT_INVALID",
    stage: "kimi_editor_chat_completions",
  });
  return content.map((item) => {
    invariant(item && typeof item === "object", "Kimi editor input item is invalid", {
      code: "KIMI_EDITOR_INPUT_INVALID",
      stage: "kimi_editor_chat_completions",
    });
    if (item.type === "input_text") {
      invariant(typeof item.text === "string", "Kimi editor text evidence is invalid", {
        code: "KIMI_EDITOR_INPUT_INVALID",
        stage: "kimi_editor_chat_completions",
      });
      return { type: "text", text: item.text };
    }
    if (item.type === "input_image") {
      invariant(typeof item.image_url === "string" && item.image_url.length > 0, "Kimi editor image evidence is invalid", {
        code: "KIMI_EDITOR_INPUT_INVALID",
        stage: "kimi_editor_chat_completions",
      });
      return { type: "image_url", image_url: { url: item.image_url } };
    }
    throw new PipelineError("Kimi editor received an unsupported evidence type", {
      code: "KIMI_EDITOR_INPUT_UNSUPPORTED",
      stage: "kimi_editor_chat_completions",
      details: { type: item.type ?? null },
    });
  });
}

function toKimiMessages(instructions, input) {
  invariant(Array.isArray(input) && input.length > 0, "Kimi editor input is required", {
    code: "KIMI_EDITOR_REQUEST_INVALID",
    stage: "kimi_editor_chat_completions",
  });
  const messages = [{ role: "system", content: instructions }];
  for (const message of input) {
    invariant(
      message
      && typeof message === "object"
      && typeof message.role === "string",
      "Kimi editor input message is invalid",
      {
        code: "KIMI_EDITOR_INPUT_INVALID",
        stage: "kimi_editor_chat_completions",
      },
    );
    invariant(
      ["user", "assistant", "system"].includes(message.role),
      "Kimi editor input message role is unsupported",
      {
        code: "KIMI_EDITOR_INPUT_UNSUPPORTED",
        stage: "kimi_editor_chat_completions",
        details: { role: message.role },
      },
    );
    messages.push({
      role: message.role,
      content: toKimiContent(message.content),
    });
  }
  return messages;
}

function parseStructuredResponse(payload) {
  const choice = payload?.choices?.[0];
  invariant(choice && typeof choice === "object", "Kimi editor response has no completion choice", {
    code: "KIMI_EDITOR_RESPONSE_INCOMPLETE",
    stage: "kimi_editor_chat_completions",
  });
  if (choice.finish_reason === "length") {
    throw new PipelineError("Kimi editor structured output was truncated", {
      code: "KIMI_EDITOR_RESPONSE_INCOMPLETE",
      stage: "kimi_editor_chat_completions",
      details: { finishReason: choice.finish_reason },
    });
  }
  const text = choice?.message?.content;
  invariant(typeof text === "string" && text.length > 0, "Kimi editor structured output is missing", {
    code: "KIMI_EDITOR_OUTPUT_TEXT_MISSING",
    stage: "kimi_editor_chat_completions",
  });
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PipelineError("Kimi editor structured output is not valid JSON", {
      code: "KIMI_EDITOR_STRUCTURED_OUTPUT_INVALID",
      stage: "kimi_editor_chat_completions",
      details: { outputPreview: text.slice(0, 500) },
      cause: error,
    });
  }
}

/**
 * Kimi K3 uses the OpenAI-compatible Chat Completions endpoint. This adapter
 * converts the existing Responses-style evidence payload into Kimi messages,
 * while keeping the exact same private Skill, JSON Schema and local validator.
 */
export function createKimiEditorClient({
  apiKey = process.env.KIMI_API_KEY,
  baseUrl = process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai/v1",
  model = process.env.KIMI_EDITOR_MODEL ?? "kimi-k3",
  reasoningEffort = process.env.KIMI_REASONING_EFFORT ?? "high",
  fetchImpl = globalThis.fetch,
  timeoutMs = 10 * 60 * 1_000,
} = {}) {
  invariant(typeof apiKey === "string" && apiKey.trim().length > 0, "KIMI_API_KEY is required", {
    code: "KIMI_EDITOR_API_KEY_MISSING",
    stage: "kimi_editor_client",
  });
  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, "");
  invariant(normalizedBaseUrl.startsWith("https://"), "KIMI_BASE_URL must use HTTPS", {
    code: "KIMI_EDITOR_BASE_URL_UNSAFE",
    stage: "kimi_editor_client",
  });
  invariant(model === "kimi-k3", "This Tianzong trial only permits Kimi K3", {
    code: "KIMI_EDITOR_MODEL_INVALID",
    stage: "kimi_editor_client",
    details: { model },
  });
  invariant(["low", "high", "max"].includes(reasoningEffort), "KIMI_REASONING_EFFORT is invalid", {
    code: "KIMI_EDITOR_REASONING_EFFORT_INVALID",
    stage: "kimi_editor_client",
    details: { reasoningEffort },
  });

  return {
    provider: "kimi",
    model,
    async createStructuredResponse({
      instructions,
      input,
      schema,
      schemaName,
      reasoningEffort: requestedReasoningEffort = reasoningEffort,
      maxOutputTokens = 16_000,
      signal = undefined,
    } = {}) {
      invariant(
        typeof instructions === "string"
        && instructions.length > 0
        && schema
        && typeof schema === "object"
        && typeof schemaName === "string"
        && schemaName.length > 0,
        "Kimi editor structured request is incomplete",
        {
          code: "KIMI_EDITOR_REQUEST_INVALID",
          stage: "kimi_editor_chat_completions",
        },
      );
      invariant(["low", "high", "max"].includes(requestedReasoningEffort), "Kimi reasoning effort is invalid", {
        code: "KIMI_EDITOR_REASONING_EFFORT_INVALID",
        stage: "kimi_editor_chat_completions",
        details: { reasoningEffort: requestedReasoningEffort },
      });
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
              reasoning_effort: requestedReasoningEffort,
              max_completion_tokens: maxOutputTokens,
              messages: toKimiMessages(instructions, input),
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
          parsed: parseStructuredResponse(payload),
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
