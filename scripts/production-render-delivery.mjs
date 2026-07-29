import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const manifestInput = process.env.TIANCLIP_MANIFEST_PATH?.trim() ?? "";
const manifestPath = manifestInput ? resolve(manifestInput) : "";
const apiBase = String(
  process.env.TIANCLIP_PROCESSOR_API_URL ?? "http://api:10000",
).replace(/\/+$/, "");
const keyId = process.env.PROCESSOR_KEY_ID ?? "sites-proxy";
const actor = process.env.TIANCLIP_ACTOR ?? "production-delivery-verifier";
const pollIntervalMs = Number(process.env.TIANCLIP_POLL_INTERVAL_MS ?? 2_500);
const timeoutMs = Number(process.env.TIANCLIP_TIMEOUT_MS ?? 20 * 60 * 1_000);

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

function signedHeaders(method, pathWithQuery, body) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = randomBytes(18).toString("base64url");
  const content = body === undefined || body === null ? "" : canonicalJson(body);
  const digest = createHash("sha256").update(content).digest("hex");
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

async function api(method, path, body, { idempotent = false } = {}) {
  const url = new URL(path, `${apiBase}/`);
  const serialized = body === undefined ? undefined : canonicalJson(body);
  const headers = {
    accept: "application/json",
    ...signedHeaders(method, `${url.pathname}${url.search}`, body),
  };
  if (serialized !== undefined) headers["content-type"] = "application/json";
  if (idempotent) headers["idempotency-key"] = `delivery-${randomUUID()}`;
  const response = await fetch(url, {
    method,
    headers,
    body: serialized,
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) : {};
  if (!response.ok) {
    throw new Error(
      `${method} ${path} failed HTTP ${response.status}: ${
        payload?.error?.message ?? payload?.error ?? "unknown error"
      }`,
    );
  }
  return payload;
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 0.04) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function keptRanges(candidate) {
  const removed = mergeRanges(
    candidate.transcript
      .filter((line) => line.defaultDecision === "remove")
      .map((line) => ({
        start: Math.max(candidate.sourceStart, line.start),
        end: Math.min(candidate.sourceEnd, line.end),
      }))
      .filter((range) => range.end > range.start),
  );
  const kept = [];
  let cursor = candidate.sourceStart;
  for (const range of removed) {
    if (range.start > cursor + 0.04) kept.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < candidate.sourceEnd - 0.04) {
    kept.push({ start: cursor, end: candidate.sourceEnd });
  }
  if (!kept.length) throw new Error(`Candidate ${candidate.id} removes its entire window`);
  return kept;
}

function outputTime(sourceTime, ranges) {
  let elapsed = 0;
  for (const range of ranges) {
    if (sourceTime <= range.start) return elapsed;
    if (sourceTime < range.end) return elapsed + sourceTime - range.start;
    elapsed += range.end - range.start;
  }
  return elapsed;
}

function srtTime(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function buildSrt(candidate, ranges) {
  const cues = candidate.transcript
    .filter((line) => line.defaultDecision === "keep")
    .flatMap((line) => {
      const overlap = ranges.find(
        (range) => line.end > range.start && line.start < range.end,
      );
      if (!overlap) return [];
      const sourceStart = Math.max(line.start, overlap.start);
      const sourceEnd = Math.min(line.end, overlap.end);
      const start = outputTime(sourceStart, ranges);
      const end = Math.max(outputTime(sourceEnd, ranges), start + 0.12);
      return [{ start, end, text: line.text.trim() }];
    })
    .filter((cue) => cue.text);
  return `${cues
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}`,
    )
    .join("\n\n")}\n`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildXml(candidate, ranges) {
  const media = candidate.sourceMedia;
  const rate = media.frameRate;
  if (
    media.metadataStatus !== "verified_ffprobe"
    || !rate
    || !media.width
    || !media.height
    || !media.audioChannels
  ) {
    throw new Error(`Candidate ${candidate.id} has incomplete source metadata`);
  }
  const exactFps = rate.numerator / rate.denominator;
  const timebase = Math.max(1, Math.round(exactFps));
  const ntsc = rate.denominator !== 1 ? "TRUE" : "FALSE";
  let timelineFrame = 0;
  const videoItems = [];
  const audioItems = [];
  ranges.forEach((range, index) => {
    const sourceIn = Math.round(range.start * exactFps);
    const sourceOut = Math.max(Math.round(range.end * exactFps), sourceIn + 1);
    const duration = sourceOut - sourceIn;
    const timelineStart = timelineFrame;
    const timelineEnd = timelineStart + duration;
    const sourceFile = index === 0
      ? `<file id="source-file"><name>${escapeXml(media.originalFileName)}</name><pathurl>file://localhost/${escapeXml(encodeURIComponent(media.originalFileName))}</pathurl><rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate><duration>${Math.max(Math.round(media.durationSeconds * exactFps), 1)}</duration><media><video><samplecharacteristics><width>${media.width}</width><height>${media.height}</height></samplecharacteristics></video><audio><channelcount>${media.audioChannels}</channelcount></audio></media></file>`
      : `<file id="source-file"/>`;
    videoItems.push(`<clipitem id="video-${index + 1}"><name>${escapeXml(candidate.title)}</name><duration>${duration}</duration><rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate><start>${timelineStart}</start><end>${timelineEnd}</end><in>${sourceIn}</in><out>${sourceOut}</out>${sourceFile}<link><linkclipref>video-${index + 1}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>${index + 1}</clipindex></link><link><linkclipref>audio-${index + 1}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>${index + 1}</clipindex></link></clipitem>`);
    audioItems.push(`<clipitem id="audio-${index + 1}"><name>${escapeXml(candidate.title)}</name><duration>${duration}</duration><rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate><start>${timelineStart}</start><end>${timelineEnd}</end><in>${sourceIn}</in><out>${sourceOut}</out><file id="source-file"/><sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack><link><linkclipref>video-${index + 1}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>${index + 1}</clipindex></link><link><linkclipref>audio-${index + 1}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>${index + 1}</clipindex></link></clipitem>`);
    timelineFrame = timelineEnd;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xmeml version="5"><sequence><name>${escapeXml(candidate.title)}</name><duration>${timelineFrame}</duration><rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate><media><video><format><samplecharacteristics><width>${media.width}</width><height>${media.height}</height><pixelaspectratio>square</pixelaspectratio><rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate></samplecharacteristics></format><track>${videoItems.join("")}</track></video><audio><numOutputChannels>${media.audioChannels}</numOutputChannels><track>${audioItems.join("")}</track></audio></media></sequence></xmeml>\n`;
}

async function download(url, destination) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15 * 60 * 1_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

async function probe(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,channels",
    "-of",
    "json",
    filePath,
  ]);
  const result = JSON.parse(stdout);
  const streams = result.streams ?? [];
  if (
    Number(result.format?.size) <= 0
    || Number(result.format?.duration) <= 0
    || !streams.some((stream) => stream.codec_type === "video")
    || !streams.some((stream) => stream.codec_type === "audio")
  ) {
    throw new Error(`ffprobe rejected ${filePath}`);
  }
  return result;
}

async function readCandidates(projectId) {
  const { candidates } = await api(
    "GET",
    `/v1/projects/${encodeURIComponent(projectId)}/candidates`,
  );
  return candidates;
}

async function waitForRevisions(projectId, candidateIds) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const candidates = await readCandidates(projectId);
    const selected = candidates.filter((candidate) => candidateIds.has(candidate.id));
    const failed = selected.find((candidate) => candidate.renderStatus === "render_failed");
    if (failed) throw new Error(`Revision render failed for ${failed.id}`);
    const ready = selected.filter(
      (candidate) =>
        candidate.renderStatus === "revision_ready"
        && candidate.previewKind === "revised_cut"
        && candidate.previewUrl,
    );
    process.stdout.write(
      `${new Date().toISOString()} revised cuts ${ready.length}/${candidateIds.size}\n`,
    );
    if (ready.length === candidateIds.size) return ready;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollIntervalMs));
  }
  throw new Error(`Revision rendering timed out after ${timeoutMs}ms`);
}

async function main() {
  const manifest = manifestPath
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : {
        projectId: process.env.TIANCLIP_PROJECT_ID?.trim(),
        jobId: process.env.TIANCLIP_JOB_ID?.trim() || null,
        sourceName: process.env.TIANCLIP_SOURCE_NAME?.trim() || null,
      };
  const projectId = manifest.projectId;
  if (!projectId) {
    throw new Error(
      "TIANCLIP_MANIFEST_PATH or TIANCLIP_PROJECT_ID is required",
    );
  }
  const candidates = await readCandidates(projectId);
  if (!candidates.length) throw new Error("Project has no candidates");

  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  for (const candidate of candidates) {
    if (
      candidate.renderStatus === "revision_ready"
      && candidate.previewKind === "revised_cut"
    ) {
      continue;
    }
    await api(
      "POST",
      `/v1/candidates/${encodeURIComponent(candidate.id)}/feedback`,
      {
        decision: "adjust",
        transcriptDecisions: candidate.transcript.map((line) => ({
          lineId: line.id,
          decision: line.defaultDecision,
        })),
        notes:
          "真实生产交付验收：严格按天总 Skill 当前删留建议生成无字幕原声成片；未冒充团队人工音画确认。",
      },
      { idempotent: true },
    );
  }

  const revised = await waitForRevisions(projectId, candidateIds);
  const outputDirectory = resolve(
    process.env.TIANCLIP_DELIVERY_DIRECTORY
      ?? (
        manifestPath
          ? resolve(dirname(manifestPath), `${projectId}-delivery`)
          : resolve(`./${projectId}-delivery`)
      ),
  );
  await mkdir(outputDirectory, { recursive: true });
  const delivery = [];
  for (const [index, candidate] of revised.entries()) {
    const prefix = `${String(index + 1).padStart(2, "0")}-${candidate.id}`;
    const videoPath = resolve(outputDirectory, `${prefix}.mp4`);
    const srtPath = resolve(outputDirectory, `${prefix}.srt`);
    const xmlPath = resolve(outputDirectory, `${prefix}.xml`);
    const ranges = keptRanges(candidate);
    await download(candidate.previewUrl, videoPath);
    await writeFile(srtPath, buildSrt(candidate, ranges), "utf8");
    await writeFile(xmlPath, buildXml(candidate, ranges), "utf8");
    const mediaProbe = await probe(videoPath);
    delivery.push({
      id: candidate.id,
      title: candidate.title,
      editorProvider: candidate.editorProvider,
      sourceStart: candidate.sourceStart,
      sourceEnd: candidate.sourceEnd,
      keptRanges: ranges,
      videoPath,
      srtPath,
      xmlPath,
      mediaProbe,
    });
  }
  const deliveryManifestPath = resolve(outputDirectory, "delivery-manifest.json");
  await writeFile(
    deliveryManifestPath,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        projectId,
        jobId: manifest.jobId,
        sourceName: manifest.sourceName,
        candidateCount: delivery.length,
        humanAvConfirmed: false,
        delivery,
      },
      null,
      2,
    ),
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        projectId,
        candidateCount: delivery.length,
        outputDirectory,
        deliveryManifestPath,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
