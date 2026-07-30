import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command-runner.mjs";
import { PipelineError, invariant } from "./errors.mjs";

function roundMillis(value) {
  return Math.round(value * 1000) / 1000;
}

export function parseShotChangeTimestamps(stderr, {
  durationSec,
} = {}) {
  const timestamps = [];
  const pattern = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
  for (const match of String(stderr ?? "").matchAll(pattern)) {
    const timestamp = Number(match[1]);
    if (
      Number.isFinite(timestamp)
      && timestamp >= 0
      && (!Number.isFinite(durationSec) || timestamp <= durationSec)
    ) {
      timestamps.push(roundMillis(timestamp));
    }
  }
  return [...new Set(timestamps)].sort((left, right) => left - right);
}

export async function detectShotChanges({
  sourcePath,
  durationSec,
  threshold = 0.32,
  runner = runCommand,
  signal = undefined,
} = {}) {
  invariant(sourcePath, "sourcePath is required for shot detection", {
    code: "SOURCE_PATH_REQUIRED",
    stage: "shot_detection",
  });
  invariant(Number.isFinite(threshold) && threshold > 0 && threshold < 1, "Shot-change threshold must be between zero and one", {
    code: "INVALID_SHOT_THRESHOLD",
    stage: "shot_detection",
  });

  const result = await runner("ffmpeg", [
    "-hide_banner",
    "-i", sourcePath,
    "-an",
    "-vf", `select=gt(scene\\,${threshold}),showinfo`,
    "-vsync", "vfr",
    "-f", "null",
    "-",
  ], { signal });
  return parseShotChangeTimestamps(result.stderr, { durationSec });
}

export function planPeriodicTimestamps({
  durationSec,
  intervalSec = 10,
  endPaddingSec = 0.05,
} = {}) {
  invariant(Number.isFinite(durationSec) && durationSec > 0, "A positive duration is required for frame planning", {
    code: "INVALID_MEDIA_DURATION",
    stage: "frame_plan",
  });
  invariant(Number.isFinite(intervalSec) && intervalSec > 0, "Frame interval must be positive", {
    code: "INVALID_FRAME_INTERVAL",
    stage: "frame_plan",
  });

  const finalDecodableTimestamp = Math.max(0, durationSec - Math.min(endPaddingSec, durationSec / 2));
  const timestamps = [0];
  for (let timestamp = intervalSec; timestamp < finalDecodableTimestamp; timestamp += intervalSec) {
    timestamps.push(roundMillis(timestamp));
  }
  timestamps.push(roundMillis(finalDecodableTimestamp));
  return [...new Set(timestamps)].sort((left, right) => left - right);
}

export function assertPeriodicFrameCoverage(timestamps, {
  durationSec,
  intervalSec,
  toleranceSec = 0.1,
} = {}) {
  invariant(Array.isArray(timestamps) && timestamps.length > 0, "Periodic frame plan is empty", {
    code: "EMPTY_PERIODIC_FRAME_PLAN",
    stage: "frame_plan",
  });
  invariant(timestamps[0] <= toleranceSec, "Periodic frame plan does not cover the beginning", {
    code: "FRAME_COVERAGE_GAP",
    stage: "frame_plan",
  });
  invariant(durationSec - timestamps.at(-1) <= intervalSec + toleranceSec, "Periodic frame plan does not cover the media end", {
    code: "FRAME_COVERAGE_GAP",
    stage: "frame_plan",
  });
  for (let index = 1; index < timestamps.length; index += 1) {
    invariant(timestamps[index] - timestamps[index - 1] <= intervalSec + toleranceSec, "Periodic frame plan contains a coverage gap", {
      code: "FRAME_COVERAGE_GAP",
      stage: "frame_plan",
      details: {
        previous: timestamps[index - 1],
        current: timestamps[index],
        intervalSec,
      },
    });
  }
  return true;
}

export function mergeFrameTimestamps({
  periodicTimestamps,
  shotChangeTimestamps = [],
  dedupeToleranceSec = 0.08,
} = {}) {
  const entries = [
    ...periodicTimestamps.map((timestampSec) => ({ timestampSec, reason: "periodic" })),
    ...shotChangeTimestamps.map((timestampSec) => ({ timestampSec, reason: "shot_change" })),
  ].sort((left, right) => left.timestampSec - right.timestampSec);

  const merged = [];
  for (const entry of entries) {
    const previous = merged.at(-1);
    if (previous && Math.abs(previous.timestampSec - entry.timestampSec) <= dedupeToleranceSec) {
      if (!previous.reasons.includes(entry.reason)) previous.reasons.push(entry.reason);
      continue;
    }
    merged.push({
      timestampSec: roundMillis(entry.timestampSec),
      reasons: [entry.reason],
    });
  }
  return merged.map((entry, index) => ({
    id: `frame_${String(index + 1).padStart(6, "0")}`,
    ...entry,
  }));
}

