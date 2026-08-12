import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command-runner.mjs";
import { invariant, PipelineError } from "./errors.mjs";

function roundMillis(value) {
  return Math.round(value * 1000) / 1000;
}

export function planAudioChunks({
  durationSec,
  chunkDurationSec = 600,
  overlapSec = 2,
} = {}) {
  invariant(Number.isFinite(durationSec) && durationSec > 0, "A positive duration is required", {
    code: "INVALID_AUDIO_DURATION",
    stage: "audio_plan",
  });
  invariant(Number.isFinite(chunkDurationSec) && chunkDurationSec > 0, "chunkDurationSec must be positive", {
    code: "INVALID_AUDIO_CHUNK_DURATION",
    stage: "audio_plan",
  });
  invariant(Number.isFinite(overlapSec) && overlapSec >= 0 && overlapSec < chunkDurationSec, "overlapSec must be smaller than the chunk duration", {
    code: "INVALID_AUDIO_CHUNK_OVERLAP",
    stage: "audio_plan",
  });

  const chunks = [];
  const step = chunkDurationSec - overlapSec;
  let startSec = 0;

  while (startSec < durationSec) {
    const endSec = Math.min(durationSec, startSec + chunkDurationSec);
    chunks.push({
      id: `audio_${String(chunks.length + 1).padStart(4, "0")}`,
      index: chunks.length,
      startSec: roundMillis(startSec),
      endSec: roundMillis(endSec),
      durationSec: roundMillis(endSec - startSec),
    });
    if (endSec >= durationSec) break;
    startSec += step;
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const previous = chunks[index - 1];
    const current = chunks[index];
    const next = chunks[index + 1];
    current.ownershipStartSec = previous
      ? roundMillis((previous.endSec + current.startSec) / 2)
      : 0;
    current.ownershipEndSec = next
      ? roundMillis((current.endSec + next.startSec) / 2)
      : roundMillis(durationSec);
  }

  assertChunkPlanCoverage(chunks, durationSec);
  return chunks;
}

export function assertChunkPlanCoverage(chunks, durationSec, toleranceSec = 0.002) {
  invariant(Array.isArray(chunks) && chunks.length > 0, "Audio chunk plan is empty", {
    code: "EMPTY_AUDIO_CHUNK_PLAN",
    stage: "audio_plan",
  });
  invariant(Math.abs(chunks[0].ownershipStartSec) <= toleranceSec, "Audio chunk ownership does not begin at zero", {
    code: "AUDIO_CHUNK_COVERAGE_GAP",
    stage: "audio_plan",
  });
  invariant(Math.abs(chunks.at(-1).ownershipEndSec - durationSec) <= toleranceSec, "Audio chunk ownership does not reach the media end", {
    code: "AUDIO_CHUNK_COVERAGE_GAP",
    stage: "audio_plan",
  });

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    invariant(chunk.startSec <= chunk.ownershipStartSec + toleranceSec, "Chunk ownership starts outside its media window", {
      code: "INVALID_AUDIO_OWNERSHIP",
      stage: "audio_plan",
      details: { chunk },
    });
    invariant(chunk.ownershipEndSec <= chunk.endSec + toleranceSec, "Chunk ownership ends outside its media window", {
      code: "INVALID_AUDIO_OWNERSHIP",
      stage: "audio_plan",
      details: { chunk },
    });
    if (index > 0) {
      invariant(Math.abs(chunks[index - 1].ownershipEndSec - chunk.ownershipStartSec) <= toleranceSec, "Audio chunk ownership contains a gap or overlap", {
        code: "AUDIO_CHUNK_COVERAGE_GAP",
        stage: "audio_plan",
        details: { previous: chunks[index - 1], current: chunk },
      });
    }
  }
  return true;
}

async function assertArtifact(filePath, stage) {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    throw new PipelineError("ffmpeg did not create the expected audio artifact", {
      code: "AUDIO_ARTIFACT_MISSING",
      stage,
      details: { filePath },
      cause: error,
    });
  }
  invariant(info.isFile() && info.size > 0, "Audio artifact is empty", {
    code: "AUDIO_ARTIFACT_EMPTY",
    stage,
    details: { filePath },
  });
}

