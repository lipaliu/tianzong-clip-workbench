import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical.js";
import type { ProcessorConfig } from "./config.js";
import { AppError } from "./errors.js";
import {
  buildMultipartPartPlan,
  normalizeMultipartEtag,
} from "./multipart.js";
import type { ProcessorRepository } from "./repository.js";
import { deriveKeptRanges } from "./revision-render.js";
import type { PrivateObjectStorage } from "./storage.js";

declare module "fastify" {
  interface FastifyRequest {
    internalKeyId?: string;
    internalActor?: string;
  }
}

const uuid = z.string().uuid();
const projectBody = z.object({
  id: uuid.optional(),
  title: z.string().trim().min(1).max(200),
  projectDate: z.iso.date(),
  sourceName: z.string().trim().min(1).max(500),
  mode: z.enum(["聊播", "带货"]),
  editorMode: z.enum([
    "openai",
    "doubao",
    "kimi",
    "compare",
    "compare_all",
  ]).default("compare"),
}).strict();

const uploadBody = z.object({
  sourceName: z.string().trim().min(1).max(500),
  contentType: z.enum(["video/mp4", "video/quicktime"]),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

const multipartPartsBody = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.partNumbers).size !== value.partNumbers.length) {
    context.addIssue({
      code: "custom",
      path: ["partNumbers"],
      message: "partNumbers must be unique",
    });
  }
});

const multipartCompleteBody = z.object({
  parts: z.array(z.object({
    partNumber: z.number().int().min(1).max(10_000),
    etag: z.string().trim().min(1).max(200),
  }).strict()).min(2).max(10_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.parts.map((part) => part.partNumber)).size !== value.parts.length) {
    context.addIssue({
      code: "custom",
      path: ["parts"],
      message: "part numbers must be unique",
    });
  }
});

type UploadPresignPayload =
  | {
      uploadId: string;
      objectKey: string;
      putUrl: string;
      requiredHeaders: Record<string, string>;
      expiresIn: number;
      upload: {
        id: string;
        projectId: string;
        status: "presigned";
        strategy: "single";
        objectKey: string;
        putUrl: string;
        requiredHeaders: Record<string, string>;
        expiresIn: number;
      };
    }
  | {
      uploadId: string;
      objectKey: string;
      upload: {
        id: string;
        projectId: string;
        status: "multipart_initiated";
        strategy: "multipart";
        objectKey: string;
        partSizeBytes: number;
        partCount: number;
        expiresIn: number;
      };
    };

const jobBody = z.object({
  uploadId: uuid,
}).strict();

const feedbackBody = z.object({
  decision: z.enum(["approve", "reject", "adjust", "note"]),
  trim: z.object({
    sourceStart: z.number().nonnegative(),
    sourceEnd: z.number().positive(),
  }).refine((value) => value.sourceEnd > value.sourceStart, {
    message: "sourceEnd must be greater than sourceStart",
  }).optional(),
  transcriptDecisions: z.array(z.object({
    lineId: z.string().min(1),
    decision: z.enum(["keep", "remove"]),
    reason: z.string().max(2_000).optional(),
  }).strict()).max(5_000).optional(),
  title: z.string().max(300).optional(),
  notes: z.string().max(10_000).optional(),
  avConfirmed: z.object({
    normalPlaybackConfirmed: z.literal(true),
    audioVideoSyncConfirmed: z.literal(true),
    reviewedWholeProxy: z.literal(true),
    reviewedPreviewVersion: z.string().min(8).max(200),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.avConfirmed && value.decision !== "approve") {
    context.addIssue({
      code: "custom",
      path: ["avConfirmed"],
      message: "Only an explicit approval can confirm normal-playback AV review",
    });
  }
  const changesMedia = value.trim !== undefined
    || (value.transcriptDecisions?.some((item) => item.decision === "remove") ?? false);
  if (value.avConfirmed && changesMedia) {
    context.addIssue({
      code: "custom",
      path: ["avConfirmed"],
      message: "A changed cut must be rendered and watched before AV confirmation",
    });
  }
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(400, "validation_error", "请求参数不完整或格式不正确。", {
      details: { issues: result.error.issues },
    });
  }
  return result.data;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !value) {
    throw new AppError(400, "idempotency_key_required", "该操作需要 Idempotency-Key。");
  }
  return value;
}

