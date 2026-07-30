#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "/app/dist/config.js";
import { createDatabase } from "/app/dist/db.js";
import { PrivateObjectStorage } from "/app/dist/storage.js";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index]?.replace(/^--/, ""), argv[index + 1]);
  }
  for (const key of ["project", "job", "directory", "candidates", "transcript"]) {
    if (!values.get(key)) throw new Error(`Missing --${key}`);
  }
  return Object.fromEntries(values);
}

function durationMode(seconds) {
  if (seconds <= 27) return "micro";
  if (seconds >= 90) return "deep_dive";
  return "standard";
}

function durationWindow(seconds) {
  if (seconds <= 27) return "12–27 秒";
  if (seconds >= 90) return "90–130 秒";
  return "45–75 秒";
}

function priority(score) {
  if (score >= 85) return "S";
  if (score >= 70) return "A";
  return "B";
}

function deterministicCandidateId(jobId, candidateId) {
  const hex = createHash("sha256")
    .update(`${jobId}:${candidateId}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join("-");
}

const input = parseArguments(process.argv.slice(2));
const [manifest, candidateDocument, transcriptDocument] = await Promise.all([
  readFile(join(input.directory, "候选清单.json"), "utf8").then(JSON.parse),
  readFile(input.candidates, "utf8").then(JSON.parse),
  readFile(input.transcript, "utf8").then(JSON.parse),
]);
const sourceById = new Map(
  candidateDocument.candidates.map((candidate) => [candidate.candidateId, candidate]),
);
const config = loadConfig(process.env);
const database = createDatabase(config);
const storage = new PrivateObjectStorage(config);
const projectResult = await database.query(
  `SELECT p.mode, p.source_name, j.upload_id
   FROM projects p
   JOIN processing_jobs j ON j.project_id = p.id
   WHERE p.id = $1 AND j.id = $2`,
  [input.project, input.job],
);
if (!projectResult.rowCount) throw new Error("Project or job does not exist");
const project = projectResult.rows[0];

const rows = manifest.candidates.map((candidate, index) => {
  const id = deterministicCandidateId(input.job, candidate.candidateId);
  const sourceCandidate = sourceById.get(candidate.candidateId);
  const score = Number(candidate.score ?? 0);
  const transcript = candidate.intervals.map((interval, lineIndex) => ({
    id: `${candidate.candidateId}-rough-${lineIndex + 1}`,
    start: interval.start,
    end: interval.end,
    text: interval.transcript,
    speaker: candidate.tianzongSpeaker,
    defaultDecision: "keep",
    reason: "天总本人原声；批量粗剪先行交付。",
    evidenceLevel: "原声逐字",
  }));
  const payload = {
    id,
    kind: project.mode,
    editorProvider: candidate.provider,
    index: String(index + 1).padStart(2, "0"),
    title: candidate.title,
    sourceStart: candidate.roughCutStart,
    sourceEnd: candidate.roughCutEnd,
    originalSafetyStart:
      sourceCandidate?.safetyWindow?.startSec ?? candidate.roughCutStart,
    originalSafetyEnd:
      sourceCandidate?.safetyWindow?.endSec ?? candidate.roughCutEnd,
    mediaDurationSeconds: transcriptDocument.mediaDurationSec,
    durationSeconds: candidate.roughCutDuration,
    score,
    summary:
      "双模型召回后的批量粗剪先行交付；保留天总本人原声，等待团队正常倍速判断。",
    contentType: "电商 / 直播 / 商业判断",
    personaModes: ["实战老板", "强姐姐"],
    personaReason:
      "从天总本人回答开始，保留她基于直播、电商与内容经验给出的直接判断。",
    durationMode: durationMode(candidate.roughCutDuration),
    durationWindow: durationWindow(candidate.roughCutDuration),
    durationReason:
      "粗剪优先保住完整句子与因果链；短候选已向右扩展，另一说话人的长插话已删除。",
    selectionReasons: [
      `由 ${candidate.provider === "openai" ? "OpenAI" : "豆包"} 独立执行同一版天总 Skill 召回。`,
      "当前为批量粗剪待判断，不是最终精品成片。",
      "模型精修和原生音视频复核完成后会更新最终切口。",
    ],
    scoreBreakdown: [
      { label: "召回总分", score, max: 100 },
    ],
    priority: priority(score),
    factGate: "待团队正常倍速完整播放；不得把批量粗剪直接视为最终发布版。",
    calibrationStatus: "批量粗剪已生成；模型音画精修进行中",
    transcript,
    previewUrl: null,
    reviewStatus: "proxy_rendered_needs_human_normal_playback",
    renderStatus: "rough_ready",
    previewKind: "rough_cut",
    previewVersion: `checkpoint_${input.job}_${candidate.candidateId}`,
    isFinal: false,
    sourceMedia: {
      originalFileName: project.source_name,
      durationSeconds: transcriptDocument.mediaDurationSec,
      width: 0,
      height: 0,
      frameRate: null,
      audioChannels: null,
      metadataStatus: "incomplete_ffprobe",
      missingFields: ["width", "height", "frameRate", "audioChannels"],
    },
  };
  return {
    id,
    ordinal: index + 1,
    objectKey: `previews/${input.project}/${id}.mp4`,
    filePath: join(input.directory, candidate.fileName),
    payload,
  };
});

let nextUpload = 0;
let completedUploads = 0;
const uploadNext = async () => {
  while (true) {
    const index = nextUpload;
    nextUpload += 1;
    if (index >= rows.length) return;
    const row = rows[index];
    await storage.uploadFile(row.objectKey, row.filePath, "video/mp4", {
      "project-id": input.project,
      "job-id": input.job,
      "candidate-id": row.id,
      "preview-kind": "checkpoint-bulk-rough-cut",
    });
    completedUploads += 1;
    process.stdout.write(`${completedUploads}/${rows.length} ${row.payload.title}\n`);
  }
};
await Promise.all(Array.from({ length: Math.min(6, rows.length) }, uploadNext));

const client = await database.connect();
try {
  await client.query("BEGIN");
  await client.query("DELETE FROM candidates WHERE job_id = $1", [input.job]);
  for (const row of rows) {
    await client.query(
      `INSERT INTO candidates(
         id, project_id, job_id, ordinal, source_start_ms, source_end_ms,
         score, priority, review_status, render_status, payload,
         preview_object_key
       )
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        row.id,
        input.project,
        input.job,
        row.ordinal,
        Math.round(row.payload.sourceStart * 1_000),
        Math.round(row.payload.sourceEnd * 1_000),
        row.payload.score,
        row.payload.priority,
        row.payload.reviewStatus,
        row.payload.renderStatus,
        row.payload,
        row.objectKey,
      ],
    );
  }
  await client.query(
    `UPDATE processing_jobs
     SET status = 'succeeded',
         stage = 'bulk_rough_cut_review_ready',
         progress = 100,
         clip_count = $2,
         result = jsonb_build_object(
           'provisional', true,
           'delivery', 'bulk_rough_cut_pending_human_review',
           'candidateCount', $2::integer
         ),
         error_public = NULL,
         finished_at = now(),
         lease_expires_at = NULL,
         worker_id = NULL,
         updated_at = now()
     WHERE id = $1`,
    [input.job, rows.length],
  );
  await client.query(
    `UPDATE projects
     SET status = 'review_ready',
         stage = 'bulk_rough_cut_review_ready',
         progress = 100,
         clip_count = $2,
         error_public = NULL,
         updated_at = now()
     WHERE id = $1`,
    [input.project, rows.length],
  );
  await client.query(
    `INSERT INTO job_events(job_id, stage, progress, message, detail)
     VALUES($1, 'bulk_rough_cut_delivery', 89, $2, $3)`,
    [
      input.job,
      `已先行交付 ${rows.length} 条可播放批量粗剪；模型精修继续运行。`,
      JSON.stringify({
        candidateCount: rows.length,
        openaiCount: rows.filter((row) => row.payload.editorProvider === "openai").length,
        doubaoCount: rows.filter((row) => row.payload.editorProvider === "doubao").length,
        provisional: true,
      }),
    ],
  );
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await database.end();
}

process.stdout.write(`Published ${rows.length} checkpoint candidates\n`);
