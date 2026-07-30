import { createHash, createHmac, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const projectId = process.env.TIANCLIP_PROJECT_ID?.trim();
const apiBase = String(
  process.env.TIANCLIP_PROCESSOR_API_URL ?? "http://api:10000",
).replace(/\/+$/, "");
const keyId = process.env.PROCESSOR_KEY_ID ?? "sites-proxy";
const actor = process.env.TIANCLIP_ACTOR ?? "candidate-delivery";
const outputDirectory = resolve(
  process.env.TIANCLIP_OUTPUT_DIRECTORY
    ?? `./deliveries/${projectId || "unknown-project"}`,
);
const downloadLimit = Number(process.env.TIANCLIP_DOWNLOAD_LIMIT ?? 0);

if (!projectId) throw new Error("TIANCLIP_PROJECT_ID is required");
if (!Number.isInteger(downloadLimit) || downloadLimit < 0) {
  throw new Error("TIANCLIP_DOWNLOAD_LIMIT must be a non-negative integer");
}

function resolveSecret() {
  const direct = process.env.PROCESSOR_API_SECRET?.trim();
  if (direct) return direct;
  const configured = JSON.parse(process.env.INTERNAL_API_KEYS ?? "{}");
  const value = configured[keyId];
  if (typeof value !== "string" || value.length < 32) {
    throw new Error(`Missing internal API secret for key ${keyId}`);
  }
  return value;
}

const secret = resolveSecret();

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function contentSha256(body) {
  const source = body === undefined || body === null ? "" : canonicalJson(body);
  return createHash("sha256").update(source).digest("hex");
}

function signedHeaders(method, pathWithQuery, body) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = randomBytes(18).toString("base64url");
  const digest = contentSha256(body);
  const canonical = [
    "tianclip-v2",
    method.toUpperCase(),
    pathWithQuery,
    timestamp,
    nonce,
    digest,
    actor,
  ].join("\n");
  return {
    "x-tianclip-key-id": keyId,
    "x-tianclip-timestamp": timestamp,
    "x-tianclip-nonce": nonce,
    "x-tianclip-content-sha256": digest,
    "x-tianclip-actor": actor,
    "x-tianclip-signature": createHmac("sha256", secret)
      .update(canonical)
      .digest("hex"),
  };
}

async function api(method, path) {
  const url = new URL(path, `${apiBase}/`);
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...signedHeaders(method, `${url.pathname}${url.search}`),
    },
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) : {};
  if (!response.ok) {
    throw new Error(
      `${method} ${path} failed HTTP ${response.status}: `
      + `${payload?.error?.message ?? payload?.error ?? "unknown error"}`,
    );
  }
  return payload;
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function safeFilePart(value) {
  const cleaned = String(value ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 70) || "未命名候选";
}

function timecode(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return `${String(hours).padStart(2, "0")}:`
    + `${String(minutes).padStart(2, "0")}:`
    + `${secs.toFixed(3).padStart(6, "0")}`;
}

async function download(url, destination) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30 * 60 * 1_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

const { candidates } = await api(
  "GET",
  `/v1/projects/${encodeURIComponent(projectId)}/candidates`,
);
if (!Array.isArray(candidates) || candidates.length === 0) {
  throw new Error("Project has no candidates");
}

await mkdir(outputDirectory, { recursive: true });
await writeFile(
  resolve(outputDirectory, "候选清单.json"),
  JSON.stringify({ projectId, candidateCount: candidates.length, candidates }, null, 2),
  "utf8",
);

const columns = [
  "序号",
  "模型",
  "候选ID",
  "主题",
  "抖音标题",
  "小红书标题",
  "核心金句",
  "评分",
  "粗剪时长秒",
  "原片起点",
  "原片终点",
  "开头钩子",
  "完整收口",
  "为什么值得剪",
  "文件名",
];
const rows = candidates.map((candidate, index) => {
  const title = candidate.title || candidate.topic || "未命名候选";
  const keptTranscript = (candidate.transcript ?? [])
    .filter((line) => line.defaultDecision === "keep")
    .sort((left, right) => left.start - right.start);
  const openingLine = candidate.hook
    || candidate.openingLine
    || keptTranscript.at(0)?.text
    || "";
  const closingLine = candidate.closingLine
    || candidate.completeEnding
    || keptTranscript.at(-1)?.text
    || "";
  const fileName = `${String(index + 1).padStart(3, "0")}_`
    + `${safeFilePart(candidate.douyinTitle || title)}.mp4`;
  return [
    index + 1,
    candidate.editorProvider,
    candidate.id,
    candidate.topic || title,
    candidate.douyinTitle || title,
    candidate.xiaohongshuTitle || title,
    candidate.quotableLine || candidate.goldQuote || "",
    candidate.score?.total ?? candidate.score ?? "",
    candidate.durationSeconds,
    timecode(candidate.sourceStart),
    timecode(candidate.sourceEnd),
    openingLine,
    closingLine,
    candidate.rationale || candidate.summary || "",
    fileName,
  ];
});
await writeFile(
  resolve(outputDirectory, "候选清单.csv"),
  `\uFEFF${[columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`,
  "utf8",
);

const selected = downloadLimit === 0
  ? candidates
  : candidates.slice(0, downloadLimit);
let downloadedCount = 0;
for (const [index, candidate] of selected.entries()) {
  if (!candidate.previewUrl) continue;
  const title = candidate.douyinTitle || candidate.title || candidate.topic;
  const destination = resolve(
    outputDirectory,
    `${String(index + 1).padStart(3, "0")}_${safeFilePart(title)}.mp4`,
  );
  await download(candidate.previewUrl, destination);
  downloadedCount += 1;
  process.stdout.write(
    `已下载 ${downloadedCount}/${selected.length}：${destination}\n`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    projectId,
    candidateCount: candidates.length,
    downloadedCount,
    outputDirectory,
  }, null, 2)}\n`,
);
