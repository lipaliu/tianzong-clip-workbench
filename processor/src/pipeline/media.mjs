import { stat } from "node:fs/promises";
import { runCommand } from "./command-runner.mjs";
import { PipelineError, invariant } from "./errors.mjs";

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseFrameRate(value) {
  return parseFrameRateRational(value)?.fps;
}

export function parseFrameRateRational(value) {
  if (typeof value !== "string" || !value.length || value === "0/0") return undefined;
  const match = value.match(/^(\d+)\/(\d+)$/);
  if (!match) return undefined;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (
    !Number.isSafeInteger(numerator)
    || numerator <= 0
    || !Number.isSafeInteger(denominator)
    || denominator <= 0
  ) {
    return undefined;
  }
  const fps = numerator / denominator;
  if (!Number.isFinite(fps) || fps <= 0) return undefined;
  return {
    numerator,
    denominator,
    rational: `${numerator}/${denominator}`,
    fps,
  };
}

export function parseFfprobeOutput(raw, {
  sourcePath = "unknown",
  sourceSizeBytes = undefined,
} = {}) {
  let payload;
  try {
    payload = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new PipelineError("ffprobe returned invalid JSON", {
      code: "INVALID_FFPROBE_JSON",
      stage: "probe",
      cause: error,
    });
  }

  invariant(payload && Array.isArray(payload.streams), "ffprobe did not return streams", {
    code: "FFPROBE_STREAMS_MISSING",
    stage: "probe",
  });

  const videoStream = payload.streams.find((stream) => stream.codec_type === "video");
  const audioStream = payload.streams.find((stream) => stream.codec_type === "audio");
  invariant(videoStream, "Uploaded media has no video stream", {
    code: "VIDEO_STREAM_MISSING",
    stage: "probe",
  });
  invariant(audioStream, "Uploaded media has no audio stream", {
    code: "AUDIO_STREAM_MISSING",
    stage: "probe",
  });

  const durationSec = finiteNumber(payload.format?.duration)
    ?? finiteNumber(videoStream.duration)
    ?? finiteNumber(audioStream.duration);
  invariant(durationSec > 0, "Uploaded media duration is missing or invalid", {
    code: "INVALID_MEDIA_DURATION",
    stage: "probe",
  });

  const width = finiteNumber(videoStream.width);
  const height = finiteNumber(videoStream.height);
  invariant(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0, "Video dimensions are invalid", {
    code: "INVALID_VIDEO_DIMENSIONS",
    stage: "probe",
  });

  const averageFrameRate = parseFrameRateRational(videoStream.avg_frame_rate);
  const nominalFrameRate = parseFrameRateRational(videoStream.r_frame_rate);
  const effectiveFrameRate = averageFrameRate ?? nominalFrameRate;

  return {
    sourcePath,
    sourceSizeBytes,
    durationSec,
    startTimeSec: finiteNumber(payload.format?.start_time) ?? 0,
    container: payload.format?.format_name ?? null,
    bitrate: finiteNumber(payload.format?.bit_rate) ?? null,
    video: {
      streamIndex: videoStream.index,
      codec: videoStream.codec_name ?? null,
      profile: videoStream.profile ?? null,
      width,
      height,
      fps: effectiveFrameRate?.fps ?? null,
      frameRate: effectiveFrameRate
        ? {
          ...effectiveFrameRate,
          source: averageFrameRate ? "avg_frame_rate" : "r_frame_rate",
        }
        : null,
      pixelFormat: videoStream.pix_fmt ?? null,
      rotation: finiteNumber(videoStream.tags?.rotate)
        ?? finiteNumber(videoStream.side_data_list?.find((item) => item.rotation !== undefined)?.rotation)
        ?? 0,
    },
    audio: {
      streamIndex: audioStream.index,
      codec: audioStream.codec_name ?? null,
      sampleRate: finiteNumber(audioStream.sample_rate) ?? null,
      channels: finiteNumber(audioStream.channels) ?? null,
      channelLayout: audioStream.channel_layout ?? null,
    },
    probedAt: new Date().toISOString(),
  };
}

export async function probeMedia({
  sourcePath,
  runner = runCommand,
  signal = undefined,
  verifyInput = true,
} = {}) {
  invariant(typeof sourcePath === "string" && sourcePath.length > 0, "sourcePath is required", {
    code: "SOURCE_PATH_REQUIRED",
    stage: "probe",
  });

  let sourceSizeBytes;
  if (verifyInput) {
    let info;
    try {
      info = await stat(sourcePath);
    } catch (error) {
      throw new PipelineError("Uploaded media is not readable", {
        code: "SOURCE_NOT_READABLE",
        stage: "probe",
        details: { sourcePath },
        cause: error,
      });
    }
    invariant(info.isFile() && info.size > 0, "Uploaded media must be a non-empty file", {
      code: "INVALID_SOURCE_FILE",
      stage: "probe",
      details: { sourcePath },
    });
    sourceSizeBytes = info.size;
  }

  const result = await runner("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    sourcePath,
  ], { signal });

  return parseFfprobeOutput(result.stdout, { sourcePath, sourceSizeBytes });
}
