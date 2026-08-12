// Configures the private TOS bucket so the workbench origin can perform
// browser-side direct uploads (single PUT and resumable multipart parts).
// Runs on the Beijing instance and reuses the processor's own ECS role
// credential provider, so no long-lived TOS Access Key is required.
import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createEcsRoleCredentialProvider } from "../dist/ecs-role-credentials.js";

const bucket = process.env.R2_BUCKET;
const region = process.env.R2_REGION ?? "cn-beijing";
const endpoint = process.env.R2_PROVIDER_ENDPOINT ?? process.env.R2_ENDPOINT;
const roleName = process.env.R2_ECS_ROLE_NAME ?? "";
const origins = (process.env.CORS_ALLOWED_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
if (!bucket || !endpoint || origins.length === 0) {
  throw new Error("缺少 R2_BUCKET / 端点 / CORS_ALLOWED_ORIGINS 配置。");
}

const credentials = process.env.R2_CREDENTIAL_MODE === "ecs_role"
  ? createEcsRoleCredentialProvider(roleName)
  : {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  };

const client = new S3Client({
  region,
  endpoint,
  credentials,
  forcePathStyle: false,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

const rules = [
  {
    AllowedOrigins: origins,
    AllowedMethods: ["PUT", "POST", "GET", "HEAD", "DELETE"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag", "x-amz-request-id", "x-tos-request-id"],
    MaxAgeSeconds: 3600,
  },
];

await client.send(new PutBucketCorsCommand({
  Bucket: bucket,
  CORSConfiguration: { CORSRules: rules },
}));

const verify = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
console.log(JSON.stringify({
  bucket,
  endpoint,
  appliedRules: verify.CORSRules,
}, null, 2));
