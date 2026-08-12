export type ProcessorProjectInput = {
  id: string;
  title: string;
  projectDate: string;
  sourceName: string;
  mode: "聊播" | "带货";
  editorMode: "openai" | "doubao" | "kimi" | "compare";
};

export type SinglePresignedUpload = {
  id: string;
  projectId: string;
  status: "presigned";
  strategy: "single";
  objectKey: string;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresIn: number;
};

export type MultipartPresignedUpload = {
  id: string;
  projectId: string;
  status: "multipart_initiated";
  strategy: "multipart";
  objectKey: string;
  partSizeBytes: number;
  partCount: number;
  expiresIn: number;
};

export type PresignedUpload = SinglePresignedUpload | MultipartPresignedUpload;

export type UploadedMultipartPart = {
  partNumber: number;
  etag: string;
};

export type MultipartUploadStatus = {
  uploadId: string;
  projectId: string;
  status: "multipart_initiated" | "uploading" | "completing" | "uploaded" | "verified";
  partCount: number;
  uploadedParts: UploadedMultipartPart[];
};

export type ProcessorJobStatus =
  | "queued"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ProcessorJob = {
  id: string;
  projectId: string;
  uploadId: string;
  subtitleUploadId: string | null;
  transcriptSource: "uploaded_srt" | "automatic_asr";
  status: ProcessorJobStatus;
  stage: string;
  progress: number;
  clipCount: number;
  error: string | null;
  attempt: number;
  maxAttempts: number;
  coreVersion: string | null;
  coreSha256: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProcessorJobEvent = {
  id: number;
  stage: string;
  progress: number;
  message: string;
  createdAt: string;
};

/** Server-calculated ledger only; the browser never invents or estimates cost. */
export type ProcessorJobCost = {
  totalCny: number;
  complete: boolean;
  unpricedStages: string[];
  perStageCny: Record<string, number>;
  deliveredClipSeconds: number;
  deliveredClipCount: number;
  cnyPerDeliveredSecond: number | null;
  sourceMediaSeconds: number;
  cnyPerSourceHour: number | null;
};

export type ProcessorTranscriptLine = {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker: string;
  defaultDecision: "keep" | "remove";
  reason: string;
  evidenceLevel: "原声逐字" | "逐字稿摘录" | "策划摘要";
};

export type ProcessorSourceMedia = {
  originalFileName: string;
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: {
    numerator: number;
    denominator: number;
    rational: string;
    fps: number;
    source: "avg_frame_rate" | "r_frame_rate";
  } | null;
  audioChannels: number | null;
  metadataStatus: "verified_ffprobe" | "incomplete_ffprobe";
  missingFields: string[];
};

export type ProcessorCandidate = {
  id: string;
  kind: "聊播" | "带货";
  editorProvider?: "openai" | "doubao" | "kimi";
  index: string;
  title: string;
  douyinTitle: string;
  xiaohongshuTitle: string;
  topic?: string;
  hook?: string;
  openingLine?: string;
  closingLine?: string;
  sourceStart: number;
  sourceEnd: number;
  durationSeconds: number;
  score: number;
  summary: string;
  contentType: string;
  personaModes: string[];
  personaReason: string;
  durationMode: "micro" | "standard" | "deep_dive" | "custom";
  durationWindow: string;
  durationReason: string;
  selectionReasons: string[];
  scoreBreakdown: Array<{ label: string; score: number; max: number }>;
  priority: "S" | "A" | "B";
  factGate: string;
  calibrationStatus: string;
  transcript: ProcessorTranscriptLine[];
  previewUrl: string | null;
  reviewStatus:
    | "editorial_candidate_needs_av_review"
    | "proxy_rendered_needs_human_normal_playback"
    | "human_review_needs_changes"
    | "human_review_rejected"
    | "human_av_verified_normal_playback";
  renderStatus:
    | "rough_ready"
    | "revision_queued"
    | "revision_rendering"
    | "revision_ready"
    | "render_failed";
  previewKind: "rough_cut" | "revised_cut";
  previewVersion: string;
  isFinal: boolean;
  sourceMedia?: ProcessorSourceMedia;
};

type JsonObject = Record<string, unknown>;

export class ProcessorRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProcessorRequestError";
    this.status = status;
  }
}