export async function buildFrameExtractionPlan({
  sourcePath,
  durationSec,
  periodicIntervalSec = 10,
  shotChangeThreshold = 0.32,
  runner = runCommand,
  signal = undefined,
} = {}) {
  const periodicTimestamps = planPeriodicTimestamps({
    durationSec,
    intervalSec: periodicIntervalSec,
  });
  assertPeriodicFrameCoverage(periodicTimestamps, {
    durationSec,
    intervalSec: periodicIntervalSec,
  });
  const shotChangeTimestamps = await detectShotChanges({
    sourcePath,
    durationSec,
    threshold: shotChangeThreshold,
    runner,
    signal,
  });
  const frames = mergeFrameTimestamps({ periodicTimestamps, shotChangeTimestamps });

  return {
    sourcePath,
    durationSec,
    periodicIntervalSec,
    shotChangeThreshold,
    periodicTimestamps,
    shotChangeTimestamps,
    frames,
    coverage: {
      startsAtZero: periodicTimestamps[0] === 0,
      lastPeriodicTimestampSec: periodicTimestamps.at(-1),
      maximumPeriodicGapSec: Math.max(
        0,
        ...periodicTimestamps.slice(1).map((timestamp, index) => timestamp - periodicTimestamps[index]),
      ),
      fullTimelineScreeningPlanned: true,
      continuousVideoReviewPlanned: false,
    },
  };
}

async function assertFrameArtifact(filePath) {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    throw new PipelineError("ffmpeg did not create the expected frame", {
      code: "FRAME_ARTIFACT_MISSING",
      stage: "frame_extract",
      details: { filePath },
      cause: error,
    });
  }
  invariant(info.isFile() && info.size > 0, "Extracted frame is empty", {
    code: "FRAME_ARTIFACT_EMPTY",
    stage: "frame_extract",
    details: { filePath },
  });
}

export async function extractFrames({
  sourcePath,
  outputDir,
  plan,
  runner = runCommand,
  signal = undefined,
  verifyOutput = true,
  onProgress = undefined,
} = {}) {
  invariant(sourcePath && outputDir, "sourcePath and outputDir are required", {
    code: "FRAME_PATH_REQUIRED",
    stage: "frame_extract",
  });
  invariant(plan && Array.isArray(plan.frames) && plan.frames.length > 0, "A frame extraction plan is required", {
    code: "FRAME_PLAN_REQUIRED",
    stage: "frame_extract",
  });
  await mkdir(outputDir, { recursive: true });

  const frames = [];
  for (let index = 0; index < plan.frames.length; index += 1) {
    const frame = plan.frames[index];
    const outputPath = path.join(
      outputDir,
      `${frame.id}_${frame.timestampSec.toFixed(3).replace(".", "_")}.jpg`,
    );
    await runner("ffmpeg", [
      "-v", "error",
      "-ss", frame.timestampSec.toFixed(3),
      "-i", sourcePath,
      "-frames:v", "1",
      "-vf", "scale=min(1280\\,iw):-2",
      "-q:v", "2",
      "-y",
      outputPath,
    ], { signal });
    if (verifyOutput) await assertFrameArtifact(outputPath);
    frames.push({
      ...frame,
      path: outputPath,
      mimeType: "image/jpeg",
    });
    await onProgress?.({
      stage: "frame_extract",
      completed: index + 1,
      total: plan.frames.length,
      frameId: frame.id,
    });
  }

  return {
    sourcePath,
    durationSec: plan.durationSec,
    periodicIntervalSec: plan.periodicIntervalSec,
    shotChangeThreshold: plan.shotChangeThreshold,
    frames,
    coverage: {
      ...plan.coverage,
      extractedFrameCount: frames.length,
      periodicFrameCount: frames.filter((frame) => frame.reasons.includes("periodic")).length,
      shotChangeFrameCount: frames.filter((frame) => frame.reasons.includes("shot_change")).length,
      fullTimelineScreeningExtracted: true,
      continuousVideoReviewed: false,
    },
    generatedAt: new Date().toISOString(),
  };
}

function frameFileSort(left, right) {
  return left.localeCompare(right, "en", { numeric: true });
}

