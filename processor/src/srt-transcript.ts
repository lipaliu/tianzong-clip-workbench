import { AppError } from "./errors.js";

export type UploadedSrtTranscript = {
  model: "uploaded_srt";
  mediaDurationSec: number;
  segments: Array<{
    id: string;
    sourceSegmentId: null;
    chunkId: "uploaded_srt";
    speaker: "用户字幕";
    text: string;
    localStartSec: number;
    localEndSec: number;
    startSec: number;
    endSec: number;
  }>;
  text: string;
  speakerLabels: ["用户字幕"];
  coverage: {
    firstSegmentStartSec: number;
    lastSegmentEndSec: number;
    chunkCount: 1;
    ownershipPartitionApplied: true;
  };
  generatedAt: string;
};

const timestamp = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*$/;

function seconds(hours: string, minutes: string, wholeSeconds: string, milliseconds: string) {
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(wholeSeconds) + Number(milliseconds) / 1000;
}

export function parseUploadedSrt(
  source: string,
  mediaDurationSec: number,
): UploadedSrtTranscript {
  if (!Number.isFinite(mediaDurationSec) || mediaDurationSec <= 0) {
    throw new AppError(422, "subtitle_media_duration_invalid", "无法将字幕匹配到无效的原片时长。");
  }
  const blocks = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  const segments: UploadedSrtTranscript["segments"] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeLineIndex = lines.findIndex((line) => timestamp.test(line));
    if (timeLineIndex < 0) continue;
    const match = lines[timeLineIndex]!.match(timestamp);
    if (!match) continue;
    const startSec = seconds(match[1]!, match[2]!, match[3]!, match[4]!);
    const endSec = seconds(match[5]!, match[6]!, match[7]!, match[8]!);
    const text = lines.slice(timeLineIndex + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
      throw new AppError(422, "subtitle_timestamps_invalid", "SRT 包含无效的开始或结束时间码。");
    }
    if (startSec < -0.05 || endSec > mediaDurationSec + 3) {
      throw new AppError(
        422,
        "subtitle_outside_source_timeline",
        "SRT 时间码超出原片时长，请确认字幕与原片属于同一版本。",
      );
    }
    const previous = segments.at(-1);
    if (previous && startSec < previous.startSec) {
      throw new AppError(422, "subtitle_not_chronological", "SRT 时间码必须按时间顺序排列。");
    }
    segments.push({
      id: `srt_${String(segments.length + 1).padStart(5, "0")}`,
      sourceSegmentId: null,
      chunkId: "uploaded_srt",
      speaker: "用户字幕",
      text,
      localStartSec: startSec,
      localEndSec: endSec,
      startSec,
      endSec,
    });
  }
  if (!segments.length) {
    throw new AppError(422, "subtitle_empty_or_invalid", "SRT 中没有可用的带时间码字幕内容。");
  }
  return {
    model: "uploaded_srt",
    mediaDurationSec,
    segments,
    text: segments.map((segment) => segment.text).join("\n"),
    speakerLabels: ["用户字幕"],
    coverage: {
      firstSegmentStartSec: segments[0]!.startSec,
      lastSegmentEndSec: segments.at(-1)!.endSec,
      chunkCount: 1,
      ownershipPartitionApplied: true,
    },
    generatedAt: new Date().toISOString(),
  };
}