export function processorRequestIsRecoverable(error: unknown) {
  if (error instanceof ProcessorRequestError) {
    return [0, 408, 425, 429, 500, 502, 503, 504].includes(error.status);
  }
  if (error instanceof TypeError) return true;
  if (error instanceof DOMException) {
    return error.name === "AbortError" || error.name === "NetworkError" || error.name === "TimeoutError";
  }
  const message = error instanceof Error ? error.message : "";
  return /failed to fetch|load failed|networkerror|network request failed/i.test(message);
}

function operationHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "Idempotency-Key": `workbench-${crypto.randomUUID()}`,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as JsonObject;
  if (!response.ok) {
    const nestedError =
      payload.error && typeof payload.error === "object"
        ? payload.error as JsonObject
        : null;
    const message =
      (nestedError && typeof nestedError.message === "string" && nestedError.message) ||
      (typeof payload.error === "string" && payload.error) ||
      `请求失败（${response.status}）`;
    throw new ProcessorRequestError(message, response.status);
  }
  return payload as T;
}

type UploadPurpose = "source_video" | "subtitle_srt";

function supportedContentType(
  file: File,
  purpose: UploadPurpose,
): "video/mp4" | "video/quicktime" | "application/x-subrip" {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (purpose === "subtitle_srt") {
    if (name.endsWith(".srt")) return "application/x-subrip";
    throw new Error("字幕必须是标准 .srt 文件。");
  }
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".mov")) return "video/quicktime";
  if (type === "video/mp4") return "video/mp4";
  if (type === "video/quicktime") return "video/quicktime";
  throw new Error("当前真实处理链路只接受 MP4 或 MOV 原片。");
}

export async function createProcessorProject(input: ProcessorProjectInput) {
  const response = await fetch("/api/runtime/projects", {
    method: "POST",
    headers: operationHeaders(),
    body: JSON.stringify(input),
  });
  return readJson<{ project: { id: string } }>(response);
}

export async function prepareProcessorUpload(
  projectId: string,
  file: File,
  purpose: UploadPurpose = "source_video",
) {
  const response = await fetch(
    `/api/runtime/projects/${encodeURIComponent(projectId)}/uploads/presign`,
    {
      method: "POST",
      headers: operationHeaders(),
      body: JSON.stringify({
        sourceName: file.name,
        contentType: supportedContentType(file, purpose),
        purpose,
        sizeBytes: file.size,
      }),
    },
  );
  const { upload } = await readJson<{
    upload:
      | {
          id: string;
          projectId: string;
          status: "presigned";
          strategy: "single";
          objectKey: string;
          putUrl: string;
          requiredHeaders: Record<string, string>;
          expiresIn: number;
        }
      | {
          id: string;
          projectId: string;
          status: "multipart_initiated";
          strategy: "multipart";
          objectKey: string;
          partSizeBytes: number;
          partCount: number;
          expiresIn: number;
        };
  }>(response);
  if (!upload.id || !upload.objectKey) {
    throw new Error("处理服务没有返回可用的上传凭证。");
  }
  if (upload.strategy === "multipart") {
    if (
      !Number.isSafeInteger(upload.partSizeBytes)
      || upload.partSizeBytes < 5 * 1024 * 1024
      || !Number.isSafeInteger(upload.partCount)
      || upload.partCount < 2
      || upload.partCount > 10_000
    ) {
      throw new Error("处理服务返回了无效的分片计划。");
    }
    return {
      upload: {
        id: upload.id,
        projectId: upload.projectId,
        status: upload.status,
        strategy: "multipart",
        objectKey: upload.objectKey,
        partSizeBytes: upload.partSizeBytes,
        partCount: upload.partCount,
        expiresIn: upload.expiresIn,
      } satisfies MultipartPresignedUpload,
    };
  }
  if (!upload.putUrl) {
    throw new Error("处理服务没有返回可用的单次上传地址。");
  }
  return {
    upload: {
      id: upload.id,
      projectId: upload.projectId,
      status: upload.status,
      strategy: "single",
      objectKey: upload.objectKey,
      method: "PUT",
      url: upload.putUrl,
      headers: upload.requiredHeaders,
      expiresIn: upload.expiresIn,
    } satisfies SinglePresignedUpload,
  };
}