export async function extractAudioTrack({
  sourcePath,
  outputPath,
  runner = runCommand,
  signal = undefined,
  verifyOutput = true,
} = {}) {
  invariant(sourcePath && outputPath, "sourcePath and outputPath are required", {
    code: "AUDIO_PATH_REQUIRED",
    stage: "audio_extract",
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await runner("ffmpeg", [
    "-v", "error",
    "-i", sourcePath,
    "-map", "0:a:0",
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    "-y",
    outputPath,
  ], { signal });
  if (verifyOutput) await assertArtifact(outputPath, "audio_extract");
  return {
    path: outputPath,
    codec: "pcm_s16le",
    sampleRate: 16000,
    channels: 1,
  };
}

export async function extractRemoteAsrAudio({
  sourcePath,
  outputPath,
  startSec = undefined,
  durationSec = undefined,
  runner = runCommand,
  signal = undefined,
  verifyOutput = true,
} = {}) {
  invariant(sourcePath && outputPath, "sourcePath and outputPath are required", {
    code: "AUDIO_PATH_REQUIRED",
    stage: "remote_asr_audio_extract",
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  invariant(
    startSec === undefined
      || (Number.isFinite(startSec) && startSec >= 0),
    "startSec must be a non-negative number",
    {
      code: "REMOTE_ASR_AUDIO_START_INVALID",
      stage: "remote_asr_audio_extract",
    },
  );
  invariant(
    durationSec === undefined
      || (Number.isFinite(durationSec) && durationSec > 0),
    "durationSec must be a positive number",
    {
      code: "REMOTE_ASR_AUDIO_DURATION_INVALID",
      stage: "remote_asr_audio_extract",
    },
  );
  const trimArgs = [
    ...(startSec === undefined
      ? []
      : ["-ss", Number(startSec).toFixed(3)]),
    ...(durationSec === undefined
      ? []
      : ["-t", Number(durationSec).toFixed(3)]),
  ];
  await runner("ffmpeg", [
    "-v", "error",
    ...trimArgs,
    "-i", sourcePath,
    "-map", "0:a:0",
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "libmp3lame",
    "-b:a", "64k",
    "-y",
    outputPath,
  ], { signal });
  if (verifyOutput) await assertArtifact(outputPath, "remote_asr_audio_extract");
  return {
    path: outputPath,
    format: "mp3",
    mimeType: "audio/mpeg",
    codec: "mp3",
    sampleRate: 16000,
    channels: 1,
    bitrate: 64_000,
    startSec: startSec ?? 0,
    durationSec: durationSec ?? null,
  };
}

export async function extractAudioChunks({
  sourcePath,
  outputDir,
  chunks,
  runner = runCommand,
  signal = undefined,
  verifyOutput = true,
} = {}) {
  invariant(sourcePath && outputDir, "sourcePath and outputDir are required", {
    code: "AUDIO_PATH_REQUIRED",
    stage: "audio_chunk_extract",
  });
  invariant(Array.isArray(chunks) && chunks.length > 0, "A non-empty audio chunk plan is required", {
    code: "EMPTY_AUDIO_CHUNK_PLAN",
    stage: "audio_chunk_extract",
  });

  await mkdir(outputDir, { recursive: true });
  const artifacts = [];
  for (const chunk of chunks) {
    const outputPath = path.join(outputDir, `${chunk.id}.flac`);
    await runner("ffmpeg", [
      "-v", "error",
      "-ss", chunk.startSec.toFixed(3),
      "-t", chunk.durationSec.toFixed(3),
      "-i", sourcePath,
      "-map", "0:a:0",
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "flac",
      "-y",
      outputPath,
    ], { signal });
    if (verifyOutput) await assertArtifact(outputPath, "audio_chunk_extract");
    artifacts.push({
      ...chunk,
      path: outputPath,
      mimeType: "audio/flac",
    });
  }
  return artifacts;
}
