import { z } from "zod";

const positiveInteger = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(10_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url().or(z.string().startsWith("postgresql://")),
  INTERNAL_API_KEYS: z.string().min(2),
  INTERNAL_SIGNATURE_TTL_SECONDS: positiveInteger(300),
  R2_ENDPOINT: z.string().url(),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  R2_REGION: z.string().min(1).default("auto"),
  PRESIGN_TTL_SECONDS: positiveInteger(3_600),
  PREVIEW_TTL_SECONDS: positiveInteger(600),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(50_000_000_000)
    .default(9_000_000_000),
  SINGLE_PUT_MAX_BYTES: z.coerce.number().int().positive().max(5 * 1024 * 1024 * 1024)
    .default(4_900_000_000),
  MULTIPART_PART_SIZE_BYTES: z.coerce.number().int()
    .min(5 * 1024 * 1024)
    .max(5 * 1024 * 1024 * 1024)
    .default(64 * 1024 * 1024),
  MULTIPART_PRESIGN_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(12),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_TRANSCRIPTION_MODEL: z.literal("gpt-4o-transcribe-diarize"),
  OPENAI_REASONING_MODEL: z.literal("gpt-5.6-sol"),
  OPENAI_VISION_MODEL: z.literal("gpt-5.6-sol"),
  TIANCLIP_CORE_S3_KEY: z.string().min(1),
  TIANCLIP_CORE_SHA256: z.string().regex(/^[a-f0-9]{64}$/),
  TIANCLIP_CORE_VERSION: z.literal("1.2.0-private.1"),
  TIANCLIP_PROMPT_VERSION: z.literal("1.2.0"),
  TIANCLIP_SCHEMA_VERSION: z.literal("1.1.0"),
  TIANCLIP_FACT_SCHEMA_VERSION: z.literal("1.0.0"),
  TIANCLIP_LEDGER_SCHEMA_VERSION: z.literal("1.0.0"),
  JOB_POLL_INTERVAL_MS: positiveInteger(1_500),
  JOB_LEASE_SECONDS: positiveInteger(120),
  JOB_MAX_ATTEMPTS: positiveInteger(3),
  WORKER_HEARTBEAT_INTERVAL_MS: positiveInteger(30_000),
  WORKER_HEARTBEAT_MAX_AGE_SECONDS: positiveInteger(120),
  TRANSCRIPTION_SEGMENT_SECONDS: positiveInteger(600),
  VISION_SAMPLE_SECONDS: positiveInteger(12),
  VISION_BATCH_SIZE: positiveInteger(8),
  CANDIDATE_FRAME_SECONDS: positiveInteger(2),
  ANALYSIS_WINDOW_SECONDS: positiveInteger(600),
  WORK_DIRECTORY: z.string().min(1).default("/tmp/tianclip"),
});

export type ProcessorConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: string;
  databaseUrl: string;
  internalApiKeys: ReadonlyMap<string, string>;
  signatureTtlSeconds: number;
  r2: {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    region: string;
    presignTtlSeconds: number;
    previewTtlSeconds: number;
    maxUploadBytes: number;
    singlePutMaxBytes: number;
    multipartPartSizeBytes: number;
    multipartPresignBatchSize: number;
  };
  openai: {
    apiKey: string;
    baseUrl: string;
    transcriptionModel: "gpt-4o-transcribe-diarize";
    reasoningModel: "gpt-5.6-sol";
    visionModel: "gpt-5.6-sol";
  };
  core: {
    objectKey: string;
    sha256: string;
    version: "1.2.0-private.1";
    promptVersion: "1.2.0";
    schemaVersion: "1.1.0";
    factSchemaVersion: "1.0.0";
    ledgerSchemaVersion: "1.0.0";
  };
  worker: {
    pollIntervalMs: number;
    leaseSeconds: number;
    maxAttempts: number;
    heartbeatIntervalMs: number;
    heartbeatMaxAgeSeconds: number;
    transcriptionSegmentSeconds: number;
    visionSampleSeconds: number;
    visionBatchSize: number;
    candidateFrameSeconds: number;
    analysisWindowSeconds: number;
    workDirectory: string;
  };
};

