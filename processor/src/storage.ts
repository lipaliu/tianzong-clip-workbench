import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { createEcsRoleCredentialProvider } from "./ecs-role-credentials.js";
import type { ProcessorConfig } from "./config.js";
import { AppError } from "./errors.js";
import { hashAndSize } from "./media.js";

export class PrivateObjectStorage {
  readonly client: S3Client;
  readonly providerClient: S3Client;

  constructor(private readonly config: ProcessorConfig) {
    const credentials = config.r2.credentialMode === "ecs_role"
      ? createEcsRoleCredentialProvider(config.r2.ecsRoleName ?? "")
      : {
        accessKeyId: config.r2.accessKeyId ?? "",
        secretAccessKey: config.r2.secretAccessKey ?? "",
      };
    const commonClientOptions = {
      region: config.r2.region,
      credentials,
      // TOS accepts the signed payload metadata used below, but rejects AWS SDK
      // v3's optional flexible-checksum query parameters on browser presigns.
      // The application's own SHA-256 metadata plus post-upload HEAD check
      // remains the authoritative integrity boundary.
      requestChecksumCalculation: "WHEN_REQUIRED" as const,
      responseChecksumValidation: "WHEN_REQUIRED" as const,
      // Tencent COS and R2 both support virtual-hosted bucket URLs. COS
      // rejects path-style HEAD requests even when PutObject succeeds.
      forcePathStyle: false,
    };
    this.client = new S3Client({
      ...commonClientOptions,
      endpoint: config.r2.endpoint,
    });
    // Browsers and external model providers both execute outside the Beijing VPC
    // and cannot resolve a TOS .ivolces.com address. Every presigned URL handed
    // to an outside caller must therefore be signed against the public endpoint,
    // while the processor keeps reading and writing over the internal endpoint.
    this.providerClient = new S3Client({
      ...commonClientOptions,
      endpoint: config.r2.providerEndpoint,
    });
  }

  async presignUpload(options: {
    objectKey: string;
    contentType: string;
    sha256?: string;
    projectId: string;
  }): Promise<{ url: string; requiredHeaders: Record<string, string>; expiresIn: number }> {
    const metadata = {
      "project-id": options.projectId,
      ...(options.sha256 ? { sha256: options.sha256 } : {}),
    };
    const command = new PutObjectCommand({
      Bucket: this.config.r2.bucket,
      Key: options.objectKey,
      ContentType: options.contentType,
      Metadata: metadata,
    });
    const requiredHeaders: Record<string, string> = {
      "content-type": options.contentType,
      "x-amz-meta-project-id": options.projectId,
    };
    if (options.sha256) requiredHeaders["x-amz-meta-sha256"] = options.sha256;
    // TOS persists object metadata only when it is sent as request headers.
    // Keep those headers out of the query string and include them in SigV4's
    // SignedHeaders set so TOS does not reject them as unsigned additions.
    const url = await getSignedUrl(this.providerClient, command, {
      expiresIn: this.config.r2.presignTtlSeconds,
      unhoistableHeaders: new Set(Object.keys(requiredHeaders).filter((name) => name.startsWith("x-amz-meta-"))),
    });
    return {
      url,
      requiredHeaders,
      expiresIn: this.config.r2.presignTtlSeconds,
    };
  }

