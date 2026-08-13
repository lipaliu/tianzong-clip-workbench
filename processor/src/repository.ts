import { randomUUID } from "node:crypto";
import type pg from "pg";
import { sha256Hex } from "./canonical.js";
import type { ProcessorConfig } from "./config.js";
import type { Database } from "./db.js";
import { AppError } from "./errors.js";
import { summarizeJobCost } from "./pricing.js";
import type { CostEntry, JobCostSummary } from "./pricing.js";
import type {
  CandidatePayload,
  CandidateRenderSpec,
  CandidateRenderStatus,
  CandidateReviewStatus,
  ClaimedJob,
  ClaimedRender,
  JobApi,
  ProjectApi,
  EditorialModelMode,
  TianClipMode,
} from "./types.js";

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function isoValue(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function dateValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export function mapProject(row: Record<string, unknown>): ProjectApi {
  return {
    id: String(row.id),
    title: String(row.title),
    projectDate: dateValue(row.project_date),
    sourceName: String(row.source_name),
    mode: row.mode as TianClipMode,
    editorMode: (row.editor_mode ?? "compare") as EditorialModelMode,
    status: String(row.status),
    stage: String(row.stage),
    progress: numberValue(row.progress),
    clipCount: numberValue(row.clip_count),
    error: row.error_public === null || row.error_public === undefined
      ? null
      : String(row.error_public),
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at),
  };
}

export function mapJob(row: Record<string, unknown>): JobApi {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    uploadId: String(row.upload_id),
    subtitleUploadId: row.subtitle_upload_id === null || row.subtitle_upload_id === undefined
      ? null
      : String(row.subtitle_upload_id),
    transcriptSource: (row.transcript_source ?? "automatic_asr") as JobApi["transcriptSource"],
    status: row.status as JobApi["status"],
    stage: String(row.stage),
    progress: numberValue(row.progress),
    clipCount: numberValue(row.clip_count),
    error: row.error_public === null || row.error_public === undefined
      ? null
      : String(row.error_public),
    attempt: numberValue(row.attempt),
    maxAttempts: numberValue(row.max_attempts),
    coreVersion: row.core_version === null || row.core_version === undefined
      ? null
      : String(row.core_version),
    coreSha256: row.core_sha256 === null || row.core_sha256 === undefined
      ? null
      : String(row.core_sha256),
    result: row.result && typeof row.result === "object"
      ? row.result as Record<string, unknown>
      : null,
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at),
  };
}

type StoredResponse<T> = {
  statusCode: number;
  payload: T;
  replayed: boolean;
};

export class ProcessorRepository {
  constructor(
    readonly database: Database,
    private readonly config: ProcessorConfig,
  ) {}

  async touchWorkerHeartbeat(workerId: string): Promise<void> {
    if (!workerId || workerId.length > 500) {
      throw new AppError(400, "worker_id_invalid", "Worker 标识无效。", { expose: false });
    }
    await this.database.query(
      `INSERT INTO worker_heartbeats(worker_id, first_seen_at, last_seen_at)
       VALUES($1, now(), now())
       ON CONFLICT(worker_id) DO UPDATE
       SET last_seen_at = now()`,
      [workerId],
    );
  }

