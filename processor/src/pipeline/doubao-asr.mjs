import { randomUUID } from "node:crypto";
import { PipelineError, invariant } from "./errors.mjs";

const COMPLETED_STATUS = "20000000";
const PENDING_STATUSES = new Map([
  ["20000001", "queued"],
  ["20000002", "processing"],
]);

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function roundMillis(value) {
  return Math.round(value * 1000) / 1000;
}

function headerValue(headers, name) {
  if (headers && typeof headers.get === "function") {
    return headers.get(name);
  }
  if (!headers || typeof headers !== "object") return null;
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry ? String(entry[1]) : null;
}

function createRedactor(values) {
  const secrets = values
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);

  return (value) => {
    let output = String(value ?? "");
    for (const secret of secrets) {
      output = output.split(secret).join("[REDACTED]");
    }
    return output
      .replace(
        /(x-api-(?:key|access-key|app-key))(["']?\s*[:=]\s*["']?)[^"',;\s}]+/gi,
        "$1$2[REDACTED]",
      )
      .slice(0, 500);
  };
}

function createRequestTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error("Doubao ASR request timed out"));
  }, timeoutMs);
  timer.unref?.();
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  return {
    signal: combinedSignal,
    didTimeOut: () => didTimeOut,
    clear: () => clearTimeout(timer),
  };
}

async function defaultSleep(milliseconds, signal) {
  await new Promise((resolve, reject) => {
    let timer;
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Doubao ASR polling aborted"));
    };

    if (signal?.aborted) {
      abort();
      return;
    }
    timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function assertNotAborted(signal, stage) {
  if (!signal?.aborted) return;
  throw new PipelineError("Doubao ASR operation was aborted", {
    code: "DOUBAO_ASR_ABORTED",
    stage,
  });
}

function safeCause(error, redact) {
  return new Error(redact(error instanceof Error ? error.message : error));
}

async function parseJsonBody(response, {
  stage,
  redact,
} = {}) {
  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    throw new PipelineError("Could not read the Doubao ASR response", {
      code: "DOUBAO_ASR_RESPONSE_READ_FAILED",
      stage,
      cause: safeCause(error, redact),
    });
  }

  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new PipelineError("Doubao ASR returned invalid JSON", {
      code: "DOUBAO_ASR_INVALID_JSON",
      stage,
      details: { httpStatus: response.status },
      cause: safeCause(error, redact),
    });
  }
}

function normalizeSpeaker(utterance) {
  const rawSpeaker = utterance?.additions?.speaker
    ?? utterance?.speaker
    ?? utterance?.speaker_id
    ?? utterance?.channel_id;
  const speaker = normalizeText(rawSpeaker);
  if (!speaker) return "speaker_0";
  if (/^\d+$/.test(speaker)) return `speaker_${speaker}`;
  return speaker;
}

function resolveDurationSec(raw, explicitDurationSec, lastSegmentEndSec) {
  if (Number.isFinite(explicitDurationSec) && explicitDurationSec > 0) {
    return roundMillis(explicitDurationSec);
  }
  const durationMs = Number(
    raw?.audio_info?.duration
      ?? raw?.result?.additions?.duration
      ?? raw?.resp?.duration,
  );
  if (Number.isFinite(durationMs) && durationMs > 0) {
    return roundMillis(durationMs / 1000);
  }
  return roundMillis(lastSegmentEndSec);
}