function requestHash(body: unknown): string {
  return sha256Hex(canonicalJson(body ?? null));
}

function parseId(params: unknown, key: string): string {
  const record = params as Record<string, unknown>;
  return parse(uuid, record[key]);
}

function validateUploadedObject(
  upload: Record<string, unknown>,
  head: {
    ContentLength?: number | undefined;
    Metadata?: Record<string, string> | undefined;
  },
  projectId: string,
  maxUploadBytes: number,
): number {
  const actualSizeBytes = Number(head.ContentLength ?? 0);
  const expectedSizeBytes = Number(upload.expected_size_bytes);
  const expectedSha256 = upload.expected_sha256 === null
    ? null
    : String(upload.expected_sha256);
  if (
    !Number.isSafeInteger(actualSizeBytes)
    || actualSizeBytes <= 0
    || actualSizeBytes !== expectedSizeBytes
    || actualSizeBytes > maxUploadBytes
    || head.Metadata?.["project-id"] !== projectId
    || (expectedSha256 !== null && head.Metadata?.sha256 !== expectedSha256)
  ) {
    throw new AppError(409, "upload_object_integrity_mismatch", "上传原片完整性校验失败。");
  }
  return actualSizeBytes;
}

export async function registerRoutes(
  app: FastifyInstance,
  dependencies: {
    config: ProcessorConfig;
    repository: ProcessorRepository;
    storage: PrivateObjectStorage;
  },
): Promise<void> {
  const { config, repository, storage } = dependencies;

  app.post("/v1/projects", async (request, reply) => {
    const body = parse(projectBody, request.body);
    const response = await repository.withIdempotency(
      "create-project",
      idempotencyKey(request),
      requestHash(body),
      async () => ({
        statusCode: 201,
        payload: {
          project: await repository.createProject({
            title: body.title,
            projectDate: body.projectDate,
            sourceName: body.sourceName,
            mode: body.mode,
            editorMode: body.editorMode,
            ...(body.id ? { id: body.id } : {}),
          }),
        },
      }),
    );
    if (response.replayed) reply.header("idempotency-replayed", "true");
    return reply.code(response.statusCode).send(response.payload);
  });

  app.get("/v1/projects/:id", async (request) => {
    const projectId = parseId(request.params, "id");
    return { project: await repository.getProject(projectId) };
  });

  app.post("/v1/projects/:id/uploads/presign", async (request, reply) => {
    const projectId = parseId(request.params, "id");
    const body = parse(uploadBody, request.body);
    if (body.sizeBytes > config.r2.maxUploadBytes) {
      throw new AppError(
        413,
        "upload_too_large",
        `当前单条直播原片不能超过 ${Math.floor(config.r2.maxUploadBytes / 1_000_000_000)}GB。`,
      );
    }
    const strategy = body.sizeBytes <= config.r2.singlePutMaxBytes
      ? "single"
      : "multipart";
    const response = await repository.withIdempotency<UploadPresignPayload>(
      `presign-upload:${projectId}`,
      idempotencyKey(request),
      requestHash(body),
      async () => {
        const upload = await repository.createUpload({
          projectId,
          sourceName: body.sourceName,
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
          ...(body.sha256 ? { sha256: body.sha256 } : {}),
          strategy,
        });
        if (strategy === "multipart") {
          const plan = buildMultipartPartPlan(
            body.sizeBytes,
            config.r2.multipartPartSizeBytes,
          );
          let multipartUploadId: string | null = null;
          try {
            const created = await storage.createMultipartUpload({
              objectKey: upload.objectKey,
              contentType: body.contentType,
              ...(body.sha256 ? { sha256: body.sha256 } : {}),
              projectId,
            });
            multipartUploadId = created.multipartUploadId;
            await repository.beginMultipartUpload({
              projectId,
              uploadId: upload.id,
              multipartUploadId,
              partSizeBytes: plan[0]?.sizeBytes ?? config.r2.multipartPartSizeBytes,
              parts: plan,
            });
          } catch (error) {
            if (multipartUploadId) {
              await storage.abortMultipartUpload({
                objectKey: upload.objectKey,
                multipartUploadId,
              }).catch(() => undefined);
            }
            await repository.finishMultipartUploadState(
              projectId,
              upload.id,
              "failed",
            ).catch(() => undefined);
            throw error;
          }
          const uploadPayload = {
            id: upload.id,
            projectId,
            status: "multipart_initiated",
            strategy: "multipart",
            objectKey: upload.objectKey,
            partSizeBytes: plan[0]?.sizeBytes ?? config.r2.multipartPartSizeBytes,
            partCount: plan.length,
            expiresIn: config.r2.presignTtlSeconds,
          } as const;
          return {
            statusCode: 201,
            payload: {
              uploadId: upload.id,
              objectKey: upload.objectKey,
              upload: uploadPayload,
            },
          };
        }
        const signed = await storage.presignUpload({
          objectKey: upload.objectKey,
          contentType: body.contentType,
          ...(body.sha256 ? { sha256: body.sha256 } : {}),
          projectId,
        });
        const uploadPayload = {
          id: upload.id,
          projectId,
          status: "presigned",
          strategy: "single",
          objectKey: upload.objectKey,
          putUrl: signed.url,
          requiredHeaders: signed.requiredHeaders,
          expiresIn: signed.expiresIn,
        } as const;
        return {
          statusCode: 201,
          payload: {
            uploadId: upload.id,
            objectKey: upload.objectKey,
            putUrl: signed.url,
            requiredHeaders: signed.requiredHeaders,
            expiresIn: signed.expiresIn,
            upload: uploadPayload,
          },
        };
      },
    );
    if (response.replayed) reply.header("idempotency-replayed", "true");
    return reply.code(response.statusCode).send(response.payload);
  });

  app.post(
    "/v1/projects/:id/uploads/:uploadId/multipart/parts",
    async (request, reply) => {
      const projectId = parseId(request.params, "id");
      const uploadId = parseId(request.params, "uploadId");
      const body = parse(multipartPartsBody, request.body);
      if (body.partNumbers.length > config.r2.multipartPresignBatchSize) {
        throw new AppError(
          400,
          "multipart_presign_batch_too_large",
          `每次最多签发 ${config.r2.multipartPresignBatchSize} 个分片。`,
        );
      }
      const response = await repository.withIdempotency(
        `presign-multipart-parts:${uploadId}`,
        idempotencyKey(request),
        requestHash(body),
        async () => {
          const upload = await repository.getUpload(projectId, uploadId);
          if (
            upload.upload_strategy !== "multipart"
            || typeof upload.multipart_upload_id !== "string"
            || !["multipart_initiated", "uploading"].includes(String(upload.status))
          ) {
            throw new AppError(
              409,
              "multipart_upload_state_invalid",
              "分片上传状态无效，不能继续签发分片。",
            );
          }
          const expected = await repository.getMultipartPartPlan(projectId, uploadId);
          const expectedNumbers = new Set(expected.map((part) => part.partNumber));
          if (body.partNumbers.some((partNumber) => !expectedNumbers.has(partNumber))) {
            throw new AppError(400, "multipart_part_out_of_range", "请求了不存在的上传分片。");
          }
          const parts = await Promise.all(
            body.partNumbers.map(async (partNumber) => {
              const signed = await storage.presignMultipartPart({
                objectKey: String(upload.object_key),
                multipartUploadId: String(upload.multipart_upload_id),
                partNumber,
              });
              return {
                partNumber,
                putUrl: signed.url,
                expiresIn: signed.expiresIn,
              };
            }),
          );
          await repository.markMultipartUploading(projectId, uploadId);
          return {
            statusCode: 200,
            payload: { uploadId, parts },
          };
        },
      );
      if (response.replayed) reply.header("idempotency-replayed", "true");
      return reply.code(response.statusCode).send(response.payload);
    },
  );

  app.post(
    "/v1/projects/:id/uploads/:uploadId/complete",
    async (request, reply) => {
      const projectId = parseId(request.params, "id");
      const uploadId = parseId(request.params, "uploadId");
      const body = parse(z.object({}).strict(), request.body ?? {});
      const response = await repository.withIdempotency(
        `complete-upload:${uploadId}`,
        idempotencyKey(request),
        requestHash(body),
        async () => {
          const upload = await repository.getUpload(projectId, uploadId);
          if (upload.upload_strategy !== "single") {
            throw new AppError(
              409,
              "multipart_completion_endpoint_required",
              "分片原片必须使用分片完成接口。",
            );
          }
          const head = await storage.head(String(upload.object_key));
          const actualSizeBytes = validateUploadedObject(
            upload,
            head,
            projectId,
            config.r2.maxUploadBytes,
          );
          await repository.completeUpload({
            projectId,
            uploadId,
            actualSizeBytes,
            etag: head.ETag ?? null,
          });
          return {
            statusCode: 200,
            payload: {
              upload: {
                id: uploadId,
                projectId,
                status: "uploaded",
                sizeBytes: actualSizeBytes,
              },
            },
          };
        },
      );
      if (response.replayed) reply.header("idempotency-replayed", "true");
      return reply.code(response.statusCode).send(response.payload);
    },
  );

  app.post(
    "/v1/projects/:id/uploads/:uploadId/multipart/complete",
    async (request, reply) => {
      const projectId = parseId(request.params, "id");
      const uploadId = parseId(request.params, "uploadId");
      const body = parse(multipartCompleteBody, request.body);
      const normalizedClientParts = body.parts
        .map((part) => ({
          partNumber: part.partNumber,
          etag: normalizeMultipartEtag(part.etag),
        }))
        .sort((left, right) => left.partNumber - right.partNumber);
      const response = await repository.withIdempotency(
        `complete-multipart-upload:${uploadId}`,
        idempotencyKey(request),
        requestHash(normalizedClientParts),
        async () => {
          const upload = await repository.getUpload(projectId, uploadId);
          if (
            upload.upload_strategy !== "multipart"
            || typeof upload.multipart_upload_id !== "string"
          ) {
            throw new AppError(
              409,
              "multipart_upload_state_invalid",
              "分片上传状态无效，不能完成上传。",
            );
          }
          const objectKey = String(upload.object_key);
          const multipartUploadId = String(upload.multipart_upload_id);
          if (upload.status === "uploaded" || upload.status === "verified") {
            const head = await storage.head(objectKey);
            const actualSizeBytes = validateUploadedObject(
              upload,
              head,
              projectId,
              config.r2.maxUploadBytes,
            );
            return {
              statusCode: 200,
              payload: {
                upload: {
                  id: uploadId,
                  projectId,
                  status: "uploaded",
                  strategy: "multipart",
                  sizeBytes: actualSizeBytes,
                  partCount: Number(upload.multipart_part_count),
                },
              },
            };
          }
          if (!["multipart_initiated", "uploading", "completing"].includes(String(upload.status))) {
            throw new AppError(
              409,
              "multipart_upload_state_invalid",
              "分片上传状态无效，不能完成上传。",
            );
          }
          let objectCompleted = false;
          try {
            if (upload.status === "completing") {
              let existingHead: Awaited<ReturnType<PrivateObjectStorage["head"]>> | null = null;
              try {
                existingHead = await storage.head(objectKey);
              } catch (error) {
                if (!(error instanceof AppError) || error.code !== "object_not_found") throw error;
              }
              if (existingHead) {
                objectCompleted = true;
                const actualSizeBytes = validateUploadedObject(
                  upload,
                  existingHead,
                  projectId,
                  config.r2.maxUploadBytes,
                );
                await repository.completeUpload({
                  projectId,
                  uploadId,
                  actualSizeBytes,
                  etag: existingHead.ETag ?? null,
                });
                return {
                  statusCode: 200,
                  payload: {
                    upload: {
                      id: uploadId,
                      projectId,
                      status: "uploaded",
                      strategy: "multipart",
                      sizeBytes: actualSizeBytes,
                      partCount: Number(upload.multipart_part_count),
                    },
                  },
                };
              }
            }
            const expected = await repository.getMultipartPartPlan(projectId, uploadId);
            if (
              expected.length !== Number(upload.multipart_part_count)
              || normalizedClientParts.length !== expected.length
            ) {
              throw new AppError(
                409,
                "multipart_part_count_mismatch",
                "上传分片数量与原片计划不一致。",
              );
            }
            const remoteParts = (await storage.listMultipartParts({
              objectKey,
              multipartUploadId,
            })).sort((left, right) => left.partNumber - right.partNumber);
            if (remoteParts.length !== expected.length) {
              throw new AppError(
                409,
                "multipart_remote_part_count_mismatch",
                "私有存储中的上传分片不完整。",
              );
            }

            const verifiedParts = expected.map((part, index) => {
              const remote = remoteParts[index];
              const client = normalizedClientParts[index];
              if (
                !remote
                || !client
                || remote.partNumber !== part.partNumber
                || client.partNumber !== part.partNumber
                || remote.sizeBytes !== part.sizeBytes
                || normalizeMultipartEtag(remote.etag) !== client.etag
              ) {
                throw new AppError(
                  409,
                  "multipart_part_mismatch",
                  `第 ${part.partNumber} 个上传分片校验失败。`,
                );
              }
              return {
                partNumber: part.partNumber,
                sizeBytes: remote.sizeBytes,
                etag: remote.etag,
              };
            });

            await repository.recordMultipartParts({
              projectId,
              uploadId,
              parts: verifiedParts,
            });
            await repository.markMultipartCompleting(projectId, uploadId);
            const completed = await storage.completeMultipartUpload({
              objectKey,
              multipartUploadId,
              parts: verifiedParts.map((part) => ({
                partNumber: part.partNumber,
                etag: part.etag,
              })),
            });
            objectCompleted = true;

            const head = await storage.head(objectKey);
            const actualSizeBytes = validateUploadedObject(
              upload,
              head,
              projectId,
              config.r2.maxUploadBytes,
            );
            await repository.completeUpload({
              projectId,
              uploadId,
              actualSizeBytes,
              etag: head.ETag ?? completed.etag,
            });
            return {
              statusCode: 200,
              payload: {
                upload: {
                  id: uploadId,
                  projectId,
                  status: "uploaded",
                  strategy: "multipart",
                  sizeBytes: actualSizeBytes,
                  partCount: verifiedParts.length,
                },
              },
            };
          } catch (error) {
            if (objectCompleted) {
              await storage.delete(objectKey).catch(() => undefined);
            } else {
              await storage.abortMultipartUpload({
                objectKey,
                multipartUploadId,
              }).catch(() => undefined);
            }
            await repository.finishMultipartUploadState(
              projectId,
              uploadId,
              "failed",
            ).catch(() => undefined);
            throw error;
          }
        },
      );
      if (response.replayed) reply.header("idempotency-replayed", "true");
      return reply.code(response.statusCode).send(response.payload);
    },
  );

  app.post(
    "/v1/projects/:id/uploads/:uploadId/multipart/abort",
    async (request, reply) => {
      const projectId = parseId(request.params, "id");
      const uploadId = parseId(request.params, "uploadId");
      const body = parse(z.object({}).strict(), request.body ?? {});
      const response = await repository.withIdempotency(
        `abort-multipart-upload:${uploadId}`,
        idempotencyKey(request),
        requestHash(body),
        async () => {
          const upload = await repository.getUpload(projectId, uploadId);
          if (upload.upload_strategy !== "multipart") {
            throw new AppError(409, "not_multipart_upload", "该原片不是分片上传。");
          }
          if (upload.status === "uploaded" || upload.status === "verified") {
            throw new AppError(409, "upload_already_complete", "原片已完成，不能中止。");
          }
          if (upload.status !== "aborted" && typeof upload.multipart_upload_id === "string") {
            await storage.abortMultipartUpload({
              objectKey: String(upload.object_key),
              multipartUploadId: String(upload.multipart_upload_id),
            });
          }
          await repository.finishMultipartUploadState(projectId, uploadId, "aborted");
          return {
            statusCode: 200,
            payload: {
              upload: {
                id: uploadId,
                projectId,
                status: "aborted",
                strategy: "multipart",
              },
            },
          };
        },
      );
      if (response.replayed) reply.header("idempotency-replayed", "true");
      return reply.code(response.statusCode).send(response.payload);
    },
  );

  app.post("/v1/projects/:id/jobs", async (request, reply) => {
    const projectId = parseId(request.params, "id");
    const body = parse(jobBody, request.body);
    const response = await repository.withIdempotency(
      `create-job:${projectId}`,
      idempotencyKey(request),
      requestHash(body),
      async () => ({
        statusCode: 202,
        payload: {
          job: await repository.createJob({ projectId, uploadId: body.uploadId }),
        },
      }),
    );
    if (response.replayed) reply.header("idempotency-replayed", "true");
    return reply.code(response.statusCode).send(response.payload);
  });

  app.get("/v1/jobs/:jobId", async (request) => {
    const jobId = parseId(request.params, "jobId");
    return { job: await repository.getJob(jobId) };
  });

  app.get("/v1/projects/:id/candidates", async (request) => {
    const projectId = parseId(request.params, "id");
    const rows = await repository.listCandidates(projectId);
    const candidates = await Promise.all(rows.map(async (row) => {
      if (!row.previewObjectKey) return row.payload;
      const signed = await storage.presignDownload(row.previewObjectKey);
      return { ...row.payload, previewUrl: signed.url };
    }));
    return { candidates };
  });

  app.get("/v1/candidates/:id/preview", async (request) => {
    const candidateId = parseId(request.params, "id");
    const candidate = await repository.getCandidate(candidateId);
    if (!candidate.previewObjectKey) {
      throw new AppError(409, "preview_not_ready", "候选预览尚未生成。");
    }
    const signed = await storage.presignDownload(candidate.previewObjectKey);
    return {
      candidateId,
      previewUrl: signed.url,
      expiresIn: signed.expiresIn,
      previewKind: candidate.payload.previewKind,
      previewVersion: candidate.payload.previewVersion,
      renderStatus: candidate.payload.renderStatus,
      reviewStatus: candidate.payload.reviewStatus,
      isFinal: candidate.payload.isFinal,
    };
  });

  app.post("/v1/candidates/:id/feedback", async (request, reply) => {
    const candidateId = parseId(request.params, "id");
    const body = parse(feedbackBody, request.body);
    const candidateBefore = await repository.getCandidate(candidateId);
    const sourceStart = body.trim?.sourceStart
      ?? candidateBefore.payload.sourceStart;
    const sourceEnd = body.trim?.sourceEnd
      ?? candidateBefore.payload.sourceEnd;
    const proposedRenderSpec = {
      sourceStart,
      sourceEnd,
      transcriptDecisions: (body.transcriptDecisions ?? []).map((item) => ({
        lineId: item.lineId,
        decision: item.decision,
        ...(item.reason ? { reason: item.reason } : {}),
      })),
      ...(body.title ? { title: body.title } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
    };
    // First fail-closed boundary: never enqueue a render that escapes the
    // immutable candidate safety window or exceeds the final duration cap.
    if (
      body.trim
      || body.transcriptDecisions?.length
      || body.decision === "approve"
      || body.decision === "adjust"
    ) {
      deriveKeptRanges(candidateBefore.payload, proposedRenderSpec);
    }
    const renderSpec = body.decision === "approve" || body.decision === "adjust"
      ? proposedRenderSpec
      : undefined;
    const submittedBy = request.internalActor;
    if (!submittedBy) {
      throw new AppError(401, "actor_missing", "登录账号没有安全传递到处理服务。");
    }
    const response = await repository.withIdempotency(
      `candidate-feedback:${candidateId}`,
      idempotencyKey(request),
      requestHash({ actor: submittedBy, body }),
      async () => ({
        statusCode: 201,
        payload: {
          feedback: await repository.createFeedback({
            candidateId,
            decision: body.decision,
            submittedBy,
            payload: body,
            ...(renderSpec ? { renderSpec } : {}),
            avConfirmed: body.avConfirmed !== undefined,
            ...(body.avConfirmed
              ? {
                  reviewedPreviewVersion:
                    body.avConfirmed.reviewedPreviewVersion,
                }
              : {}),
          }),
        },
      }),
    );
    const current = await repository.getCandidate(candidateId);
    const previewUrl = current.previewObjectKey
      ? (await storage.presignDownload(current.previewObjectKey)).url
      : null;
    if (response.replayed) reply.header("idempotency-replayed", "true");
    return reply.code(response.statusCode).send({
      ...response.payload,
      candidate: {
        ...current.payload,
        previewUrl,
      },
      renderStatus: current.payload.renderStatus,
      previewUrl,
      previewKind: current.payload.previewKind,
      isFinal: current.payload.isFinal,
    });
  });
}