function uploadBlobToPresignedUrl(
  body: Blob,
  options: {
    url: string;
    headers?: Record<string, string>;
    requireEtag: boolean;
  },
  onProgress: (loadedBytes: number) => void,
) {
  return new Promise<string | null>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", options.url);
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      request.setRequestHeader(name, value);
    }
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded);
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(body.size);
        const etag = request.getResponseHeader("etag");
        if (options.requireEtag && !etag) {
          reject(new Error("分片已上传，但浏览器无法读取 ETag；请检查 R2 CORS 的 ExposeHeaders。"));
          return;
        }
        resolve(etag);
      } else {
        reject(new ProcessorRequestError(`原片上传失败（${request.status || "网络错误"}）`, request.status));
      }
    });
    request.addEventListener("error", () => reject(new ProcessorRequestError("原片上传失败，请检查网络和存储跨域设置。", 0)));
    request.addEventListener("abort", () => reject(new Error("原片上传已取消。")));
    request.send(body);
  });
}

async function presignMultipartParts(
  upload: MultipartPresignedUpload,
  partNumbers: number[],
) {
  const response = await fetch(
    `/api/runtime/projects/${encodeURIComponent(upload.projectId)}/uploads/${encodeURIComponent(upload.id)}/multipart/parts`,
    {
      method: "POST",
      headers: operationHeaders(),
      body: JSON.stringify({ partNumbers }),
    },
  );
  return readJson<{
    uploadId: string;
    parts: Array<{ partNumber: number; putUrl: string; expiresIn: number }>;
  }>(response);
}

/**
 * The storage provider is authoritative. Querying it before resuming prevents a
 * stale local checkpoint, browser crash, or a second tab from re-uploading data
 * that has already safely reached private storage.
 */
export async function readMultipartUploadStatus(
  upload: MultipartPresignedUpload,
): Promise<MultipartUploadStatus> {
  const response = await fetch(
    `/api/runtime/projects/${encodeURIComponent(upload.projectId)}/uploads/${encodeURIComponent(upload.id)}/multipart/status`,
    { cache: "no-store" },
  );
  return readJson<MultipartUploadStatus>(response);
}

function retryDelay(attempt: number) {
  const base = Math.min(8_000, 500 * (2 ** attempt));
  return new Promise((resolve) => window.setTimeout(resolve, base + Math.random() * 400));
}

/**
 * A consumer uplink can stall for tens of seconds without the connection being
 * truly dead. Retrying a part several times with backoff (and a freshly signed
 * URL each time) keeps a multi-GB transfer alive instead of surfacing a hard
 * failure the user has to restart from.
 */
const PART_UPLOAD_ATTEMPTS = 6;

function preferredMultipartConcurrency() {
  const connection = (navigator as Navigator & {
    connection?: NetworkInformation & { downlink?: number; saveData?: boolean };
  }).connection;
  if (connection?.saveData || connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") {
    return 2;
  }
  if (typeof connection?.downlink === "number" && connection.downlink < 4) return 3;
  return 4;
}