export function mergeDoubaoChunkTranscripts(
  chunkResults,
  {
    chunks,
    mediaDurationSec,
    generatedAt = new Date().toISOString(),
  } = {},
) {
  invariant(
    Array.isArray(chunkResults)
      && Array.isArray(chunks)
      && chunkResults.length === chunks.length
      && chunks.length > 0,
    "Doubao ASR chunk results do not match the chunk plan",
    {
      code: "DOUBAO_ASR_CHUNK_RESULTS_INVALID",
      stage: "doubao_asr_chunk_merge",
    },
  );
  invariant(
    Number.isFinite(mediaDurationSec) && mediaDurationSec > 0,
    "Doubao ASR chunk merge requires the source duration",
    {
      code: "DOUBAO_ASR_CHUNK_DURATION_INVALID",
      stage: "doubao_asr_chunk_merge",
    },
  );
  const segments = [];
  const chunkProvenance = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const result = chunkResults[index];
    invariant(
      result && Array.isArray(result.segments),
      "Doubao ASR chunk is missing transcript segments",
      {
        code: "DOUBAO_ASR_CHUNK_TRANSCRIPT_MISSING",
        stage: "doubao_asr_chunk_merge",
        details: { chunkId: chunk?.id },
      },
    );
    for (const segment of result.segments) {
      const localStartSec = Number(
        segment.localStartSec ?? segment.startSec,
      );
      const localEndSec = Number(
        segment.localEndSec ?? segment.endSec,
      );
      const startSec = roundMillis(chunk.startSec + localStartSec);
      const endSec = roundMillis(chunk.startSec + localEndSec);
      const midpointSec = (startSec + endSec) / 2;
      const ownsMidpoint =
        midpointSec >= chunk.ownershipStartSec - 0.001
        && (
          index === chunks.length - 1
            ? midpointSec <= chunk.ownershipEndSec + 0.001
            : midpointSec < chunk.ownershipEndSec - 0.001
        );
      if (!ownsMidpoint) continue;
      invariant(
        startSec >= -0.001
          && endSec >= startSec
          && endSec <= mediaDurationSec + 0.5,
        "Merged Doubao ASR segment falls outside the source timeline",
        {
          code: "DOUBAO_ASR_CHUNK_SEGMENT_OUTSIDE_MEDIA",
          stage: "doubao_asr_chunk_merge",
          details: { chunkId: chunk.id, segmentId: segment.id },
        },
      );
      segments.push({
        ...segment,
        id: `tx_${chunk.id}_${String(segments.length + 1).padStart(6, "0")}`,
        chunkId: chunk.id,
        localStartSec,
        localEndSec,
        startSec,
        endSec,
      });
    }
    chunkProvenance.push({
      chunkId: chunk.id,
      startSec: chunk.startSec,
      endSec: chunk.endSec,
      ownershipStartSec: chunk.ownershipStartSec,
      ownershipEndSec: chunk.ownershipEndSec,
      providerTaskId: result.provenance?.taskId ?? null,
      segmentCount: result.segments.length,
    });
  }
  segments.sort(
    (left, right) =>
      left.startSec - right.startSec || left.endSec - right.endSec,
  );
  invariant(segments.length > 0, "Merged Doubao ASR transcript is empty", {
    code: "DOUBAO_ASR_CHUNK_MERGE_EMPTY",
    stage: "doubao_asr_chunk_merge",
  });
  return {
    provider: "doubao",
    model: chunkResults[0].model ?? "doubao-bigasr-2.0",
    mediaDurationSec: roundMillis(mediaDurationSec),
    segments,
    text: segments.map((segment) => segment.text).join("\n"),
    speakerLabels: [...new Set(segments.map((segment) => segment.speaker))],
    coverage: {
      firstSegmentStartSec: segments[0].startSec,
      lastSegmentEndSec: segments.at(-1).endSec,
      chunkCount: chunks.length,
      ownershipPartitionApplied: true,
    },
    provenance: {
      provider: "doubao",
      service: "recording_file_asr_chunked",
      apiVersion: "v3",
      resourceId: chunkResults[0].provenance?.resourceId
        ?? "volc.bigasr.auc",
      originalTimestampUnit: "milliseconds",
      speakerDiarizationRequested: true,
      chunkProvenance,
    },
    generatedAt,
  };
}

/**
 * Convert a completed Doubao BigASR response to the transcript contract used by
 * the TianClip pipeline.
 */
