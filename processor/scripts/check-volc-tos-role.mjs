import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createEcsRoleCredentialProvider } from "../dist/ecs-role-credentials.js";

const endpoint = process.env.TOS_ENDPOINT;
const bucket = process.env.TOS_BUCKET;
const roleName = process.env.TOS_ECS_ROLE_NAME;
if (!endpoint || !bucket || !roleName) {
  throw new Error("TOS_ENDPOINT, TOS_BUCKET, and TOS_ECS_ROLE_NAME are required");
}

const client = new S3Client({
  endpoint,
  region: "cn-beijing",
  credentials: createEcsRoleCredentialProvider(roleName),
  forcePathStyle: false,
});
const key = `healthchecks/role-${Date.now()}.txt`;

async function safeResponseBody(error) {
  const body = error && typeof error === "object" ? error.$response?.body : undefined;
  if (!body || typeof body[Symbol.asyncIterator] !== "function") return null;
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength > 512) break;
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, 480);
}

try {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: "ok",
    ContentType: "text/plain",
  }));
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  console.log(JSON.stringify({ ok: true, bucket, objectSize: head.ContentLength ?? 0 }));
} catch (error) {
  const detail = error && typeof error === "object" ? error : {};
  console.error(JSON.stringify({
    ok: false,
    name: String(detail.name ?? "unknown"),
    code: String(detail.Code ?? detail.code ?? "unknown"),
    httpStatus: Number(detail.$metadata?.httpStatusCode ?? 0),
    message: String(detail.message ?? "unknown error").slice(0, 240),
    response: await safeResponseBody(detail),
  }));
  process.exitCode = 1;
} finally {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
}