  async hasRecentWorkerHeartbeat(
    maxAgeSeconds = this.config.worker.heartbeatMaxAgeSeconds,
  ): Promise<boolean> {
    if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
      throw new Error("worker heartbeat max age must be a positive integer");
    }
    const result = await this.database.query(
      `SELECT EXISTS(
         SELECT 1
         FROM worker_heartbeats
         WHERE last_seen_at >= now() - ($1 * interval '1 second')
       ) AS active`,
      [maxAgeSeconds],
    );
    return result.rows[0]?.active === true;
  }

  async withIdempotency<T>(
    scope: string,
    key: string,
    requestHash: string,
    operation: () => Promise<{ statusCode: number; payload: T }>,
  ): Promise<StoredResponse<T>> {
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw new AppError(400, "idempotency_key_invalid", "Idempotency-Key 格式无效。");
    }

    const ownerToken = randomUUID();
    const inserted = await this.database.query(
      `INSERT INTO idempotency_records(
         scope, idempotency_key, request_sha256, owner_token, expires_at
       )
       VALUES($1, $2, $3, $4, now() + interval '24 hours')
       ON CONFLICT DO NOTHING
       RETURNING owner_token`,
      [scope, key, requestHash, ownerToken],
    );

    if (!inserted.rowCount) {
      const existing = await this.database.query(
        `SELECT request_sha256, response_status, response_body
         FROM idempotency_records
         WHERE scope = $1 AND idempotency_key = $2`,
        [scope, key],
      );
      const row = existing.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        throw new AppError(409, "idempotency_conflict", "请求正在处理中，请稍后重试。");
      }
      if (row.request_sha256 !== requestHash) {
        throw new AppError(
          409,
          "idempotency_payload_mismatch",
          "同一个 Idempotency-Key 不能用于不同请求。",
        );
      }
      if (row.response_status === null || row.response_body === null) {
        throw new AppError(409, "idempotency_in_progress", "请求正在处理中，请稍后查询。");
      }
      return {
        statusCode: numberValue(row.response_status),
        payload: row.response_body as T,
        replayed: true,
      };
    }

    try {
      const response = await operation();
      await this.database.query(
        `UPDATE idempotency_records
         SET response_status = $4, response_body = $5
         WHERE scope = $1 AND idempotency_key = $2
           AND request_sha256 = $3 AND owner_token = $6`,
        [scope, key, requestHash, response.statusCode, response.payload, ownerToken],
      );
      return { ...response, replayed: false };
    } catch (error) {
      await this.database.query(
        `DELETE FROM idempotency_records
         WHERE scope = $1 AND idempotency_key = $2 AND owner_token = $3`,
        [scope, key, ownerToken],
      ).catch(() => undefined);
      throw error;
    }
  }

  async createProject(input: {
    id?: string;
    title: string;
    projectDate: string;
    sourceName: string;
    mode: TianClipMode;
    editorMode: EditorialModelMode;
  }): Promise<ProjectApi> {
    const id = input.id ?? randomUUID();
    try {
      const result = await this.database.query(
        `INSERT INTO projects(id, title, project_date, source_name, mode, editor_mode)
         VALUES($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [id, input.title, input.projectDate, input.sourceName, input.mode, input.editorMode],
      );
      return mapProject(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new AppError(409, "project_exists", "该项目 ID 已存在。");
      }
      throw error;
    }
  }

  async getProject(projectId: string): Promise<ProjectApi> {
    const result = await this.database.query("SELECT * FROM projects WHERE id = $1", [projectId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new AppError(404, "project_not_found", "项目不存在。");
    return mapProject(row);
  }

  async createUpload(input: {
    projectId: string;
    sourceName: string;
    contentType: string;
    sizeBytes: number;
    sha256?: string;
    strategy: "single" | "multipart";
    purpose: "source_video" | "subtitle_srt";
  }): Promise<{ id: string; objectKey: string }> {
    await this.getProject(input.projectId);
    const id = randomUUID();
    const extension = input.purpose === "subtitle_srt"
      ? ".srt"
      : input.sourceName.toLowerCase().endsWith(".mov") ? ".mov" : ".mp4";
    const objectKey = `uploads/${input.projectId}/${id}/${input.purpose === "subtitle_srt" ? "subtitle" : "source"}${extension}`;
    await this.database.query(
      `INSERT INTO media_uploads(
         id, project_id, object_key, source_name, content_type,
         expected_size_bytes, expected_sha256, upload_strategy, upload_purpose
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        input.projectId,
        objectKey,
        input.sourceName,
        input.contentType,
        input.sizeBytes,
        input.sha256 ?? null,
        input.strategy,
        input.purpose,
      ],
    );
    if (input.purpose === "source_video") {
      await this.database.query(
        `UPDATE projects
         SET status = 'uploading', stage = 'uploading', progress = 0, updated_at = now()
         WHERE id = $1`,
        [input.projectId],
      );
    }
    return { id, objectKey };
  }

  async beginMultipartUpload(input: {
    projectId: string;
    uploadId: string;
    multipartUploadId: string;
    partSizeBytes: number;
    parts: Array<{ partNumber: number; sizeBytes: number }>;
  }): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const upload = await client.query(
        `UPDATE media_uploads
         SET multipart_upload_id = $3,
             multipart_part_size_bytes = $4,
             multipart_part_count = $5,
             status = 'multipart_initiated'
         WHERE id = $1 AND project_id = $2
           AND upload_strategy = 'multipart' AND status = 'presigned'
         RETURNING id`,
        [
          input.uploadId,
          input.projectId,
          input.multipartUploadId,
          input.partSizeBytes,
          input.parts.length,
        ],
      );
      if (!upload.rowCount) {
        throw new AppError(409, "multipart_upload_state_invalid", "分片上传状态无效。");
      }
      const partNumbers = input.parts.map((part) => part.partNumber);
      const partSizes = input.parts.map((part) => part.sizeBytes);
      await client.query(
        `INSERT INTO multipart_upload_parts(
           upload_id, project_id, part_number, expected_size_bytes
         )
         SELECT $1, $2, plan.part_number, plan.expected_size_bytes
         FROM unnest($3::integer[], $4::bigint[])
           AS plan(part_number, expected_size_bytes)`,
        [input.uploadId, input.projectId, partNumbers, partSizes],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getMultipartPartPlan(
    projectId: string,
    uploadId: string,
  ): Promise<Array<{ partNumber: number; sizeBytes: number }>> {
    const result = await this.database.query(
      `SELECT part_number, expected_size_bytes
       FROM multipart_upload_parts
       WHERE upload_id = $1 AND project_id = $2
       ORDER BY part_number`,
      [uploadId, projectId],
    );
    return result.rows.map((row) => ({
      partNumber: Number(row.part_number),
      sizeBytes: Number(row.expected_size_bytes),
    }));
  }

  async getRecordedMultipartParts(
    projectId: string,
    uploadId: string,
  ): Promise<Array<{ partNumber: number; etag: string }>> {
    const result = await this.database.query(
      `SELECT part_number, etag
       FROM multipart_upload_parts
       WHERE upload_id = $1 AND project_id = $2
         AND status = 'uploaded' AND etag IS NOT NULL
       ORDER BY part_number`,
      [uploadId, projectId],
    );
    return result.rows.map((row) => ({
      partNumber: Number(row.part_number),
      etag: String(row.etag),
    }));
  }

  async markMultipartUploading(projectId: string, uploadId: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE media_uploads
       SET status = 'uploading'
       WHERE id = $1 AND project_id = $2
         AND upload_strategy = 'multipart'
         AND status IN ('multipart_initiated', 'uploading')
       RETURNING id`,
      [uploadId, projectId],
    );
    if (!result.rowCount) {
      throw new AppError(409, "multipart_upload_state_invalid", "分片上传状态无效。");
    }
  }

  async markMultipartCompleting(projectId: string, uploadId: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE media_uploads
       SET status = 'completing'
       WHERE id = $1 AND project_id = $2
         AND upload_strategy = 'multipart'
         AND status IN ('multipart_initiated', 'uploading', 'completing')
       RETURNING id`,
      [uploadId, projectId],
    );
    if (!result.rowCount) {
      throw new AppError(409, "multipart_upload_state_invalid", "分片上传状态无效。");
    }
  }

  async recordMultipartParts(input: {
    projectId: string;
    uploadId: string;
    parts: Array<{ partNumber: number; sizeBytes: number; etag: string }>;
  }): Promise<void> {
    const payload = input.parts.map((part) => ({
      part_number: part.partNumber,
      actual_size_bytes: part.sizeBytes,
      etag: part.etag,
    }));
    const result = await this.database.query(
      `UPDATE multipart_upload_parts AS stored
       SET status = 'uploaded',
           actual_size_bytes = incoming.actual_size_bytes,
           etag = incoming.etag,
           uploaded_at = now()
       FROM jsonb_to_recordset($3::jsonb)
         AS incoming(part_number integer, actual_size_bytes bigint, etag text)
       WHERE stored.upload_id = $1
         AND stored.project_id = $2
         AND stored.part_number = incoming.part_number`,
      [input.uploadId, input.projectId, JSON.stringify(payload)],
    );
    if (result.rowCount !== input.parts.length) {
      throw new AppError(409, "multipart_part_record_mismatch", "分片上传记录不完整。");
    }
  }

  async finishMultipartUploadState(
    projectId: string,
    uploadId: string,
    status: "failed" | "aborted",
  ): Promise<void> {
    await this.database.query(
      `UPDATE media_uploads
       SET status = $3, completed_at = now()
       WHERE id = $1 AND project_id = $2
         AND upload_strategy = 'multipart'
         AND status NOT IN ('uploaded', 'verified')`,
      [uploadId, projectId, status],
    );
    await this.database.query(
      `UPDATE projects
       SET status = 'created', stage = $2, progress = 0, updated_at = now()
       WHERE id = $1 AND status = 'uploading'`,
      [projectId, status === "aborted" ? "upload_aborted" : "upload_failed"],
    );
  }

  async getUpload(
    projectId: string,
    uploadId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.database.query(
      `SELECT * FROM media_uploads WHERE id = $1 AND project_id = $2`,
      [uploadId, projectId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new AppError(404, "upload_not_found", "上传记录不存在。");
    return row;
  }

  async completeUpload(input: {
    projectId: string;
    uploadId: string;
    actualSizeBytes: number;
    etag: string | null;
  }): Promise<void> {
    const result = await this.database.query(
      `UPDATE media_uploads
       SET status = 'uploaded', actual_size_bytes = $3, etag = $4,
           completed_at = now()
       WHERE id = $1 AND project_id = $2
         AND (
           (upload_strategy = 'single' AND status = 'presigned')
           OR (upload_strategy = 'multipart' AND status = 'completing')
         )
       RETURNING id`,
      [input.uploadId, input.projectId, input.actualSizeBytes, input.etag],
    );
    if (!result.rowCount) {
      throw new AppError(409, "upload_completion_state_invalid", "上传完成状态无效。");
    }
    await this.database.query(
      `UPDATE projects
       SET status = 'created', stage = 'uploaded', progress = 0, updated_at = now()
       WHERE id = $1`,
      [input.projectId],
    );
  }

  async createJob(input: {
    projectId: string;
    uploadId: string;
    subtitleUploadId?: string;
  }): Promise<JobApi> {
    const upload = await this.getUpload(input.projectId, input.uploadId);
    if ((upload.upload_purpose ?? "source_video") !== "source_video") {
      throw new AppError(409, "source_upload_required", "只能使用已校验的原片启动分析。");
    }
    if (upload.status !== "uploaded" && upload.status !== "verified") {
      throw new AppError(409, "upload_not_complete", "原片尚未完成上传校验。");
    }
    if (input.subtitleUploadId) {
      const subtitle = await this.getUpload(input.projectId, input.subtitleUploadId);
      if (
        subtitle.upload_purpose !== "subtitle_srt"
        || !["uploaded", "verified"].includes(String(subtitle.status))
      ) {
        throw new AppError(409, "subtitle_upload_not_complete", "SRT 字幕尚未完成上传校验。");
      }
    }
    if (!await this.hasRecentWorkerHeartbeat()) {
      throw new AppError(
        503,
        "worker_unavailable",
        "后台处理服务暂不可用，请稍后重试。",
        { expose: true },
      );
    }
    try {
      const result = await this.database.query(
        `INSERT INTO processing_jobs(project_id, upload_id, subtitle_upload_id, transcript_source, max_attempts)
         VALUES($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          input.projectId,
          input.uploadId,
          input.subtitleUploadId ?? null,
          input.subtitleUploadId ? "uploaded_srt" : "automatic_asr",
          this.config.worker.maxAttempts,
        ],
      );
      await this.database.query(
        `UPDATE projects
         SET status = 'queued', stage = 'queued', progress = 0,
             clip_count = 0, error_public = NULL, updated_at = now()
         WHERE id = $1`,
        [input.projectId],
      );
      return mapJob(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        const existing = await this.database.query(
          `SELECT * FROM processing_jobs
           WHERE project_id = $1 AND status IN ('queued', 'running', 'retrying')
           ORDER BY created_at DESC LIMIT 1`,
          [input.projectId],
        );
        const row = existing.rows[0] as Record<string, unknown> | undefined;
        if (row) return mapJob(row);
      }
      throw error;
    }
  }

  async getJobEvents(
    jobId: string,
    afterId = 0,
  ): Promise<Array<{
    id: number;
    stage: string;
    progress: number;
    message: string;
    createdAt: string;
  }>> {
    await this.getJob(jobId);
    const result = await this.database.query(
      `SELECT id, stage, progress, message, created_at
       FROM job_events
       WHERE job_id = $1 AND id > $2
       ORDER BY id ASC
       LIMIT 100`,
      [jobId, afterId],
    );
    return result.rows.map((row) => ({
      id: numberValue(row.id),
      stage: String(row.stage),
      progress: numberValue(row.progress),
      message: String(row.message),
      createdAt: isoValue(row.created_at),
    }));
  }

  async getJob(jobId: string): Promise<JobApi> {
    const result = await this.database.query(
      "SELECT * FROM processing_jobs WHERE id = $1",
      [jobId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new AppError(404, "job_not_found", "处理任务不存在。");
    return mapJob(row);
  }

  async listCandidates(projectId: string): Promise<Array<{
    payload: CandidatePayload;
    previewObjectKey: string | null;
  }>> {
    await this.getProject(projectId);
    const result = await this.database.query(
      `SELECT c.payload, c.preview_object_key, c.revision_object_key,
              c.review_status, c.render_status,
              latest_render.id AS latest_render_id
       FROM candidates c
       LEFT JOIN LATERAL (
         SELECT id
         FROM candidate_renders
         WHERE candidate_id = c.id AND status = 'succeeded'
         ORDER BY finished_at DESC
         LIMIT 1
       ) latest_render ON true
       WHERE c.project_id = $1
       ORDER BY c.ordinal`,
      [projectId],
    );
    return result.rows.map((row) => {
      const payload = row.payload as CandidatePayload;
      const renderStatus = row.render_status as CandidateRenderStatus;
      const useRevision = row.revision_object_key !== null;
      const reviewStatus = row.review_status as CandidateReviewStatus;
      return {
        payload: {
          ...payload,
          previewUrl: null,
          reviewStatus,
          renderStatus,
          previewKind: useRevision ? "revised_cut" : "rough_cut",
          previewVersion: useRevision
            ? String(row.latest_render_id)
            : `rough_${sha256Hex(String(row.preview_object_key)).slice(0, 24)}`,
          isFinal: useRevision
            && renderStatus === "revision_ready"
            && reviewStatus === "human_av_verified_normal_playback",
        },
        previewObjectKey:
          useRevision
            ? String(row.revision_object_key)
            : row.preview_object_key === null ? null : String(row.preview_object_key),
      };
    });
  }

  async getCandidate(candidateId: string): Promise<{
    payload: CandidatePayload;
    projectId: string;
    uploadId: string;
    previewObjectKey: string | null;
  }> {
    const result = await this.database.query(
      `SELECT c.project_id, j.upload_id, c.payload, c.preview_object_key,
              c.revision_object_key, c.review_status, c.render_status,
              latest_render.id AS latest_render_id
       FROM candidates c
       JOIN processing_jobs j ON j.id = c.job_id
       LEFT JOIN LATERAL (
         SELECT id
         FROM candidate_renders
         WHERE candidate_id = c.id AND status = 'succeeded'
         ORDER BY finished_at DESC
         LIMIT 1
       ) latest_render ON true
       WHERE c.id = $1`,
      [candidateId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new AppError(404, "candidate_not_found", "候选切片不存在。");
    const renderStatus = row.render_status as CandidateRenderStatus;
    const reviewStatus = row.review_status as CandidateReviewStatus;
    const useRevision = row.revision_object_key !== null;
    return {
      payload: {
        ...(row.payload as CandidatePayload),
        previewUrl: null,
        reviewStatus,
        renderStatus,
        previewKind: useRevision ? "revised_cut" : "rough_cut",
        previewVersion: useRevision
          ? String(row.latest_render_id)
          : `rough_${sha256Hex(String(row.preview_object_key)).slice(0, 24)}`,
        isFinal: useRevision
          && renderStatus === "revision_ready"
          && reviewStatus === "human_av_verified_normal_playback",
      },
      projectId: String(row.project_id),
      uploadId: String(row.upload_id),
      previewObjectKey:
        useRevision
          ? String(row.revision_object_key)
          : row.preview_object_key === null ? null : String(row.preview_object_key),
    };
  }

  async createFeedback(input: {
    candidateId: string;
    decision: "approve" | "reject" | "adjust" | "note";
    submittedBy: string;
    payload: Record<string, unknown>;
    renderSpec?: CandidateRenderSpec;
    avConfirmed: boolean;
    reviewedPreviewVersion?: string;
  }): Promise<{
    id: string;
    createdAt: string;
    reviewStatus: CandidateReviewStatus;
    renderStatus: CandidateRenderStatus;
  }> {
    const candidate = await this.getCandidate(input.candidateId);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO candidate_feedback(
           candidate_id, project_id, decision, submitted_by, payload
         )
         VALUES($1, $2, $3, $4, $5)
         RETURNING id, created_at`,
        [
          input.candidateId,
          candidate.projectId,
          input.decision,
          input.submittedBy,
          input.payload,
        ],
      );
      const row = result.rows[0] as Record<string, unknown>;
      const feedbackId = String(row.id);
      let reviewStatus: CandidateReviewStatus = candidate.payload.reviewStatus;
      let renderStatus: CandidateRenderStatus = candidate.payload.renderStatus;
      const locked = await client.query(
        `SELECT c.render_status, c.revision_object_key,
                latest_render.id AS latest_render_id
         FROM candidates c
         LEFT JOIN LATERAL (
           SELECT id
           FROM candidate_renders
           WHERE candidate_id = c.id AND status = 'succeeded'
           ORDER BY finished_at DESC
           LIMIT 1
         ) latest_render ON true
         WHERE c.id = $1
         FOR UPDATE OF c`,
        [input.candidateId],
      );
      const lockedCandidate = locked.rows[0] as Record<string, unknown>;

      if (input.decision === "reject") {
        reviewStatus = "human_review_rejected";
      } else if (input.decision === "adjust") {
        reviewStatus = "human_review_needs_changes";
      }

      if (input.avConfirmed) {
        if (
          input.decision !== "approve"
          || lockedCandidate.render_status !== "revision_ready"
          || lockedCandidate.revision_object_key === null
          || typeof input.reviewedPreviewVersion !== "string"
          || input.reviewedPreviewVersion !== String(lockedCandidate.latest_render_id)
        ) {
          throw new AppError(
            409,
            "av_confirmation_stale_or_unrendered",
            "只能在完整播放当前重渲染版本后确认音画；版本变化后必须重新播放。",
          );
        }
        reviewStatus = "human_av_verified_normal_playback";
      }

      if (
        (input.decision === "approve" || input.decision === "adjust")
        && input.renderSpec
        && !input.avConfirmed
      ) {
        const existing = await client.query(
          `SELECT id FROM candidate_renders
           WHERE candidate_id = $1
             AND status IN ('queued', 'running', 'retrying')
           FOR UPDATE`,
          [input.candidateId],
        );
        if (existing.rowCount) {
          throw new AppError(
            409,
            "candidate_render_in_progress",
            "该候选已有重渲染任务正在进行。",
          );
        }
        await client.query(
          `INSERT INTO candidate_renders(
             candidate_id, project_id, upload_id, feedback_id,
             max_attempts, render_spec, approval_target
           )
           VALUES($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.candidateId,
            candidate.projectId,
            candidate.uploadId,
            feedbackId,
            this.config.worker.maxAttempts,
            input.renderSpec,
            false,
          ],
        );
        renderStatus = "revision_queued";
      }

      await client.query(
        `UPDATE candidates
         SET review_status = $2, render_status = $3,
             latest_feedback_id = $4, updated_at = now()
         WHERE id = $1`,
        [input.candidateId, reviewStatus, renderStatus, feedbackId],
      );
      await client.query("COMMIT");
      return {
        id: feedbackId,
        createdAt: isoValue(row.created_at),
        reviewStatus,
        renderStatus,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimJob(workerId: string): Promise<ClaimedJob | null> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `WITH claimable AS (
           SELECT j.id
           FROM processing_jobs j
           WHERE (
             j.status IN ('queued', 'retrying') AND j.available_at <= now()
           ) OR (
             j.status = 'running' AND j.lease_expires_at < now()
           )
           ORDER BY j.created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE processing_jobs j
         SET status = 'running',
             stage = CASE WHEN j.stage = 'queued' THEN 'starting' ELSE j.stage END,
             attempt = j.attempt + 1,
             worker_id = $1,
             lease_expires_at = now() + ($2 * interval '1 second'),
             started_at = COALESCE(j.started_at, now()),
             updated_at = now()
         FROM claimable
         WHERE j.id = claimable.id
         RETURNING j.*`,
        [workerId, this.config.worker.leaseSeconds],
      );
      if (!result.rowCount) {
        await client.query("COMMIT");
        return null;
      }
      const row = result.rows[0] as Record<string, unknown>;
      const joined = await client.query(
        `SELECT
           j.id, j.project_id, j.upload_id, j.subtitle_upload_id, j.transcript_source,
           j.attempt, j.max_attempts,
           u.object_key, u.source_name, u.expected_size_bytes, u.expected_sha256,
           s.object_key AS subtitle_object_key, s.source_name AS subtitle_source_name,
           p.mode, p.editor_mode
         FROM processing_jobs j
         JOIN media_uploads u ON u.id = j.upload_id
         LEFT JOIN media_uploads s ON s.id = j.subtitle_upload_id
         JOIN projects p ON p.id = j.project_id
         WHERE j.id = $1`,
        [row.id],
      );
      await client.query(
        `UPDATE projects
         SET status = 'processing', stage = 'starting', progress = 1,
             error_public = NULL, updated_at = now()
         WHERE id = $1`,
        [row.project_id],
      );
      await client.query("COMMIT");
      const item = joined.rows[0] as Record<string, unknown>;
      return {
        id: String(item.id),
        workerId,
        projectId: String(item.project_id),
        uploadId: String(item.upload_id),
        objectKey: String(item.object_key),
        sourceName: String(item.source_name),
        subtitleUploadId: item.subtitle_upload_id === null ? null : String(item.subtitle_upload_id),
        subtitleObjectKey: item.subtitle_object_key === null ? null : String(item.subtitle_object_key),
        subtitleSourceName: item.subtitle_source_name === null ? null : String(item.subtitle_source_name),
        transcriptSource: (item.transcript_source ?? "automatic_asr") as ClaimedJob["transcriptSource"],
        expectedSizeBytes: numberValue(item.expected_size_bytes),
        expectedSha256:
          item.expected_sha256 === null ? null : String(item.expected_sha256),
        mode: item.mode as TianClipMode,
        editorMode: (item.editor_mode ?? "compare") as EditorialModelMode,
        attempt: numberValue(item.attempt),
        maxAttempts: numberValue(item.max_attempts),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(jobId: string, workerId: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE processing_jobs
       SET lease_expires_at = now() + ($3 * interval '1 second'), updated_at = now()
       WHERE id = $1 AND worker_id = $2 AND status = 'running'
         AND lease_expires_at > now()
       RETURNING id`,
      [jobId, workerId, this.config.worker.leaseSeconds],
    );
    if (!result.rowCount) {
      throw new AppError(409, "job_lease_lost", "任务租约已经失效。", { expose: false });
    }
  }

  async markUploadVerified(input: {
    jobId: string;
    workerId: string;
    uploadId: string;
    actualSizeBytes: number;
    actualSha256: string;
  }): Promise<void> {
    const result = await this.database.query(
      `UPDATE media_uploads u
       SET status = 'verified', actual_size_bytes = $2, actual_sha256 = $3
       WHERE u.id = $1
         AND EXISTS (
           SELECT 1
           FROM processing_jobs j
           WHERE j.id = $4 AND j.upload_id = u.id
             AND j.worker_id = $5 AND j.status = 'running'
             AND j.lease_expires_at > now()
         )
       RETURNING u.id`,
      [
        input.uploadId,
        input.actualSizeBytes,
        input.actualSha256,
        input.jobId,
        input.workerId,
      ],
    );
    if (!result.rowCount) {
      throw new AppError(409, "job_lease_lost", "任务租约已经失效。", { expose: false });
    }
  }

  async claimRender(workerId: string): Promise<ClaimedRender | null> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `WITH claimable AS (
           SELECT id
           FROM candidate_renders
           WHERE (
             status IN ('queued', 'retrying') AND available_at <= now()
           ) OR (
             status = 'running' AND lease_expires_at < now()
           )
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE candidate_renders r
         SET status = 'running', attempt = r.attempt + 1,
             worker_id = $1,
             lease_expires_at = now() + ($2 * interval '1 second'),
             started_at = COALESCE(r.started_at, now()),
             updated_at = now()
         FROM claimable
         WHERE r.id = claimable.id
         RETURNING r.*`,
        [workerId, this.config.worker.leaseSeconds],
      );
      if (!result.rowCount) {
        await client.query("COMMIT");
        return null;
      }
      const row = result.rows[0] as Record<string, unknown>;
      const joined = await client.query(
        `SELECT r.*, u.object_key, c.payload
         FROM candidate_renders r
         JOIN media_uploads u ON u.id = r.upload_id
         JOIN candidates c ON c.id = r.candidate_id
         WHERE r.id = $1`,
        [row.id],
      );
      await client.query(
        `UPDATE candidates SET render_status = 'revision_rendering',
             updated_at = now()
         WHERE id = $1`,
        [row.candidate_id],
      );
      await client.query("COMMIT");
      const item = joined.rows[0] as Record<string, unknown>;
      return {
        id: String(item.id),
        workerId,
        candidateId: String(item.candidate_id),
        projectId: String(item.project_id),
        uploadId: String(item.upload_id),
        objectKey: String(item.object_key),
        spec: item.render_spec as CandidateRenderSpec,
        approvalTarget: Boolean(item.approval_target),
        attempt: numberValue(item.attempt),
        maxAttempts: numberValue(item.max_attempts),
        payload: item.payload as CandidatePayload,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeatRender(renderId: string, workerId: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE candidate_renders
       SET lease_expires_at = now() + ($3 * interval '1 second'),
           updated_at = now()
       WHERE id = $1 AND worker_id = $2 AND status = 'running'
         AND lease_expires_at > now()
       RETURNING id`,
      [renderId, workerId, this.config.worker.leaseSeconds],
    );
    if (!result.rowCount) {
      throw new AppError(409, "render_lease_lost", "重渲染任务租约已经失效。", {
        expose: false,
      });
    }
  }

  async completeRender(
    render: ClaimedRender,
    outputObjectKey: string,
    revisedPayload: CandidatePayload,
  ): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const completed = await client.query(
        `UPDATE candidate_renders
         SET status = 'succeeded', output_object_key = $2,
             lease_expires_at = NULL, worker_id = NULL,
             finished_at = now(), updated_at = now()
         WHERE id = $1 AND worker_id = $3 AND status = 'running'
           AND lease_expires_at > now()
         RETURNING candidate_id`,
        [render.id, outputObjectKey, render.workerId],
      );
      if (!completed.rowCount) {
        throw new AppError(409, "render_lease_lost", "重渲染任务租约已经失效。", {
          expose: false,
        });
      }
      await client.query(
        `UPDATE candidates
         SET revision_object_key = $2, render_status = 'revision_ready',
             payload = $3,
             updated_at = now()
         WHERE id = $1`,
        [render.candidateId, outputObjectKey, revisedPayload],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async failOrRetryRender(render: ClaimedRender, internalMessage: string): Promise<boolean> {
    const retry = render.attempt < render.maxAttempts;
    const delaySeconds = Math.min(30 * 2 ** Math.max(render.attempt - 1, 0), 900);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE candidate_renders
         SET status = $2,
             available_at = CASE
               WHEN $2 = 'retrying' THEN now() + ($3 * interval '1 second')
               ELSE available_at
             END,
             error_internal = $4, lease_expires_at = NULL, worker_id = NULL,
             finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END,
             updated_at = now()
         WHERE id = $1 AND worker_id = $5 AND status = 'running'
           AND lease_expires_at > now()
         RETURNING candidate_id`,
        [
          render.id,
          retry ? "retrying" : "failed",
          delaySeconds,
          internalMessage,
          render.workerId,
        ],
      );
      if (!updated.rowCount) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `UPDATE candidates
         SET render_status = $2, updated_at = now()
         WHERE id = $1`,
        [render.candidateId, retry ? "revision_queued" : "render_failed"],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateJobStage(
    jobId: string,
    workerId: string,
    stage: string,
    progress: number,
    message: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE processing_jobs
         SET stage = $2, progress = $3, updated_at = now()
         WHERE id = $1 AND worker_id = $4 AND status = 'running'
           AND lease_expires_at > now()
         RETURNING project_id`,
        [jobId, stage, progress, workerId],
      );
      const row = updated.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        throw new AppError(409, "job_lease_lost", "任务租约已经失效。", {
          expose: false,
        });
      }
      await client.query(
        `UPDATE projects
         SET stage = $2, progress = $3, updated_at = now()
         WHERE id = $1`,
        [row.project_id, stage, progress],
      );
      await client.query(
        `INSERT INTO job_events(job_id, stage, progress, message, detail)
         VALUES($1, $2, $3, $4, $5)`,
        [jobId, stage, progress, message, detail],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Appends one billing row. Written per stage rather than once at the end so
   * a job that fails midway still reports the spend it already incurred.
   *
   * Cost recording must never sink a job that otherwise succeeded, so the
   * caller is expected to treat a throw here as non-fatal.
   */
  async recordCostEntry(
    job: { id: string; projectId: string },
    entry: CostEntry,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO job_cost_entries(
         job_id, project_id, stage, provider, model, priced, cost_cny,
         unpriced_reason, input_tokens, output_tokens, cached_input_tokens,
         billed_seconds, rate_source, rate_checked_on, usd_to_cny)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        job.id,
        job.projectId,
        entry.stage,
        entry.provider,
        entry.model,
        entry.priced,
        entry.costCny,
        entry.unpricedReason,
        Math.trunc(entry.inputTokens),
        Math.trunc(entry.outputTokens),
        Math.trunc(entry.cachedInputTokens),
        entry.billedSeconds,
        entry.rateSource,
        entry.rateCheckedOn,
        entry.usdToCny,
      ],
    );
  }

  /**
   * Records what the job actually delivered. Cost per second is meaningless
   * without it, and it must come from the rendered rough cuts rather than the
   * source length, because a five-hour livestream and a one-hour livestream
   * only become comparable once divided by their own output.
   */
  async recordDeliveredOutput(
    jobId: string,
    delivered: { clipSeconds: number; sourceMediaSeconds: number },
  ): Promise<void> {
    await this.database.query(
      `UPDATE processing_jobs
       SET delivered_clip_seconds = $2,
           source_media_seconds = $3,
           updated_at = now()
       WHERE id = $1`,
      [jobId, delivered.clipSeconds, delivered.sourceMediaSeconds],
    );
  }

  async getJobCostSummary(jobId: string): Promise<JobCostSummary> {
    const job = await this.database.query(
      `SELECT clip_count, delivered_clip_seconds, source_media_seconds
       FROM processing_jobs WHERE id = $1`,
      [jobId],
    );
    const jobRow = job.rows[0] as Record<string, unknown> | undefined;
    if (!jobRow) {
      throw new AppError(404, "job_not_found", "任务不存在。", { expose: true });
    }
    const rows = await this.database.query(
      `SELECT stage, provider, model, priced, cost_cny, unpriced_reason,
              input_tokens, output_tokens, cached_input_tokens, billed_seconds,
              rate_source, rate_checked_on, usd_to_cny
       FROM job_cost_entries
       WHERE job_id = $1
       ORDER BY id`,
      [jobId],
    );
    const entries: CostEntry[] = rows.rows.map((row: Record<string, unknown>) => ({
      stage: String(row.stage) as CostEntry["stage"],
      provider: String(row.provider),
      model: String(row.model),
      priced: Boolean(row.priced),
      costCny: row.cost_cny === null ? null : numberValue(row.cost_cny),
      unpricedReason: row.unpriced_reason === null
        ? null
        : String(row.unpriced_reason),
      inputTokens: numberValue(row.input_tokens),
      outputTokens: numberValue(row.output_tokens),
      cachedInputTokens: numberValue(row.cached_input_tokens),
      billedSeconds: row.billed_seconds === null
        ? null
        : numberValue(row.billed_seconds),
      rateSource: row.rate_source === null ? null : String(row.rate_source),
      rateCheckedOn: row.rate_checked_on === null
        ? null
        : String(row.rate_checked_on),
      usdToCny: numberValue(row.usd_to_cny),
    }));
    return summarizeJobCost(entries, {
      clipSeconds: numberValue(jobRow.delivered_clip_seconds),
      clipCount: numberValue(jobRow.clip_count),
      sourceMediaSeconds: numberValue(jobRow.source_media_seconds),
    });
  }

  async storeCandidates(
    job: ClaimedJob,
    candidates: CandidatePayload[],
    core: { version: string; sha256: string },
    result: Record<string, unknown>,
  ): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const lease = await client.query(
        `SELECT project_id
         FROM processing_jobs
         WHERE id = $1 AND worker_id = $2 AND status = 'running'
           AND lease_expires_at > now()
         FOR UPDATE`,
        [job.id, job.workerId],
      );
      if (!lease.rowCount) {
        throw new AppError(409, "job_lease_lost", "任务租约已经失效。", {
          expose: false,
        });
      }
      await client.query("DELETE FROM candidates WHERE job_id = $1", [job.id]);
      for (const [index, candidate] of candidates.entries()) {
        await client.query(
          `INSERT INTO candidates(
             id, project_id, job_id, ordinal, source_start_ms, source_end_ms,
             score, priority, review_status, payload, preview_object_key
           )
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            candidate.id,
            job.projectId,
            job.id,
            index + 1,
            Math.round(candidate.sourceStart * 1_000),
            Math.round(candidate.sourceEnd * 1_000),
            candidate.score,
            candidate.priority,
            candidate.reviewStatus,
            candidate,
            `previews/${job.projectId}/${candidate.id}.mp4`,
          ],
        );
      }
      const completed = await client.query(
        `UPDATE processing_jobs
         SET status = 'succeeded', stage = 'review_ready', progress = 100,
             clip_count = $2, core_version = $3, core_sha256 = $4,
             result = $5, finished_at = now(), lease_expires_at = NULL,
             worker_id = NULL,
             updated_at = now()
         WHERE id = $1 AND worker_id = $6 AND status = 'running'
           AND lease_expires_at > now()
         RETURNING project_id`,
        [
          job.id,
          candidates.length,
          core.version,
          core.sha256,
          result,
          job.workerId,
        ],
      );
      if (!completed.rowCount) {
        throw new AppError(409, "job_lease_lost", "任务租约已经失效。", {
          expose: false,
        });
      }
      await client.query(
        `UPDATE projects
         SET status = 'review_ready', stage = 'review_ready', progress = 100,
             clip_count = $2, core_version = $3, core_sha256 = $4,
             error_public = NULL, updated_at = now()
         WHERE id = $1`,
        [job.projectId, candidates.length, core.version, core.sha256],
      );
      await client.query(
        `UPDATE media_uploads SET status = 'verified' WHERE id = $1`,
        [job.uploadId],
      );
      await client.query(
        `INSERT INTO job_events(job_id, stage, progress, message, detail)
         VALUES($1, 'review_ready', 100, $2, $3)`,
        [
          job.id,
          `发现 ${candidates.length} 条自然候选，等待团队检阅。`,
          { candidateCount: candidates.length, core },
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Publishes one playable rough cut while the rest of the livestream is still
   * being reviewed. This deliberately does not mark the job as succeeded: the
   * worker can keep refining every remaining candidate, while the review UI
   * sees clip_count grow 1, 2, 3... instead of waiting behind an all-or-nothing
   * batch barrier.
   */
  async publishCandidate(
    job: ClaimedJob,
    candidate: CandidatePayload,
    ordinal: number,
  ): Promise<number> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const lease = await client.query(
        `SELECT project_id
         FROM processing_jobs
         WHERE id = $1 AND worker_id = $2 AND status = 'running'
           AND lease_expires_at > now()
         FOR UPDATE`,
        [job.id, job.workerId],
      );
      if (!lease.rowCount) {
        throw new AppError(409, "job_lease_lost", "任务租约已经失效。", {
          expose: false,
        });
      }
      const previewObjectKey =
        `previews/${job.projectId}/${candidate.id}.mp4`;
      // Final refinement may reorder or reject provisional candidates. Free
      // the target ordinal before the stable-id upsert so streaming delivery
      // never trips the (job_id, ordinal) uniqueness constraint.
      await client.query(
        `DELETE FROM candidates
         WHERE job_id = $1 AND ordinal = $2 AND id <> $3`,
        [job.id, ordinal, candidate.id],
      );
      await client.query(
        `INSERT INTO candidates(
           id, project_id, job_id, ordinal, source_start_ms, source_end_ms,
           score, priority, review_status, render_status, payload,
           preview_object_key
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, 'rough_ready', $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           ordinal = EXCLUDED.ordinal,
           source_start_ms = EXCLUDED.source_start_ms,
           source_end_ms = EXCLUDED.source_end_ms,
           score = EXCLUDED.score,
           priority = EXCLUDED.priority,
           review_status = EXCLUDED.review_status,
           render_status = 'rough_ready',
           payload = EXCLUDED.payload,
           preview_object_key = EXCLUDED.preview_object_key,
           updated_at = now()`,
        [
          candidate.id,
          job.projectId,
          job.id,
          ordinal,
          Math.round(candidate.sourceStart * 1_000),
          Math.round(candidate.sourceEnd * 1_000),
          candidate.score,
          candidate.priority,
          candidate.reviewStatus,
          candidate,
          previewObjectKey,
        ],
      );
      const counted = await client.query(
        `SELECT count(*)::integer AS count
         FROM candidates WHERE job_id = $1`,
        [job.id],
      );
      const candidateCount = numberValue(counted.rows[0]?.count);
      await client.query(
        `UPDATE processing_jobs
         SET clip_count = $2, updated_at = now()
         WHERE id = $1`,
        [job.id, candidateCount],
      );
      await client.query(
        `UPDATE projects
         SET clip_count = $2, updated_at = now()
         WHERE id = $1`,
        [job.projectId, candidateCount],
      );
      await client.query(
        `INSERT INTO job_events(job_id, stage, progress, message, detail)
         SELECT id, stage, progress, $2, $3
         FROM processing_jobs WHERE id = $1`,
        [
          job.id,
          `第 ${candidateCount} 条可播放粗剪已交付，后台继续处理剩余内容。`,
          {
            candidateId: candidate.id,
            candidateCount,
            progressiveDelivery: true,
          },
        ],
      );
      await client.query("COMMIT");
      return candidateCount;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async failOrRetryJob(
    job: ClaimedJob,
    publicMessage: string,
    internalMessage: string,
    retryable = true,
  ): Promise<boolean> {
    const retry = retryable && job.attempt < job.maxAttempts;
    const delaySeconds = Math.min(30 * 2 ** Math.max(job.attempt - 1, 0), 900);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE processing_jobs
         SET status = $2,
             stage = $3,
             progress = CASE WHEN $2 = 'retrying' THEN progress ELSE 100 END,
             available_at = CASE
               WHEN $2 = 'retrying' THEN now() + ($4 * interval '1 second')
               ELSE available_at
             END,
             error_public = $5,
             error_internal = $6,
             lease_expires_at = NULL,
             worker_id = NULL,
             finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END,
             updated_at = now()
         WHERE id = $1 AND worker_id = $7 AND status = 'running'
           AND lease_expires_at > now()
         RETURNING project_id`,
        [
          job.id,
          retry ? "retrying" : "failed",
          retry ? "retry_wait" : "failed",
          delaySeconds,
          publicMessage,
          internalMessage,
          job.workerId,
        ],
      );
      if (!updated.rowCount) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `UPDATE projects
         SET status = $2,
             stage = $3,
             progress = CASE WHEN $2 = 'queued' THEN progress ELSE 100 END,
             error_public = $4,
             updated_at = now()
         WHERE id = $1`,
        [
          job.projectId,
          retry ? "queued" : "failed",
          retry ? "retry_wait" : "failed",
          publicMessage,
        ],
      );
      await client.query(
        `INSERT INTO job_events(job_id, stage, progress, message, detail)
         SELECT id, stage, progress, $2, $3 FROM processing_jobs WHERE id = $1`,
        [
          job.id,
          retry ? "处理失败，系统将自动重试。" : "处理失败，已停止自动重试。",
          { attempt: job.attempt, maxAttempts: job.maxAttempts, delaySeconds },
        ],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async cleanupExpiredGuards(): Promise<void> {
    await Promise.all([
      this.database.query("DELETE FROM internal_request_nonces WHERE expires_at < now()"),
      this.database.query("DELETE FROM idempotency_records WHERE expires_at < now()"),
    ]);
  }

  requestHash(body: unknown): string {
    return sha256Hex(JSON.stringify(body ?? null));
  }
}

export type Queryable = Pick<pg.Pool, "query">;