async function listExtractedFrames(directory, prefix) {
  const names = (await readdir(directory))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".jpg"))
    .sort(frameFileSort);
  for (const name of names) {
    await assertFrameArtifact(path.join(directory, name));
  }
  return names.map((name) => path.join(directory, name));
}

function reconcileSequentialFrameEvidence(paths, timestamps, {
  label,
  maximumTerminalDifference = 1,
} = {}) {
  const difference = Math.abs(paths.length - timestamps.length);
  invariant(
    paths.length > 0
    && timestamps.length > 0
    && difference <= maximumTerminalDifference,
    `Dense ${label} frame files do not match ffmpeg timestamp evidence`,
    {
      code: `DENSE_${String(label).toUpperCase()}_TIMESTAMP_MISMATCH`,
      stage: "dense_frame_extract",
      details: {
        frameFileCount: paths.length,
        timestampCount: timestamps.length,
        maximumTerminalDifference,
      },
    },
  );

  // ffmpeg's image2 muxer can omit or add one terminal output relative to
  // showinfo at EOF because the final decoded timestamp lands on the muxer's
  // rounding boundary. The streams remain positionally identical before that
  // terminal boundary. Pair the proven common prefix and let the subsequent
  // coverage checks fail closed if the retained periodic evidence no longer
  // reaches the end of the source.
  const commonCount = Math.min(paths.length, timestamps.length);
  return {
    paths: paths.slice(0, commonCount),
    timestamps: timestamps.slice(0, commonCount),
    terminalDifference: difference,
  };
}

function thinTimestamps(timestamps, minimumGapSec) {
  const thinned = [];
  for (const timestamp of timestamps) {
    const previous = thinned.at(-1);
    if (previous === undefined || timestamp - previous >= minimumGapSec) {
      thinned.push(timestamp);
    }
  }
  return thinned;
}

/**
 * Extracts a dense full-timeline manifest with two ffmpeg decoding passes,
 * rather than starting one ffmpeg process per frame. The first pass applies a
 * fixed interval to the complete video; the second adds scene-change frames.
 * showinfo timestamps are bound positionally to ffmpeg's sequential outputs
 * and mismatches fail closed.
 */
