export type ProcessorProjectInput = {
  id: string;
  title: string;
  projectDate: string;
  sourceName: string;
  mode: "聊播" | "带货";
  editorMode: "openai" | "doubao" | "compare";
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
  editorProvider?: "openai" | "doubao";
  index: string;
  title: string;
  douyinTitle: string;
  xiaohongshuTitle: string;
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
    throw new Error(message);
  }
  return payload as T;
}

function supportedContentType(file: File): "video/mp4" | "video/quicktime" {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
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

export async function prepareProcessorUpload(projectId: string, file: File) {
  const response = await fetch(
    `/api/runtime/projects/${encodeURIComponent(projectId)}/uploads/presign`,
    {
      method: "POST",
      headers: operationHeaders(),
      body: JSON.stringify({
        sourceName: file.name,
        contentType: supportedContentType(file),
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
        reject(new Error(`原片上传失败（${request.status || "网络错误"}）`));
      }
    });
    request.addEventListener("error", () => reject(new Error("原片上传失败，请检查网络和存储跨域设置。")));
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

async function abortMultipartUpload(upload: MultipartPresignedUpload) {
  const response = await fetch(
    `/api/runtime/projects/${encodeURIComponent(upload.projectId)}/uploads/${encodeURIComponent(upload.id)}/multipart/abort`,
    {
      method: "POST",
      headers: operationHeaders(),
      body: "{}",
    },
  );
  return readJson(response);
}

function retryDelay(attempt: number) {
  const base = Math.min(4_000, 400 * (2 ** attempt));
  return new Promise((resolve) => window.setTimeout(resolve, base + Math.random() * 250));
}

async function uploadMultipartFile(
  file: File,
  upload: MultipartPresignedUpload,
  onProgress: (ratio: number) => void,
): Promise<UploadedMultipartPart[]> {
  const expectedPartCount = Math.ceil(file.size / upload.partSizeBytes);
  if (expectedPartCount !== upload.partCount) {
    throw new Error("本地文件大小与服务端分片计划不一致，请重新选择原片。");
  }

  const concurrency = 3;
  const completed: UploadedMultipartPart[] = [];
  const activeLoadedBytes = new Map<number, number>();
  let completedBytes = 0;
  const reportProgress = () => {
    const activeBytes = Array.from(activeLoadedBytes.values())
      .reduce((sum, value) => sum + value, 0);
    onProgress(Math.min(1, (completedBytes + activeBytes) / file.size));
  };

  try {
    for (let startIndex = 0; startIndex < upload.partCount; startIndex += concurrency) {
      const partNumbers = Array.from(
        { length: Math.min(concurrency, upload.partCount - startIndex) },
        (_, offset) => startIndex + offset + 1,
      );
      const signed = await presignMultipartParts(upload, partNumbers);
      const signedByNumber = new Map(
        signed.parts.map((part) => [part.partNumber, part]),
      );
      const settledBatch = await Promise.allSettled(partNumbers.map(async (partNumber) => {
        const start = (partNumber - 1) * upload.partSizeBytes;
        const end = Math.min(file.size, start + upload.partSizeBytes);
        const blob = file.slice(start, end);
        const part = signedByNumber.get(partNumber);
        if (!part || blob.size <= 0) {
          throw new Error(`第 ${partNumber} 个上传分片计划无效。`);
        }
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          activeLoadedBytes.set(partNumber, 0);
          reportProgress();
          try {
            const etag = await uploadBlobToPresignedUrl(
              blob,
              { url: part.putUrl, requireEtag: true },
              (loadedBytes) => {
                activeLoadedBytes.set(partNumber, Math.min(blob.size, loadedBytes));
                reportProgress();
              },
            );
            if (!etag) throw new Error(`第 ${partNumber} 个分片缺少 ETag。`);
            activeLoadedBytes.delete(partNumber);
            completedBytes += blob.size;
            reportProgress();
            return { partNumber, etag };
          } catch (error) {
            lastError = error;
            activeLoadedBytes.set(partNumber, 0);
            reportProgress();
            if (attempt < 2) await retryDelay(attempt);
          }
        }
        throw lastError instanceof Error
          ? lastError
          : new Error(`第 ${partNumber} 个分片上传失败。`);
      }));
      const failed = settledBatch.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) throw failed.reason;
      completed.push(...settledBatch.map((result) =>
        (result as PromiseFulfilledResult<UploadedMultipartPart>).value
      ));
    }
    onProgress(1);
    return completed.sort((left, right) => left.partNumber - right.partNumber);
  } catch (error) {
    await abortMultipartUpload(upload).catch(() => undefined);
    throw error;
  }
}

export async function uploadToPresignedUrl(
  file: File,
  upload: PresignedUpload,
  onProgress: (ratio: number) => void,
): Promise<UploadedMultipartPart[]> {
  if (upload.strategy === "multipart") {
    return uploadMultipartFile(file, upload, onProgress);
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

export async function startProcessorJob(projectId: string, uploadId: string) {
  const response = await fetch(
    `/api/runtime/projects/${encodeURIComponent(projectId)}/jobs`,
    {
      method: "POST",
      headers: operationHeaders(),
      body: JSON.stringify({ uploadId }),
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