  async createMultipartUpload(options: {
    objectKey: string;
    contentType: string;
    sha256?: string;
    projectId: string;
  }): Promise<{ multipartUploadId: string }> {
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.r2.bucket,
        Key: options.objectKey,
        ContentType: options.contentType,
        Metadata: {
          "project-id": options.projectId,
          ...(options.sha256 ? { sha256: options.sha256 } : {}),
        },
      }),
    );
    if (!response.UploadId) {
      throw new AppError(502, "multipart_init_failed", "私有存储没有返回分片上传 ID。", {
        expose: false,
      });
    }
    return { multipartUploadId: response.UploadId };
  }

  async presignMultipartPart(options: {
    objectKey: string;
    multipartUploadId: string;
    partNumber: number;
  }): Promise<{ url: string; expiresIn: number }> {
    const command = new UploadPartCommand({
      Bucket: this.config.r2.bucket,
      Key: options.objectKey,
      UploadId: options.multipartUploadId,
      PartNumber: options.partNumber,
    });
    return {
      // Part uploads are performed by the visitor's browser, so this URL must be
      // signed for the public TOS endpoint as well.
      url: await getSignedUrl(this.providerClient, command, {
        expiresIn: this.config.r2.presignTtlSeconds,
      }),
      expiresIn: this.config.r2.presignTtlSeconds,
    };
  }

  async listMultipartParts(options: {
    objectKey: string;
    multipartUploadId: string;
  }): Promise<Array<{ partNumber: number; etag: string; sizeBytes: number }>> {
    const parts: Array<{ partNumber: number; etag: string; sizeBytes: number }> = [];
    let marker: string | undefined;
    do {
      const response = await this.client.send(
        new ListPartsCommand({
          Bucket: this.config.r2.bucket,
          Key: options.objectKey,
          UploadId: options.multipartUploadId,
          ...(marker ? { PartNumberMarker: marker } : {}),
        }),
      );
      for (const part of response.Parts ?? []) {
        if (
          !part.PartNumber
          || !part.ETag
          || !Number.isSafeInteger(part.Size)
          || Number(part.Size) <= 0
        ) {
          throw new AppError(
            502,
            "multipart_part_metadata_invalid",
            "私有存储返回了无效的分片信息。",
            { expose: false },
          );
        }
        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          sizeBytes: Number(part.Size),
        });
      }
      if (!response.IsTruncated) break;
      marker = response.NextPartNumberMarker;
      if (!marker) {
        throw new AppError(
          502,
          "multipart_pagination_invalid",
          "私有存储的分片分页信息不完整。",
          { expose: false },
        );
      }
    } while (true);
    return parts;
  }

  async completeMultipartUpload(options: {
    objectKey: string;
    multipartUploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<{ etag: string | null }> {
    const response = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.r2.bucket,
        Key: options.objectKey,
        UploadId: options.multipartUploadId,
        MultipartUpload: {
          Parts: options.parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
    return { etag: response.ETag ?? null };
  }

  async abortMultipartUpload(options: {
    objectKey: string;
    multipartUploadId: string;
  }): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.r2.bucket,
          Key: options.objectKey,
          UploadId: options.multipartUploadId,
        }),
      );
    } catch (error) {
      const name = error && typeof error === "object" && "name" in error
        ? String((error as { name?: unknown }).name)
        : "";
      if (name === "NoSuchUpload" || name === "NotFound") return;
      throw error;
    }
  }

  async delete(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.r2.bucket,
        Key: objectKey,
      }),
    );
  }

  async head(objectKey: string): Promise<HeadObjectCommandOutput> {
    try {
      return await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.r2.bucket,
          Key: objectKey,
        }),
      );
    } catch (error) {
      throw new AppError(404, "object_not_found", "上传文件尚未到达私有存储。", {
        cause: error,
      });
    }
  }

  async download(objectKey: string, destination: string): Promise<void> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.r2.bucket,
        Key: objectKey,
      }),
    );
    if (!response.Body) {
      throw new AppError(502, "object_empty", "私有存储返回了空文件。", {
        expose: false,
      });
    }
    await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(destination));
  }

  async getBuffer(objectKey: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.r2.bucket,
        Key: objectKey,
      }),
    );
    if (!response.Body) {
      throw new AppError(502, "object_empty", "私有存储返回了空文件。", {
        expose: false,
      });
    }
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async uploadFile(
    objectKey: string,
    path: string,
    contentType: string,
    metadata: Record<string, string> = {},
  ): Promise<{ sha256: string; sizeBytes: number }> {
    // Hash in a streaming pass before opening the upload stream. R2/S3 object
    // metadata is fixed when PutObject begins, so calculating it while
    // uploading would be too late. This is two sequential disk reads but it
    // keeps memory bounded for multi-GB media.
    const integrity = await hashAndSize(path);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.r2.bucket,
        Key: objectKey,
        Body: createReadStream(path),
        ContentLength: integrity.sizeBytes,
        ContentType: contentType,
        Metadata: {
          ...metadata,
          sha256: integrity.sha256,
          "size-bytes": String(integrity.sizeBytes),
        },
      }),
    );
    return integrity;
  }

  async uploadJson(
    objectKey: string,
    value: unknown,
    metadata: Record<string, string> = {},
  ): Promise<{ sha256: string; sizeBytes: number }> {
    const body = Buffer.from(canonicalJson(value), "utf8");
    const sha256 = sha256Hex(body);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.r2.bucket,
        Key: objectKey,
        Body: body,
        ContentType: "application/json; charset=utf-8",
        Metadata: { ...metadata, sha256 },
      }),
    );
    return { sha256, sizeBytes: body.length };
  }

  async presignDownload(objectKey: string): Promise<{ url: string; expiresIn: number }> {
    return await this.presignProviderDownload({
      objectKey,
      contentType: "video/mp4",
      expiresIn: this.config.r2.previewTtlSeconds,
    });
  }

  async presignProviderDownload(options: {
    objectKey: string;
    contentType: string;
    expiresIn?: number;
  }): Promise<{ url: string; expiresIn: number }> {
    const expiresIn = options.expiresIn
      ?? this.config.providers.providerUrlTtlSeconds;
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 604_800) {
      throw new AppError(
        500,
        "invalid_provider_url_ttl",
        "模型取件临时地址的有效期配置无效。",
        { expose: false },
      );
    }
    const command = new GetObjectCommand({
      Bucket: this.config.r2.bucket,
      Key: options.objectKey,
      ResponseContentDisposition: "inline",
      ResponseContentType: options.contentType,
    });
    return {
      url: await getSignedUrl(this.providerClient, command, {
        expiresIn,
      }),
      expiresIn,
    };
  }
}
