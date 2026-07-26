import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { AppError } from "./errors.js";
import { runCommand } from "./pipeline/command-runner.mjs";
import type {
  CandidatePayload,
  CandidateRenderSpec,
} from "./types.js";

type Range = { start: number; end: number };

export const MAX_REVISION_DURATION_SECONDS = 600;

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort(
    (left, right) => left.start - right.start,
  );
  const merged: Range[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 0.04) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function deriveKeptRanges(
  candidate: CandidatePayload,
  spec: CandidateRenderSpec,
): Range[] {
  if (
    !Number.isFinite(spec.sourceStart)
    || !Number.isFinite(spec.sourceEnd)
    || spec.sourceStart < 0
    || spec.sourceEnd <= spec.sourceStart
  ) {
    throw new AppError(400, "render_window_invalid", "重渲染时间范围无效。");
  }
  const originalSafetyStart =
    candidate.originalSafetyStart ?? candidate.sourceStart;
  const originalSafetyEnd =
    candidate.originalSafetyEnd ?? candidate.sourceEnd;
  const mediaDurationSeconds =
    candidate.mediaDurationSeconds ?? originalSafetyEnd;
  if (
    !Number.isFinite(originalSafetyStart)
    || !Number.isFinite(originalSafetyEnd)
    || !Number.isFinite(mediaDurationSeconds)
    || originalSafetyStart < 0
    || originalSafetyEnd <= originalSafetyStart
    || mediaDurationSeconds < originalSafetyEnd
    || spec.sourceStart < originalSafetyStart
    || spec.sourceEnd > originalSafetyEnd
    || spec.sourceEnd > mediaDurationSeconds
  ) {
    throw new AppError(
      422,
      "render_window_outside_candidate",
      "调整后的时间范围必须完整位于该候选的原安全窗与原片范围内。",
    );
  }
  const transcriptById = new Map(
    candidate.transcript.map((line) => [line.id, line]),
  );
  for (const decision of spec.transcriptDecisions) {
    if (!transcriptById.has(decision.lineId)) {
      throw new AppError(
        400,
        "transcript_line_unknown",
        "重渲染包含不存在的逐字稿行。",
      );
    }
  }
  const removed = spec.transcriptDecisions
    .filter((item) => item.decision === "remove")
    .map((item) => {
      const line = transcriptById.get(item.lineId)!;
      return {
        start: Math.max(spec.sourceStart, line.start),
        end: Math.min(spec.sourceEnd, line.end),
      };
    })
    .filter((range) => range.end > range.start);

  const mergedRemoved = mergeRanges(removed);
  const kept: Range[] = [];
  let cursor = spec.sourceStart;
  for (const removal of mergedRemoved) {
    if (removal.start > cursor + 0.04) {
      kept.push({ start: cursor, end: removal.start });
    }
    cursor = Math.max(cursor, removal.end);
  }
  if (cursor < spec.sourceEnd - 0.04) {
    kept.push({ start: cursor, end: spec.sourceEnd });
  }
  if (!kept.length) {
    throw new AppError(
      422,
      "render_removes_entire_candidate",
      "当前删除选择会移除整条候选，无法生成视频。",
    );
  }
  const finalDurationSeconds = kept.reduce(
    (total, range) => total + range.end - range.start,
    0,
  );
  if (finalDurationSeconds > MAX_REVISION_DURATION_SECONDS) {
    throw new AppError(
      422,
      "render_duration_exceeds_limit",
      `调整后的成片不能超过 ${MAX_REVISION_DURATION_SECONDS} 秒。`,
    );
  }
  return kept;
}

export async function renderCandidateRevision(options: {
  sourcePath: string;
  outputPath: string;
  candidate: CandidatePayload;
  spec: CandidateRenderSpec;
}): Promise<{ keptRanges: Range[]; durationSeconds: number }> {
  const keptRanges = deriveKeptRanges(options.candidate, options.spec);
  await mkdir(dirname(options.outputPath), { recursive: true });
  const videoFilters = keptRanges.map(
    (range, index) =>
      `[0:v:0]trim=start=${range.start.toFixed(3)}:end=${range.end.toFixed(3)},`
      + `setpts=PTS-STARTPTS[v${index}]`,
  );
  const audioFilters = keptRanges.map(
    (range, index) =>
      `[0:a:0]atrim=start=${range.start.toFixed(3)}:end=${range.end.toFixed(3)},`
      + `asetpts=PTS-STARTPTS[a${index}]`,
  );
  let filterComplex: string;
  if (keptRanges.length === 1) {
    filterComplex = [
      ...videoFilters,
      ...audioFilters,
      `[v0]scale=-2:min(1280\\,ih)[vout]`,
      `[a0]anull[aout]`,
    ].join(";");
  } else {
    const inputs = keptRanges
      .map((_range, index) => `[v${index}][a${index}]`)
      .join("");
    filterComplex = [
      ...videoFilters,
      ...audioFilters,
      `${inputs}concat=n=${keptRanges.length}:v=1:a=1[vjoined][aout]`,
      `[vjoined]scale=-2:min(1280\\,ih)[vout]`,
    ].join(";");
  }
  await runCommand("ffmpeg", [
    "-v", "error",
    "-i", options.sourcePath,
    "-filter_complex", filterComplex,
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "-y",
    options.outputPath,
  ]);
  const info = await stat(options.outputPath);
  if (!info.isFile() || info.size <= 0) {
    throw new AppError(
      500,
      "revision_render_empty",
      "重渲染未生成有效视频。",
      { expose: false },
    );
  }
  return {
    keptRanges,
    durationSeconds: keptRanges.reduce(
      (total, range) => total + range.end - range.start,
      0,
    ),
  };
}
