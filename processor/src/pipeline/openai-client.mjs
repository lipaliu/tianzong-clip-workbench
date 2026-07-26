import { readFile } from "node:fs/promises";
import path from "node:path";
import { PipelineError, invariant } from "./errors.mjs";

const AUDIO_MIME_TYPES = new Map([
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".mp4", "audio/mp4"],
  [".mpeg", "audio/mpeg"],
  [".mpga", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".wav", "audio/wav"],
  [".webm", "audio/webm"],
]);

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("OpenAI request timed out")), timeoutMs);
  timer.unref?.();
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  return { signal: combined, clear: () => clearTimeout(timer) };
}

async function pause(milliseconds, signal) {
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    function abort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("OpenAI retry aborted"));
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function fetchWithRetry(fetchImpl, url, init, {
  maxAttempts = 3,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxAttempts) return response;
      await response.arrayBuffer().catch(() => undefined);
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0
        ? Math.min(retryAfter * 1000, 30_000)
        : Math.min(500 * 2 ** (attempt - 1), 5_000);
      await pause(waitMs, init.signal);
    } catch (error) {
      lastError = error;
      if (init.signal?.aborted || attempt === maxAttempts) throw error;
      await pause(Math.min(500 * 2 ** (attempt - 1), 5_000), init.signal);
    }
  }
  throw lastError ?? new Error("OpenAI request failed");
}

async function parseJsonResponse(response, stage) {
  const raw = await response.text();
  let payload;
  try {
    payload = raw.length ? JSON.parse(raw) : {};
  } catch (error) {
    throw new PipelineError("OpenAI returned a non-JSON response", {
      code: "OPENAI_INVALID_JSON",
      stage,
      details: { status: response.status, bodyPreview: raw.slice(0, 500) },
      cause: error,
    });
  }

  if (!response.ok) {
    throw new PipelineError(payload?.error?.message ?? `OpenAI request failed with status ${response.status}`, {
      code: "OPENAI_REQUEST_FAILED",
      stage,
      details: {
        status: response.status,
        errorType: payload?.error?.type,
        errorCode: payload?.error?.code,
      },
    });
  }
  return payload;
}

function collectResponseContent(response) {
  const items = [];
  for (const output of response?.output ?? []) {
    if (output?.type !== "message") continue;
    for (const content of output.content ?? []) {
      items.push(content);
    }
  }
  return items;
}

export function parseStructuredResponse(response) {
  invariant(response && typeof response === "object", "OpenAI response is missing", {
    code: "OPENAI_RESPONSE_MISSING",
    stage: "openai_responses",
  });
  invariant(response.status === undefined || response.status === "completed", "OpenAI response did not complete", {
    code: "OPENAI_RESPONSE_INCOMPLETE",
    stage: "openai_responses",
    details: {
      status: response.status,
      incompleteDetails: response.incomplete_details,
      error: response.error,
    },
  });

  const content = collectResponseContent(response);
  const refusal = content.find((item) => item?.type === "refusal" || item?.refusal);
  if (refusal) {
    throw new PipelineError("OpenAI refused the structured analysis request", {
      code: "OPENAI_RESPONSE_REFUSAL",
      stage: "openai_responses",
      details: { refusal: refusal.refusal },
    });
  }

  const text = typeof response.output_text === "string"
    ? response.output_text
    : content.find((item) => item?.type === "output_text" && typeof item.text === "string")?.text;
  invariant(typeof text === "string" && text.trim().length > 0, "OpenAI response contains no structured output text", {
    code: "OPENAI_OUTPUT_TEXT_MISSING",
    stage: "openai_responses",
  });

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PipelineError("OpenAI structured output is not valid JSON", {
      code: "OPENAI_STRUCTURED_OUTPUT_INVALID",
      stage: "openai_responses",
      details: { outputPreview: text.slice(0, 500) },
      cause: error,
    });
  }
}