export async function extractDenseTimelineFrames({
  sourcePath,
  outputDir,
  durationSec,
  intervalSec = 2,
  shotChangeThreshold = 0.32,
  minimumShotGapSec = 0.35,
  maximumWidth = 768,
  runner = runCommand,
  signal = undefined,
  onProgress = undefined,
} = {}) {
  invariant(sourcePath && outputDir, "Dense frame source and output paths are required", {
    code: "DENSE_FRAME_PATH_REQUIRED",
    stage: "dense_frame_extract",
  });
  invariant(Number.isFinite(durationSec) && durationSec > 0, "Dense frame duration must be positive", {
    code: "INVALID_MEDIA_DURATION",
    stage: "dense_frame_extract",
  });
  invariant(Number.isFinite(intervalSec) && intervalSec > 0, "Dense frame interval must be positive", {
    code: "INVALID_FRAME_INTERVAL",
    stage: "dense_frame_extract",
  });
  invariant(Number.isFinite(maximumWidth) && maximumWidth >= 320, "Dense frame width is invalid", {
    code: "INVALID_DENSE_FRAME_WIDTH",
    stage: "dense_frame_extract",
  });
  await mkdir(outputDir, { recursive: true });
  // A two-core production worker needs materially longer than the generic
  // ten-minute command budget to decode a multi-hour livestream twice. Keep a
  // finite fail-closed deadline, but derive it from source duration so a
  // healthy full-timeline pass is never killed merely because the source is
  // long.
  const commandTimeoutMs = Math.max(
    30 * 60 * 1000,
    Math.ceil(durationSec * 250),
  );
  const commandOptions = {
    signal,
    timeoutMs: commandTimeoutMs,
    maxOutputBytes: 64 * 1024 * 1024,
  };

  const periodicPattern = path.join(outputDir, "periodic_%07d.jpg");
  const periodicResult = await runner("ffmpeg", [
    "-hide_banner",
    "-loglevel", "info",
    "-i", sourcePath,
    "-an",
    "-vf",
    `fps=fps=1/${intervalSec}:start_time=0,scale=min(${maximumWidth}\\,iw):-2,showinfo`,
    "-fps_mode", "vfr",
    "-q:v", "3",
    "-y",
    periodicPattern,
  ], commandOptions);
  const parsedPeriodicTimestamps = parseShotChangeTimestamps(periodicResult.stderr, {
    durationSec,
  });
  const extractedPeriodicPaths = await listExtractedFrames(outputDir, "periodic_");
  const periodicEvidence = reconcileSequentialFrameEvidence(
    extractedPeriodicPaths,
    parsedPeriodicTimestamps,
    { label: "periodic" },
  );
  const periodicPaths = periodicEvidence.paths;
  const periodicTimestamps = periodicEvidence.timestamps;
  assertPeriodicFrameCoverage(periodicTimestamps, {
    durationSec,
    intervalSec,
    toleranceSec: 0.25,
  });
  await onProgress?.({
    stage: "dense_frame_extract",
    phase: "periodic",
    completed: 1,
    total: 2,
    frameCount: periodicPaths.length,
  });

  const shotPattern = path.join(outputDir, "shot_%07d.jpg");
  const shotResult = await runner("ffmpeg", [
    "-hide_banner",
    "-loglevel", "info",
    "-i", sourcePath,
    "-an",
    "-vf",
    `select=gt(scene\\,${shotChangeThreshold}),scale=min(${maximumWidth}\\,iw):-2,showinfo`,
    "-fps_mode", "vfr",
    "-q:v", "3",
    "-y",
    shotPattern,
  ], commandOptions);
  const parsedShotTimestamps = parseShotChangeTimestamps(shotResult.stderr, {
    durationSec,
  });
  const extractedShotPaths = await listExtractedFrames(outputDir, "shot_");
  let rawShotPaths = extractedShotPaths;
  let rawShotTimestamps = parsedShotTimestamps;
  if (extractedShotPaths.length || parsedShotTimestamps.length) {
    const shotEvidence = reconcileSequentialFrameEvidence(
      extractedShotPaths,
      parsedShotTimestamps,
      { label: "shot" },
    );
    rawShotPaths = shotEvidence.paths;
    rawShotTimestamps = shotEvidence.timestamps;
  }

  const keptShotTimestamps = thinTimestamps(rawShotTimestamps, minimumShotGapSec);
  const keptShotTimestampSet = new Set(keptShotTimestamps);
  const shotEntries = rawShotTimestamps
    .map((timestampSec, index) => ({
      timestampSec,
      path: rawShotPaths[index],
    }))
    .filter((entry) => keptShotTimestampSet.has(entry.timestampSec));
  const entries = [
    ...periodicTimestamps.map((timestampSec, index) => ({
      timestampSec,
      path: periodicPaths[index],
      reasons: ["periodic"],
    })),
    ...shotEntries.map((entry) => ({
      ...entry,
      reasons: ["shot_change"],
    })),
  ].sort((left, right) => left.timestampSec - right.timestampSec);

  const merged = [];
  for (const entry of entries) {
    const previous = merged.at(-1);
    if (previous && Math.abs(previous.timestampSec - entry.timestampSec) <= 0.08) {
      previous.reasons = [...new Set([...previous.reasons, ...entry.reasons])];
      continue;
    }
    merged.push(entry);
  }
  const frames = merged.map((entry, index) => ({
    id: `dense_frame_${String(index + 1).padStart(7, "0")}`,
    timestampSec: roundMillis(entry.timestampSec),
    reasons: entry.reasons,
    path: entry.path,
    mimeType: "image/jpeg",
  }));
  invariant(frames.length >= periodicPaths.length, "Dense frame merge lost periodic coverage evidence", {
    code: "DENSE_FRAME_MERGE_COVERAGE_LOSS",
    stage: "dense_frame_extract",
  });
  await onProgress?.({
    stage: "dense_frame_extract",
    phase: "shot_change",
    completed: 2,
    total: 2,
    frameCount: frames.length,
  });

  return {
    sourcePath,
    durationSec,
    periodicIntervalSec: intervalSec,
    shotChangeThreshold,
    frames,
    coverage: {
      startsAtZero: periodicTimestamps[0] <= 0.25,
      lastPeriodicTimestampSec: periodicTimestamps.at(-1),
      maximumPeriodicGapSec: Math.max(
        0,
        ...periodicTimestamps
          .slice(1)
          .map((timestamp, index) => timestamp - periodicTimestamps[index]),
      ),
      extractedFrameCount: frames.length,
      periodicFrameCount: periodicPaths.length,
      shotChangeFrameCount: shotEntries.length,
      rawShotChangeFrameCount: rawShotPaths.length,
      shotChangeMinimumGapSec: minimumShotGapSec,
      extractionPassCount: 2,
      fullTimelineScreeningExtracted: true,
      continuousVideoReviewed: false,
      limitation:
        "Two ffmpeg decoding passes extracted fixed-interval and scene-change still frames. This proves still-frame coverage only, not continuous video review.",
    },
    generatedAt: new Date().toISOString(),
  };
}