export function normalizeDoubaoBigAsrResult(raw, {
  mediaDurationSec = undefined,
  chunkId = "audio_full",
  model = "doubao-bigasr-2.0",
  resourceId = "volc.bigasr.auc",
  taskId = undefined,
  generatedAt = new Date().toISOString(),
} = {}) {
  invariant(raw && typeof raw === "object", "Doubao ASR response is missing", {
    code: "DOUBAO_ASR_RESULT_MISSING",
    stage: "doubao_asr_normalize",
  });

  const utterances = raw?.result?.utterances ?? raw?.resp?.utterances;
  invariant(Array.isArray(utterances) && utterances.length > 0, "Doubao ASR returned no utterances", {
    code: "DOUBAO_ASR_UTTERANCES_MISSING",
    stage: "doubao_asr_normalize",
  });

  const nonEmptyUtterances = utterances
    .map((utterance, index) => ({
      utterance,
      index,
      text: normalizeText(utterance?.text),
    }))
    .filter(({ text }) => text.length > 0);
  invariant(nonEmptyUtterances.length > 0, "Doubao ASR utterance text is empty", {
    code: "DOUBAO_ASR_UTTERANCE_EMPTY",
    stage: "doubao_asr_normalize",
    details: { utteranceCount: utterances.length },
  });

  const segments = nonEmptyUtterances.map(({ utterance, index, text }) => {
    const startMs = Number(utterance?.start_time);
    const endMs = Number(utterance?.end_time);
    invariant(
      Number.isFinite(startMs) && Number.isFinite(endMs) && startMs >= 0 && endMs >= startMs,
      "Doubao ASR utterance timestamps are invalid",
      {
        code: "DOUBAO_ASR_TIMESTAMPS_INVALID",
        stage: "doubao_asr_normalize",
        details: { utteranceIndex: index },
      },
    );

    const startSec = roundMillis(startMs / 1000);
    const endSec = roundMillis(endMs / 1000);
    return {
      id: `tx_${chunkId}_${String(index + 1).padStart(5, "0")}`,
      sourceSegmentId: utterance?.id ?? utterance?.utterance_id ?? null,
      chunkId,
      speaker: normalizeSpeaker(utterance),
      text,
      localStartSec: startSec,
      localEndSec: endSec,
      startSec,
      endSec,
    };
  }).sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec);

  const resolvedDurationSec = resolveDurationSec(
    raw,
    mediaDurationSec,
    segments.at(-1)?.endSec ?? 0,
  );
  invariant(Number.isFinite(resolvedDurationSec) && resolvedDurationSec > 0, "Doubao ASR media duration is invalid", {
    code: "DOUBAO_ASR_DURATION_INVALID",
    stage: "doubao_asr_normalize",
  });
  for (const segment of segments) {
    invariant(segment.endSec <= resolvedDurationSec + 0.5, "Doubao ASR utterance falls outside the media timeline", {
      code: "DOUBAO_ASR_SEGMENT_OUTSIDE_MEDIA",
      stage: "doubao_asr_normalize",
      details: {
        segmentId: segment.id,
        segmentEndSec: segment.endSec,
        mediaDurationSec: resolvedDurationSec,
      },
    });
  }

  return {
    provider: "doubao",
    model,
    mediaDurationSec: resolvedDurationSec,
    segments,
    text: segments.map((segment) => segment.text).join("\n"),
    speakerLabels: [...new Set(segments.map((segment) => segment.speaker))],
    coverage: {
      firstSegmentStartSec: segments[0].startSec,
      lastSegmentEndSec: segments.at(-1).endSec,
      chunkCount: 1,
      ownershipPartitionApplied: false,
    },
    provenance: {
      provider: "doubao",
      service: "recording_file_asr",
      apiVersion: "v3",
      resourceId,
      taskId: normalizeText(taskId) || null,
      originalTimestampUnit: "milliseconds",
      speakerDiarizationRequested: true,
    },
    generatedAt,
  };
}

/**
 * Create an async Doubao BigASR provider.
 *
 * Authentication accepts either a current-console API key or the legacy
 * AppID + access-token pair.
 */