async function uploadMultipartFile(
  file: File,
  upload: MultipartPresignedUpload,
  onProgress: (ratio: number) => void,
  options: {
    completedParts?: UploadedMultipartPart[];
    onPartsCompleted?: (parts: UploadedMultipartPart[]) => void;
  } = {},
): Promise<UploadedMultipartPart[]> {
  const expectedPartCount = Math.ceil(file.size / upload.partSizeBytes);
  if (expectedPartCount !== upload.partCount) {
    throw new Error("本地文件大小与服务端分片计划不一致，请重新选择原片。");
  }

  const concurrency = preferredMultipartConcurrency();
  const presignWindow = Math.max(concurrency, Math.min(8, concurrency * 2));
  const completedByNumber = new Map<number, UploadedMultipartPart>();
  for (const part of options.completedParts ?? []) {
    if (
      Number.isSafeInteger(part.partNumber)
      && part.partNumber >= 1
      && part.partNumber <= upload.partCount
      && typeof part.etag === "string"
      && part.etag.trim()
    ) {
      completedByNumber.set(part.partNumber, {
        partNumber: part.partNumber,
        etag: part.etag,
      });
    }
  }
  const activeLoadedBytes = new Map<number, number>();
  const partSize = (partNumber: number) => {
    const start = (partNumber - 1) * upload.partSizeBytes;
    return Math.max(0, Math.min(file.size, start + upload.partSizeBytes) - start);
  };
  let completedBytes = Array.from(completedByNumber.keys())
    .reduce((sum, partNumber) => sum + partSize(partNumber), 0);
  const reportProgress = () => {
    const activeBytes = Array.from(activeLoadedBytes.values())
      .reduce((sum, value) => sum + value, 0);
    onProgress(Math.min(1, (completedBytes + activeBytes) / file.size));
  };
  const completedParts = () => Array.from(completedByNumber.values())
    .sort((left, right) => left.partNumber - right.partNumber);

  reportProgress();
  const pendingPartNumbers = Array.from(
    { length: upload.partCount },
    (_, index) => index + 1,
  ).filter((partNumber) => !completedByNumber.has(partNumber));

  for (let startIndex = 0; startIndex < pendingPartNumbers.length; startIndex += presignWindow) {
    const partNumbers = pendingPartNumbers.slice(startIndex, startIndex + presignWindow);
    const signed = await presignMultipartParts(upload, partNumbers);
    const signedByNumber = new Map(signed.parts.map((part) => [part.partNumber, part]));
    const queue = [...partNumbers];
    let failed: unknown = null;

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length && !failed) {
        const partNumber = queue.shift();
        if (!partNumber) continue;
        const start = (partNumber - 1) * upload.partSizeBytes;
        const end = Math.min(file.size, start + upload.partSizeBytes);
        const blob = file.slice(start, end);
        let signedPart = signedByNumber.get(partNumber);
        if (!signedPart || blob.size <= 0) {
          failed = new Error(`第 ${partNumber} 个上传分片计划无效。`);
          return;
        }
        let lastError: unknown;
        for (let attempt = 0; attempt < PART_UPLOAD_ATTEMPTS; attempt += 1) {
          activeLoadedBytes.set(partNumber, 0);
          reportProgress();
          try {
            if (attempt > 0) {
              const refreshed = await presignMultipartParts(upload, [partNumber]);
              signedPart = refreshed.parts[0];
              if (!signedPart) throw new Error(`第 ${partNumber} 个上传分片重签失败。`);
            }
            const etag = await uploadBlobToPresignedUrl(
              blob,
              { url: signedPart.putUrl, requireEtag: true },
              (loadedBytes) => {
                activeLoadedBytes.set(partNumber, Math.min(blob.size, loadedBytes));
                reportProgress();
              },
            );
            if (!etag) throw new Error(`第 ${partNumber} 个分片缺少 ETag。`);
            activeLoadedBytes.delete(partNumber);
            completedBytes += blob.size;
            const completedPart = { partNumber, etag };
            completedByNumber.set(partNumber, completedPart);
            reportProgress();
            options.onPartsCompleted?.(completedParts());
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            activeLoadedBytes.set(partNumber, 0);
            reportProgress();
            if (attempt < PART_UPLOAD_ATTEMPTS - 1) await retryDelay(attempt);
          }
        }
        if (lastError) {
          failed = lastError;
          return;
        }
      }
    }));
    if (failed) throw failed;
    options.onPartsCompleted?.(completedParts());
  }
  onProgress(1);
  return completedParts();
}

