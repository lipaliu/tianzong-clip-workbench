#!/usr/bin/env node

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, resolve } from "node:path";
import {
  open,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function required(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return String(value);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(",")}}`;
}

function bodySha256(body) {
  return createHash("sha256")
    .update(body === undefined ? "" : canonicalJson(body))
    .digest("hex");
}

function signedHeaders({
  keyId,
  secret,
  actor,
  method,
  pathWithQuery,
  body,
}) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = randomBytes(18).toString("base64url");
  const contentSha256 = bodySha256(body);
  const canonical = [
    "tianclip-v2",
    method.toUpperCase(),
    pathWithQuery,
    timestamp,
    nonce,
    contentSha256,
    actor,
  ].join("\n");
  return {
    "x-tianclip-key-id": keyId,
    "x-tianclip-timestamp": timestamp,
    "x-tianclip-nonce": nonce,
    "x-tianclip-content-sha256": contentSha256,
    "x-tianclip-actor": actor,
    "x-tianclip-signature": createHmac("sha256", secret)
      .update(canonical)
      .digest("hex"),
  };
}

async function apiRequest({
  baseUrl,
  keyId,
  secret,
  actor,
  method,
  path,
  body,
  idempotency = false,
}) {
  const target = new URL(path, `${baseUrl.replace(/\/+$/, "")}/`);
  let encodedBody;
  if (body !== undefined) {
    encodedBody = canonicalJson(body);
  }
  const idempotencyKey = idempotency
    ? `direct-upload-${randomUUID()}`
    : null;
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const headers = {
        accept: "application/json",
        ...signedHeaders({
          keyId,
          secret,
          actor,
          method,
          pathWithQuery: `${target.pathname}${target.search}`,
          body,
        }),
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
      const response = await fetch(target, {
        method,
        headers,
        body: encodedBody,
        signal: AbortSignal.timeout(120_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) return payload;
      const message = payload?.error?.message
        ?? payload?.error
        ?? `${method} ${target.pathname} failed with ${response.status}`;
      const transient = [408, 429, 500, 502, 503, 504].includes(response.status);
      if (!transient || attempt === 5) throw new Error(String(message));
      lastError = new Error(String(message));
    } catch (error) {
      lastError = error;
      if (attempt === 5) throw error;
    }
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, 750 * (2 ** (attempt - 1))));
  }
  throw lastError;
}

async function loadState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function saveState(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readRange(handle, start, length) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      length - offset,
      start + offset,
    );
    if (bytesRead <= 0) throw new Error("Source file ended before the multipart plan");
    offset += bytesRead;
  }
  return buffer;
}

async function uploadPart({
  handle,
  fileSize,
  partSizeBytes,
  partNumber,
  putUrl,
}) {
  const start = (partNumber - 1) * partSizeBytes;
  const end = Math.min(fileSize, start + partSizeBytes);
  const body = await readRange(handle, start, end - start);
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(putUrl, {
        method: "PUT",
        body,
        signal: AbortSignal.timeout(15 * 60_000),
      });
      if (!response.ok) {
        throw new Error(`part ${partNumber} failed with ${response.status}`);
      }
      const etag = response.headers.get("etag");
      if (!etag) throw new Error(`part ${partNumber} returned no ETag`);
      return { partNumber, etag };
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, 500 * (2 ** (attempt - 1))));
      }
    }
  }
  throw lastError;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = resolve(required(args.file, "--file"));
  const statePath = resolve(required(args.state, "--state"));
  const mode = required(args.mode, "--mode");
  if (!["聊播", "带货"].includes(mode)) throw new Error("--mode must be 聊播 or 带货");
  const editorMode = args.editor ?? "compare";
  if (!["openai", "doubao", "kimi", "compare", "compare_all"].includes(editorMode)) {
    throw new Error("--editor must be openai, doubao, kimi, compare, or compare_all");
  }
  const config = {
    baseUrl: required(process.env.TIANCLIP_API_URL, "TIANCLIP_API_URL"),
    keyId: required(process.env.TIANCLIP_KEY_ID, "TIANCLIP_KEY_ID"),
    secret: required(process.env.TIANCLIP_API_SECRET, "TIANCLIP_API_SECRET"),
    actor: process.env.TIANCLIP_ACTOR ?? "owner-direct-ingest",
  };
  const fileInfo = await stat(sourcePath);
  if (!fileInfo.isFile()) throw new Error("Source path is not a file");

  let state = await loadState(statePath);
  if (state) {
    if (state.sourcePath !== sourcePath || state.sizeBytes !== fileInfo.size) {
      throw new Error("Resume state belongs to a different source file");
    }
  } else {
    const project = await apiRequest({
      ...config,
      method: "POST",
      path: "/v1/projects",
      body: {
        title: required(args.title, "--title"),
        projectDate: required(args.date, "--date"),
        sourceName: basename(sourcePath),
        mode,
        editorMode,
      },
      idempotency: true,
    });
    state = {
      sourcePath,
      sizeBytes: fileInfo.size,
      title: args.title,
      projectDate: args.date,
      mode,
      editorMode,
      projectId: project.project.id,
      completedParts: [],
      phase: "project_created",
    };
    await saveState(statePath, state);
  }

  if (!state.uploadId) {
    const presigned = await apiRequest({
      ...config,
      method: "POST",
      path: `/v1/projects/${state.projectId}/uploads/presign`,
      body: {
        sourceName: basename(sourcePath),
        contentType: "video/mp4",
        sizeBytes: fileInfo.size,
      },
      idempotency: true,
    });
    Object.assign(state, {
      uploadId: presigned.upload.id,
      objectKey: presigned.upload.objectKey,
      uploadStrategy: presigned.upload.strategy,
      ...(presigned.upload.strategy === "multipart"
        ? {
            partSizeBytes: presigned.upload.partSizeBytes,
            partCount: presigned.upload.partCount,
            phase: "multipart_initiated",
          }
        : {
            putUrl: presigned.upload.putUrl,
            requiredHeaders: presigned.upload.requiredHeaders,
            phase: "single_presigned",
          }),
    });
    await saveState(statePath, state);
  }

  if (state.uploadStrategy === "single") {
    if (state.phase !== "uploaded" && state.phase !== "job_started") {
      const response = await fetch(state.putUrl, {
        method: "PUT",
        headers: {
          ...state.requiredHeaders,
          "content-length": String(fileInfo.size),
        },
        body: createReadStream(sourcePath),
        duplex: "half",
        signal: AbortSignal.timeout(4 * 60 * 60_000),
      });
      if (!response.ok) {
        throw new Error(`single upload failed with ${response.status}`);
      }
      await apiRequest({
        ...config,
        method: "POST",
        path: `/v1/projects/${state.projectId}/uploads/${state.uploadId}/complete`,
        body: {},
        idempotency: true,
      });
      state.phase = "uploaded";
      state.progress = 1;
      await saveState(statePath, state);
    }
  } else {
    const completed = new Map(
      state.completedParts.map((part) => [part.partNumber, part]),
    );
    const handle = await open(sourcePath, "r");
    try {
      const concurrency = Math.max(1, Math.min(4, Number(args.concurrency ?? 3)));
      const missing = Array.from(
        { length: state.partCount },
        (_, index) => index + 1,
      ).filter((partNumber) => !completed.has(partNumber));
      for (let offset = 0; offset < missing.length; offset += concurrency) {
        const partNumbers = missing.slice(offset, offset + concurrency);
        const signed = await apiRequest({
          ...config,
          method: "POST",
          path:
            `/v1/projects/${state.projectId}/uploads/${state.uploadId}`
            + "/multipart/parts",
          body: { partNumbers },
          idempotency: true,
        });
        const byNumber = new Map(
          signed.parts.map((part) => [part.partNumber, part]),
        );
        const uploaded = await Promise.all(partNumbers.map((partNumber) => {
          const part = byNumber.get(partNumber);
          if (!part) throw new Error(`No signed URL for part ${partNumber}`);
          return uploadPart({
            handle,
            fileSize: fileInfo.size,
            partSizeBytes: state.partSizeBytes,
            partNumber,
            putUrl: part.putUrl,
          });
        }));
        for (const part of uploaded) completed.set(part.partNumber, part);
        state.completedParts = [...completed.values()]
          .sort((left, right) => left.partNumber - right.partNumber);
        state.phase = "uploading";
        state.progress = state.completedParts.length / state.partCount;
        await saveState(statePath, state);
        process.stdout.write(
          `${basename(sourcePath)}: ${state.completedParts.length}/${state.partCount}`
          + ` (${(state.progress * 100).toFixed(1)}%)\n`,
        );
      }
    } finally {
      await handle.close();
    }

    if (state.phase !== "uploaded" && state.phase !== "job_started") {
      await apiRequest({
        ...config,
        method: "POST",
        path:
          `/v1/projects/${state.projectId}/uploads/${state.uploadId}`
          + "/multipart/complete",
        body: { parts: state.completedParts },
        idempotency: true,
      });
      state.phase = "uploaded";
      state.progress = 1;
      await saveState(statePath, state);
    }
  }

  if (!state.jobId) {
    const started = await apiRequest({
      ...config,
      method: "POST",
      path: `/v1/projects/${state.projectId}/jobs`,
      body: { uploadId: state.uploadId },
      idempotency: true,
    });
    state.jobId = started.job.id;
    state.phase = "job_started";
    await saveState(statePath, state);
  }

  process.stdout.write(`${JSON.stringify({
    projectId: state.projectId,
    uploadId: state.uploadId,
    jobId: state.jobId,
    statePath,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