export function createDoubaoBigAsrClient({
  apiKey = process.env.DOUBAO_ASR_API_KEY,
  appId = process.env.DOUBAO_ASR_APP_ID
    ?? process.env.DOUBAO_ASR_APP_KEY
    ?? process.env.DOUDAO_ASR_APP_KEY,
  accessToken = process.env.DOUBAO_ASR_ACCESS_TOKEN
    ?? process.env.DOUBAO_ASR_ACCESS_KEY
    ?? process.env.DOUDAO_ASR_ACCESS_KEY,
  baseUrl = "https://openspeech.bytedance.com",
  resourceId = process.env.DOUBAO_ASR_RESOURCE_ID ?? "volc.bigasr.auc",
  fetchImpl = globalThis.fetch,
  sleepImpl = defaultSleep,
  requestIdFactory = randomUUID,
  now = Date.now,
  requestTimeoutMs = 60_000,
  pollIntervalMs = 5_000,
  pollTimeoutMs = 30 * 60 * 1000,
  maxPollAttempts = undefined,
  modelName = "bigmodel",
} = {}) {
  const normalizedApiKey = normalizeText(apiKey);
  const normalizedAppId = normalizeText(appId);
  const normalizedAccessToken = normalizeText(accessToken);
  const usingApiKey = normalizedApiKey.length > 0;
  const usingLegacyCredentials = normalizedAppId.length > 0 && normalizedAccessToken.length > 0;

  invariant(usingApiKey || usingLegacyCredentials, "Doubao ASR credentials are required", {
    code: "DOUBAO_ASR_CREDENTIALS_MISSING",
    stage: "doubao_asr_client",
  });
  invariant(
    usingApiKey || (normalizedAppId.length > 0 && normalizedAccessToken.length > 0),
    "Doubao ASR AppID and access token must be configured together",
    {
      code: "DOUBAO_ASR_LEGACY_CREDENTIALS_INCOMPLETE",
      stage: "doubao_asr_client",
    },
  );
  invariant(typeof fetchImpl === "function", "A fetch implementation is required", {
    code: "DOUBAO_ASR_FETCH_MISSING",
    stage: "doubao_asr_client",
  });
  invariant(typeof sleepImpl === "function", "A sleep implementation is required", {
    code: "DOUBAO_ASR_SLEEP_MISSING",
    stage: "doubao_asr_client",
  });
  invariant(typeof requestIdFactory === "function", "A request ID factory is required", {
    code: "DOUBAO_ASR_REQUEST_ID_FACTORY_MISSING",
    stage: "doubao_asr_client",
  });
  invariant(typeof now === "function", "A clock implementation is required", {
    code: "DOUBAO_ASR_CLOCK_MISSING",
    stage: "doubao_asr_client",
  });
  invariant(Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0, "requestTimeoutMs must be positive", {
    code: "DOUBAO_ASR_REQUEST_TIMEOUT_INVALID",
    stage: "doubao_asr_client",
  });
  invariant(Number.isFinite(pollIntervalMs) && pollIntervalMs >= 0, "pollIntervalMs cannot be negative", {
    code: "DOUBAO_ASR_POLL_INTERVAL_INVALID",
    stage: "doubao_asr_client",
  });
  invariant(Number.isFinite(pollTimeoutMs) && pollTimeoutMs > 0, "pollTimeoutMs must be positive", {
    code: "DOUBAO_ASR_POLL_TIMEOUT_INVALID",
    stage: "doubao_asr_client",
  });
  if (maxPollAttempts !== undefined) {
    invariant(Number.isInteger(maxPollAttempts) && maxPollAttempts > 0, "maxPollAttempts must be a positive integer", {
      code: "DOUBAO_ASR_MAX_POLLS_INVALID",
      stage: "doubao_asr_client",
    });
  }

  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, "");
  const redact = createRedactor([
    normalizedApiKey,
    normalizedAppId,
    normalizedAccessToken,
  ]);
  const authHeaders = usingApiKey
    ? { "X-Api-Key": normalizedApiKey }
    : {
        "X-Api-App-Key": normalizedAppId,
        "X-Api-Access-Key": normalizedAccessToken,
      };

  function headersFor(requestId, {
    logId = undefined,
    submit = false,
  } = {}) {
    return {
      "Content-Type": "application/json",
      ...authHeaders,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": requestId,
      ...(submit ? { "X-Api-Sequence": "-1" } : {}),
      ...(logId ? { "X-Tt-Logid": logId } : {}),
    };
  }

  async function postJson(path, {
    headers,
    body,
    signal,
    stage,
  }) {
    assertNotAborted(signal, stage);
    const timeout = createRequestTimeout(signal, requestTimeoutMs);
    try {
      const response = await fetchImpl(`${normalizedBaseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: timeout.signal,
      });
      const payload = await parseJsonBody(response, { stage, redact });
      const apiStatusCode = normalizeText(headerValue(response.headers, "X-Api-Status-Code"));
      const apiMessage = redact(headerValue(response.headers, "X-Api-Message"));
      const logId = normalizeText(headerValue(response.headers, "X-Tt-Logid"));

      if (!response.ok) {
        throw new PipelineError("Doubao ASR HTTP request failed", {
          code: "DOUBAO_ASR_HTTP_FAILED",
          stage,
          details: {
            httpStatus: response.status,
            apiStatusCode: apiStatusCode || undefined,
            apiMessage: apiMessage || undefined,
          },
        });
      }
      invariant(apiStatusCode.length > 0, "Doubao ASR response has no API status code", {
        code: "DOUBAO_ASR_STATUS_MISSING",
        stage,
        details: { httpStatus: response.status },
      });
      return {
        payload,
        apiStatusCode,
        apiMessage,
        logId,
      };
    } catch (error) {
      if (error instanceof PipelineError) throw error;
      if (signal?.aborted) {
        throw new PipelineError("Doubao ASR operation was aborted", {
          code: "DOUBAO_ASR_ABORTED",
          stage,
        });
      }
      if (timeout.didTimeOut()) {
        throw new PipelineError("Doubao ASR request timed out", {
          code: "DOUBAO_ASR_REQUEST_TIMEOUT",
          stage,
          details: { timeoutMs: requestTimeoutMs },
        });
      }
      throw new PipelineError("Doubao ASR network request failed", {
        code: "DOUBAO_ASR_NETWORK_FAILED",
        stage,
        cause: safeCause(error, redact),
      });
    } finally {
      timeout.clear();
    }
  }

  async function submitRecording({
    audioUrl,
    audioFormat = undefined,
    uid = normalizedAppId || "tianzong-clip-workbench",
    request = {},
    requestId = undefined,
    signal = undefined,
  } = {}) {
    let parsedUrl;
    try {
      parsedUrl = new URL(audioUrl);
    } catch {
      parsedUrl = null;
    }
    invariant(parsedUrl && ["http:", "https:"].includes(parsedUrl.protocol), "A downloadable HTTP(S) audio URL is required", {
      code: "DOUBAO_ASR_AUDIO_URL_INVALID",
      stage: "doubao_asr_submit",
    });
    invariant(request && typeof request === "object" && !Array.isArray(request), "Doubao ASR request options must be an object", {
      code: "DOUBAO_ASR_REQUEST_OPTIONS_INVALID",
      stage: "doubao_asr_submit",
    });

    const taskId = normalizeText(requestId ?? requestIdFactory());
    invariant(taskId.length > 0 && taskId.length <= 128, "Doubao ASR request ID is invalid", {
      code: "DOUBAO_ASR_REQUEST_ID_INVALID",
      stage: "doubao_asr_submit",
    });
    const response = await postJson("/api/v3/auc/bigmodel/submit", {
      headers: headersFor(taskId, { submit: true }),
      body: {
        user: { uid: normalizeText(uid) || "tianzong-clip-workbench" },
        audio: {
          url: audioUrl,
          ...(audioFormat ? { format: normalizeText(audioFormat) } : {}),
        },
        request: {
          ...request,
          model_name: modelName,
          enable_itn: true,
          enable_punc: true,
          show_utterances: true,
          enable_speaker_info: true,
        },
      },
      signal,
      stage: "doubao_asr_submit",
    });
    if (response.apiStatusCode !== COMPLETED_STATUS) {
      throw new PipelineError("Doubao ASR rejected the transcription task", {
        code: "DOUBAO_ASR_SUBMIT_FAILED",
        stage: "doubao_asr_submit",
        details: {
          apiStatusCode: response.apiStatusCode,
          apiMessage: response.apiMessage || undefined,
        },
      });
    }
    return {
      taskId,
      logId: response.logId || undefined,
      acceptedAt: new Date(now()).toISOString(),
    };
  }

  async function queryRecording({
    taskId,
    logId = undefined,
    signal = undefined,
  } = {}) {
    const normalizedTaskId = normalizeText(taskId);
    invariant(normalizedTaskId.length > 0, "Doubao ASR task ID is required", {
      code: "DOUBAO_ASR_TASK_ID_MISSING",
      stage: "doubao_asr_query",
    });
    const response = await postJson("/api/v3/auc/bigmodel/query", {
      headers: headersFor(normalizedTaskId, { logId }),
      body: {},
      signal,
      stage: "doubao_asr_query",
    });

    if (response.apiStatusCode === COMPLETED_STATUS) {
      return {
        status: "completed",
        statusCode: response.apiStatusCode,
        taskId: normalizedTaskId,
        logId: response.logId || logId,
        raw: response.payload,
      };
    }
    const pendingStatus = PENDING_STATUSES.get(response.apiStatusCode);
    if (pendingStatus) {
      return {
        status: pendingStatus,
        statusCode: response.apiStatusCode,
        taskId: normalizedTaskId,
        logId: response.logId || logId,
      };
    }
    throw new PipelineError("Doubao ASR transcription task failed", {
      code: "DOUBAO_ASR_TASK_FAILED",
      stage: "doubao_asr_query",
      details: {
        taskId: normalizedTaskId,
        apiStatusCode: response.apiStatusCode,
        apiMessage: response.apiMessage || undefined,
      },
    });
  }

  async function waitForRecording({
    taskId,
    logId = undefined,
    signal = undefined,
    intervalMs = pollIntervalMs,
    timeoutMs = pollTimeoutMs,
    maximumAttempts = maxPollAttempts,
    onProgress = undefined,
  } = {}) {
    invariant(Number.isFinite(intervalMs) && intervalMs >= 0, "Doubao ASR polling interval cannot be negative", {
      code: "DOUBAO_ASR_POLL_INTERVAL_INVALID",
      stage: "doubao_asr_poll",
    });
    invariant(Number.isFinite(timeoutMs) && timeoutMs > 0, "Doubao ASR polling timeout must be positive", {
      code: "DOUBAO_ASR_POLL_TIMEOUT_INVALID",
      stage: "doubao_asr_poll",
    });
    const attemptsLimit = maximumAttempts
      ?? Math.max(1, Math.ceil(timeoutMs / Math.max(intervalMs, 1)) + 1);
    invariant(Number.isInteger(attemptsLimit) && attemptsLimit > 0, "Doubao ASR maximum polling attempts must be positive", {
      code: "DOUBAO_ASR_MAX_POLLS_INVALID",
      stage: "doubao_asr_poll",
    });

    const startedAt = now();
    const deadline = startedAt + timeoutMs;
    let currentLogId = logId;
    for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
      assertNotAborted(signal, "doubao_asr_poll");
      if (attempt > 1 && now() >= deadline) break;

      const result = await queryRecording({
        taskId,
        logId: currentLogId,
        signal,
      });
      currentLogId = result.logId || currentLogId;
      await onProgress?.({
        stage: "doubao_asr_poll",
        taskId: result.taskId,
        attempt,
        status: result.status,
        statusCode: result.statusCode,
        elapsedMs: Math.max(0, now() - startedAt),
      });
      if (result.status === "completed") {
        return {
          raw: result.raw,
          taskId: result.taskId,
          logId: currentLogId,
          pollCount: attempt,
        };
      }
      if (attempt >= attemptsLimit || now() >= deadline) break;

      const remainingMs = Math.max(0, deadline - now());
      try {
        await sleepImpl(Math.min(intervalMs, remainingMs), signal);
      } catch (error) {
        if (signal?.aborted) {
          throw new PipelineError("Doubao ASR operation was aborted", {
            code: "DOUBAO_ASR_ABORTED",
            stage: "doubao_asr_poll",
          });
        }
        throw new PipelineError("Doubao ASR polling wait failed", {
          code: "DOUBAO_ASR_POLL_WAIT_FAILED",
          stage: "doubao_asr_poll",
          cause: safeCause(error, redact),
        });
      }
    }

    throw new PipelineError("Doubao ASR transcription timed out", {
      code: "DOUBAO_ASR_POLL_TIMEOUT",
      stage: "doubao_asr_poll",
      details: {
        taskId: normalizeText(taskId),
        timeoutMs,
        maxPollAttempts: attemptsLimit,
      },
    });
  }

  async function transcribeRecording({
    audioUrl,
    audioFormat = undefined,
    uid = undefined,
    request = {},
    requestId = undefined,
    mediaDurationSec = undefined,
    chunkId = "audio_full",
    signal = undefined,
    intervalMs = pollIntervalMs,
    timeoutMs = pollTimeoutMs,
    maximumAttempts = maxPollAttempts,
    onProgress = undefined,
  } = {}) {
    const submitted = await submitRecording({
      audioUrl,
      audioFormat,
      uid,
      request,
      requestId,
      signal,
    });
    await onProgress?.({
      stage: "doubao_asr_submit",
      taskId: submitted.taskId,
      status: "accepted",
    });
    const completed = await waitForRecording({
      taskId: submitted.taskId,
      logId: submitted.logId,
      signal,
      intervalMs,
      timeoutMs,
      maximumAttempts,
      onProgress,
    });
    return normalizeDoubaoBigAsrResult(completed.raw, {
      mediaDurationSec,
      chunkId,
      resourceId,
      taskId: completed.taskId,
      generatedAt: new Date(now()).toISOString(),
    });
  }

  return {
    submitRecording,
    queryRecording,
    waitForRecording,
    transcribeRecording,
  };
}