export function createOpenAIClient({
  apiKey = process.env.OPENAI_API_KEY,
  baseUrl = "https://api.openai.com/v1",
  fetchImpl = globalThis.fetch,
  timeoutMs = 10 * 60 * 1000,
  organization = process.env.OPENAI_ORG_ID,
  project = process.env.OPENAI_PROJECT_ID,
} = {}) {
  invariant(typeof apiKey === "string" && apiKey.trim().length > 0, "OPENAI_API_KEY is required", {
    code: "OPENAI_API_KEY_MISSING",
    stage: "openai_client",
  });
  invariant(typeof fetchImpl === "function", "A fetch implementation is required", {
    code: "OPENAI_FETCH_MISSING",
    stage: "openai_client",
  });

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    ...(organization ? { "OpenAI-Organization": organization } : {}),
    ...(project ? { "OpenAI-Project": project } : {}),
  };

  return {
    async transcribeDiarized({
      filePath,
      model = "gpt-4o-transcribe-diarize",
      language = undefined,
      signal = undefined,
    } = {}) {
      invariant(typeof filePath === "string" && filePath.length > 0, "Audio file path is required", {
        code: "TRANSCRIPTION_FILE_REQUIRED",
        stage: "transcription",
      });
      invariant(model === "gpt-4o-transcribe-diarize", "Diarized transcription must use gpt-4o-transcribe-diarize", {
        code: "INVALID_DIARIZATION_MODEL",
        stage: "transcription",
        details: { model },
      });

      let bytes;
      try {
        bytes = await readFile(filePath);
      } catch (error) {
        throw new PipelineError("Audio chunk is not readable", {
          code: "TRANSCRIPTION_FILE_NOT_READABLE",
          stage: "transcription",
          details: { filePath },
          cause: error,
        });
      }
      invariant(bytes.length > 0, "Audio chunk is empty", {
        code: "TRANSCRIPTION_FILE_EMPTY",
        stage: "transcription",
        details: { filePath },
      });

      const mimeType = AUDIO_MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mimeType }), path.basename(filePath));
      form.append("model", model);
      form.append("response_format", "diarized_json");
      form.append("chunking_strategy", "auto");
      if (language) form.append("language", language);

      const timeout = withTimeout(signal, timeoutMs);
      try {
        const response = await fetchWithRetry(
          fetchImpl,
          `${normalizedBaseUrl}/audio/transcriptions`,
          {
          method: "POST",
          headers,
          body: form,
          signal: timeout.signal,
          },
        );
        return await parseJsonResponse(response, "transcription");
      } catch (error) {
        if (error instanceof PipelineError) throw error;
        throw new PipelineError("OpenAI diarized transcription request failed", {
          code: "OPENAI_TRANSCRIPTION_NETWORK_FAILED",
          stage: "transcription",
          cause: error,
        });
      } finally {
        timeout.clear();
      }
    },

    async createStructuredResponse({
      model = "gpt-5.6-sol",
      instructions,
      input,
      schema,
      schemaName,
      reasoningEffort = "medium",
      maxOutputTokens = 16000,
      safetyIdentifier = undefined,
      signal = undefined,
    } = {}) {
      invariant(typeof instructions === "string" && instructions.length > 0, "Responses instructions are required", {
        code: "OPENAI_INSTRUCTIONS_REQUIRED",
        stage: "openai_responses",
      });
      invariant(Array.isArray(input) && input.length > 0, "Responses input is required", {
        code: "OPENAI_INPUT_REQUIRED",
        stage: "openai_responses",
      });
      invariant(schema && typeof schema === "object" && typeof schemaName === "string" && schemaName.length > 0, "A named JSON schema is required", {
        code: "OPENAI_SCHEMA_REQUIRED",
        stage: "openai_responses",
      });
      invariant(model === "gpt-5.6-sol", "This quality-first pipeline only permits GPT-5.6 Sol", {
        code: "INVALID_ANALYSIS_MODEL",
        stage: "openai_responses",
        details: { model },
      });

      const body = {
        model,
        instructions,
        input,
        reasoning: { effort: reasoningEffort },
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
        ...(safetyIdentifier ? { safety_identifier: safetyIdentifier } : {}),
      };

      const timeout = withTimeout(signal, timeoutMs);
      try {
        const response = await fetchWithRetry(
          fetchImpl,
          `${normalizedBaseUrl}/responses`,
          {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: timeout.signal,
          },
        );
        const payload = await parseJsonResponse(response, "openai_responses");
        return {
          parsed: parseStructuredResponse(payload),
          responseId: payload.id ?? null,
          model: payload.model ?? model,
          usage: payload.usage ?? null,
          raw: payload,
        };
      } catch (error) {
        if (error instanceof PipelineError) throw error;
        throw new PipelineError("OpenAI structured response request failed", {
          code: "OPENAI_RESPONSES_NETWORK_FAILED",
          stage: "openai_responses",
          cause: error,
        });
      } finally {
        timeout.clear();
      }
    },
  };
}
