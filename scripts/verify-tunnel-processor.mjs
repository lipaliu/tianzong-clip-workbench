import { createHmac, createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.PROCESSOR_BASE_URL;
const secretPath = process.env.PROCESSOR_SECRET_PATH;
if (!baseUrl || !secretPath) throw new Error("缺少受控验证配置。");

const path = "/v1/jobs/00000000-0000-4000-8000-000000000000";
const actor = "deployment-verifier";
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(24).toString("hex");
const contentSha256 = createHash("sha256").update("").digest("hex");
const canonical = ["tianclip-v2", "GET", path, timestamp, nonce, contentSha256, actor].join("\n");
const secret = (await readFile(secretPath, "utf8")).trim();
const signature = createHmac("sha256", secret).update(canonical).digest("hex");
const response = await fetch(new URL(path, baseUrl), {
  headers: {
    "x-tianclip-key-id": "sites-proxy",
    "x-tianclip-timestamp": timestamp,
    "x-tianclip-nonce": nonce,
    "x-tianclip-content-sha256": contentSha256,
    "x-tianclip-actor": actor,
    "x-tianclip-signature": signature,
    accept: "application/json",
  },
  signal: AbortSignal.timeout(20_000),
});
const payload = await response.json().catch(() => ({}));
console.log(JSON.stringify({ status: response.status, error: payload?.error ?? null }));
if (![200, 404].includes(response.status)) process.exitCode = 1;