function parseInternalKeys(value: string): ReadonlyMap<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("INTERNAL_API_KEYS must be a JSON object", { cause: error });
  }

  const record = z.record(z.string().min(1), z.string().min(32)).parse(parsed);
  const entries = Object.entries(record);
  if (!entries.length) throw new Error("INTERNAL_API_KEYS must contain at least one key");
  return new Map(entries);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProcessorConfig {
  const value = envSchema.parse(env);
  if (value.SINGLE_PUT_MAX_BYTES >= value.MAX_UPLOAD_BYTES) {
    throw new Error("SINGLE_PUT_MAX_BYTES must be lower than MAX_UPLOAD_BYTES");
  }
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    databaseUrl: value.DATABASE_URL,
    internalApiKeys: parseInternalKeys(value.INTERNAL_API_KEYS),
    signatureTtlSeconds: value.INTERNAL_SIGNATURE_TTL_SECONDS,
    r2: {
      endpoint: value.R2_ENDPOINT,
      accessKeyId: value.R2_ACCESS_KEY_ID,
      secretAccessKey: value.R2_SECRET_ACCESS_KEY,
      bucket: value.R2_BUCKET,
      region: value.R2_REGION,
      presignTtlSeconds: value.PRESIGN_TTL_SECONDS,
      previewTtlSeconds: value.PREVIEW_TTL_SECONDS,
      maxUploadBytes: value.MAX_UPLOAD_BYTES,
      singlePutMaxBytes: value.SINGLE_PUT_MAX_BYTES,
      multipartPartSizeBytes: value.MULTIPART_PART_SIZE_BYTES,
      multipartPresignBatchSize: value.MULTIPART_PRESIGN_BATCH_SIZE,
    },
    openai: {
      apiKey: value.OPENAI_API_KEY,
      baseUrl: value.OPENAI_BASE_URL.replace(/\/+$/, ""),
      transcriptionModel: value.OPENAI_TRANSCRIPTION_MODEL,
      reasoningModel: value.OPENAI_REASONING_MODEL,
      visionModel: value.OPENAI_VISION_MODEL,
    },
    core: {
      objectKey: value.TIANCLIP_CORE_S3_KEY,
      sha256: value.TIANCLIP_CORE_SHA256,
      version: value.TIANCLIP_CORE_VERSION,
      promptVersion: value.TIANCLIP_PROMPT_VERSION,
      schemaVersion: value.TIANCLIP_SCHEMA_VERSION,
      factSchemaVersion: value.TIANCLIP_FACT_SCHEMA_VERSION,
      ledgerSchemaVersion: value.TIANCLIP_LEDGER_SCHEMA_VERSION,
    },
    worker: {
      pollIntervalMs: value.JOB_POLL_INTERVAL_MS,
      leaseSeconds: value.JOB_LEASE_SECONDS,
      maxAttempts: value.JOB_MAX_ATTEMPTS,
      heartbeatIntervalMs: value.WORKER_HEARTBEAT_INTERVAL_MS,
      heartbeatMaxAgeSeconds: value.WORKER_HEARTBEAT_MAX_AGE_SECONDS,
      transcriptionSegmentSeconds: value.TRANSCRIPTION_SEGMENT_SECONDS,
      visionSampleSeconds: value.VISION_SAMPLE_SECONDS,
      visionBatchSize: value.VISION_BATCH_SIZE,
      candidateFrameSeconds: value.CANDIDATE_FRAME_SECONDS,
      analysisWindowSeconds: value.ANALYSIS_WINDOW_SECONDS,
      workDirectory: value.WORK_DIRECTORY,
    },
  };
}