export async function uploadToPresignedUrl(
  file: File,
  upload: PresignedUpload,
  onProgress: (ratio: number) => void,
  options: {
    completedParts?: UploadedMultipartPart[];
    onPartsCompleted?: (parts: UploadedMultipartPart[]) => void;
  } = {},
): Promise<UploadedMultipartPart[]> {
  if (upload.strategy === "multipart") {
    return uploadMultipartFile(file, upload, onProgress, options);
  }
  await uploadBlobToPresignedUrl(
    file,
    { url: upload.url, headers: upload.headers, requireEtag: false },
    (loadedBytes) => onProgress(Math.min(1, loadedBytes / file.size)),
  );
  onProgress(1);
  return [];
}

export async function completeProcessorUpload(
  projectId: string,
  upload: PresignedUpload,
  parts: UploadedMultipartPart[],
) {
  const suffix = upload.strategy === "multipart" ? "/multipart/complete" : "/complete";
  const response = await fetch(
    `/api/runtime/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(upload.id)}${suffix}`,
    {
      method: "POST",
      headers: operationHeaders(),
      body: upload.strategy === "multipart"
        ? JSON.stringify({ parts })
        : "{}",
    },
  );
  return readJson<{
    upload: {
      id: string;
      projectId: string;
      status: "uploaded";
      sizeBytes: number;
      strategy?: "single" | "multipart";
      partCount?: number;
    };
  }>(response);
}

export async function startProcessorJob(
  projectId: string,
  uploadId: string,
  subtitleUploadId?: string,
) {
  const response = await fetch(
    `/api/runtime/projects/${encodeURIComponent(projectId)}/jobs`,
    {
      method: "POST",
      headers: operationHeaders(),
      body: JSON.stringify({
        uploadId,
        ...(subtitleUploadId ? { subtitleUploadId } : {}),
      }),
    },
  );
  return readJson<{ job: ProcessorJob }>(response);
}

export async function readProcessorJob(jobId: string) {
  const response = await fetch(`/api/runtime/jobs/${encodeURIComponent(jobId)}`, {
    cache: "no-store",
  });
  return readJson<{ job: ProcessorJob }>(response);
}

export async function readProcessorJobEvents(jobId: string, afterId = 0) {
  const response = await fetch(
    `/api/runtime/jobs/${encodeURIComponent(jobId)}/events?after=${encodeURIComponent(String(afterId))}`,
    { cache: "no-store" },
  );
  return readJson<{ events: ProcessorJobEvent[] }>(response);
}

export async function readProcessorJobCost(jobId: string) {
  const response = await fetch(`/api/runtime/jobs/${encodeURIComponent(jobId)}/cost`, {
    cache: "no-store",
  });
  return readJson<{ cost: ProcessorJobCost }>(response);
}

export async function readProcessorCandidates(projectId: string) {
  const response = await fetch(
    `/api/runtime/projects/${encodeURIComponent(projectId)}/candidates`,
    { cache: "no-store" },
  );
  return readJson<{ candidates: ProcessorCandidate[] }>(response);
}

export async function submitProcessorFeedback(
  candidateId: string,
  payload: {
    decision: "approve" | "reject" | "adjust" | "note";
    trim?: { sourceStart: number; sourceEnd: number };
    transcriptDecisions?: Array<{
      lineId: string;
      decision: "keep" | "remove";
      reason?: string;
    }>;
    title?: string;
    notes?: string;
    avConfirmed?: {
      normalPlaybackConfirmed: true;
      audioVideoSyncConfirmed: true;
      reviewedWholeProxy: true;
      reviewedPreviewVersion: string;
    };
  },
) {
  const response = await fetch(
    `/api/runtime/candidates/${encodeURIComponent(candidateId)}/feedback`,
    {
      method: "POST",
      headers: operationHeaders(),
      body: JSON.stringify(payload),
    },
  );
  return readJson<{
    feedback: {
      id: string;
      createdAt: string;
      reviewStatus: ProcessorCandidate["reviewStatus"];
      renderStatus: ProcessorCandidate["renderStatus"];
    };
    candidate: ProcessorCandidate;
  }>(response);
}
