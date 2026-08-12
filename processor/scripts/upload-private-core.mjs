import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createEcsRoleCredentialProvider } from "../dist/ecs-role-credentials.js";

const endpoint = process.env.TOS_ENDPOINT;
const bucket = process.env.TOS_BUCKET;
const roleName = process.env.TOS_ECS_ROLE_NAME;
const filePath = process.env.CORE_PATH;
const key = process.env.CORE_KEY;
const expectedSha256 = process.env.CORE_SHA256;
if (!endpoint || !bucket || !roleName || !filePath || !key || !expectedSha256) {
  throw new Error("TOS_ENDPOINT, TOS_BUCKET, TOS_ECS_ROLE_NAME, CORE_PATH, CORE_KEY, and CORE_SHA256 are required");
}

const bytes = await stat(filePath);
const hash = createHash("sha256");
for await (const chunk of createReadStream(filePath)) hash.update(chunk);
const sha256 = hash.digest("hex");
if (sha256 !== expectedSha256) {
  throw new Error("local private core checksum does not match the pinned SHA-256");
}

const client = new S3Client({
  endpoint,
  region: "cn-beijing",
  credentials: createEcsRoleCredentialProvider(roleName),
  forcePathStyle: false,
});
await client.send(new PutObjectCommand({
  Bucket: bucket,
  Key: key,
  Body: createReadStream(filePath),
  ContentType: "application/zip",
  Metadata: { sha256, version: "1.2.3-private.1" },
}));
const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
if (head.ContentLength !== bytes.size || head.Metadata?.sha256 !== sha256) {
  throw new Error("uploaded private core metadata or size did not verify");
}
console.log(JSON.stringify({ ok: true, key, bytes: bytes.size, sha256 }));
