import { AppError } from "./errors.js";

export const R2_MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;
export const R2_MULTIPART_MAX_PART_BYTES = 5 * 1024 * 1024 * 1024;
export const R2_MULTIPART_MAX_PARTS = 10_000;

export type MultipartPartPlan = {
  partNumber: number;
  sizeBytes: number;
};

export function buildMultipartPartPlan(
  sizeBytes: number,
  configuredPartSizeBytes: number,
): MultipartPartPlan[] {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new AppError(400, "invalid_upload_size", "原片文件大小无效。");
  }
  if (
    !Number.isSafeInteger(configuredPartSizeBytes)
    || configuredPartSizeBytes < R2_MULTIPART_MIN_PART_BYTES
    || configuredPartSizeBytes > R2_MULTIPART_MAX_PART_BYTES
  ) {
    throw new AppError(500, "invalid_multipart_configuration", "分片上传配置无效。", {
      expose: false,
    });
  }

  const minimumForPartLimit = Math.ceil(sizeBytes / R2_MULTIPART_MAX_PARTS);
  const partSizeBytes = Math.max(configuredPartSizeBytes, minimumForPartLimit);
  if (partSizeBytes > R2_MULTIPART_MAX_PART_BYTES) {
    throw new AppError(413, "multipart_upload_too_large", "原片超过当前分片上传上限。");
  }

  const partCount = Math.ceil(sizeBytes / partSizeBytes);
  if (partCount < 2 || partCount > R2_MULTIPART_MAX_PARTS) {
    throw new AppError(400, "invalid_multipart_part_count", "原片分片数量无效。");
  }

  return Array.from({ length: partCount }, (_, index) => {
    const partNumber = index + 1;
    const offset = index * partSizeBytes;
    return {
      partNumber,
      sizeBytes: Math.min(partSizeBytes, sizeBytes - offset),
    };
  });
}

export function normalizeMultipartEtag(value: string): string {
  const normalized = value.trim().replace(/^W\//i, "").replace(/^"(.*)"$/, "$1");
  if (!/^[A-Za-z0-9+/_=-]{1,128}$/.test(normalized)) {
    throw new AppError(400, "invalid_multipart_etag", "上传分片返回了无效的 ETag。");
  }
  return normalized;
}
