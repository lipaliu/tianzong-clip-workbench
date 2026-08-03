import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command-runner.mjs";
import { PipelineError, invariant } from "./errors.mjs";

async function assertProxyArtifact(filePath) {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    throw new PipelineError("ffmpeg did not create the candidate review proxy", {
      code: "CANDIDATE_PROXY_MISSING",
      stage: "candidate_proxy",
      details: { filePath },
      cause: error,
    });
  }
  invariant(info.isFile() && info.size > 0, "Candidate review proxy is empty", {
    code: "CANDIDATE_PROXY_EMPTY",
    stage: "candidate_proxy",
    details: { filePath },
  });
}

function roundMillis(value) {
  return Math.round(value * 1_000) / 1_000;
}

function keptRanges(candidate) {
  const recall = candidate.recallWindow;
  const removals = (candidate.deleteSuggestions ?? [])
    .map((range) => ({
      startSec: Math.max(recall.startSec, range.startSec),
      endSec: Math.min(recall.endSec, range.endSec),
    }))
    .filter((range) => range.endSec > range.startSec)
    .sort((left, right) => left.startSec - right.startSec);
  const merged = [];
  for (const range of removals) {
    const previous = merged.at(-1);
    if (previous && range.startSec <= previous.endSec + 0.02) {
      previous.endSec = Math.max(previous.endSec, range.endSec);
    } else {
      merged.push({ ...range });
    }
  }
  const keeps = [];
  let cursor = recall.startSec;
  for (const removal of merged) {
    if (removal.startSec > cursor + 0.02) {
      keeps.push({
        startSec: roundMillis(cursor),
        endSec: roundMillis(removal.startSec),
      });
    }
    cursor = Math.max(cursor, removal.endSec);
  }
  if (recall.endSec > cursor + 0.02) {
    keeps.push({
      startSec: roundMillis(cursor),
      endSec: roundMillis(recall.endSec),
    });
  }
  return keeps;
}

export async function renderCandidateSafetyProxy({
  sourcePath,
  candidate,
  outputPath,
  mediaDurationSec,
  runner = runCommand,
  signal = undefined,
  verifyOutput = true,
  timeoutMs = 30 * 60 * 1_000,
} = {}) {
  invariant(sourcePath && outputPath, "sourcePath and outputPath are required", {
    code: "CANDIDATE_PROXY_PATH_REQUIRED",
    stage: "candidate_proxy",
  });
  invariant(candidate?.validationStatus === "editorial_candidate_needs_av_review", "Only unverified editorial candidates can enter proxy review", {
    code: "INVALID_CANDIDATE_PROXY_STATE",
    stage: "candidate_proxy",
    details: { candidateId: candidate?.candidateId, validationStatus: candidate?.validationStatus },
  });
  const { startSec, endSec } = candidate.safetyWindow ?? {};
  invariant(
    Number.isFinite(startSec)
    && Number.isFinite(endSec)
    && startSec >= 0
    && endSec > startSec
    && (!Number.isFinite(mediaDurationSec) || endSec <= mediaDurationSec + 0.05),
    "Candidate safety window is invalid",
    {
      code: "INVALID_CANDIDATE_WINDOW",
      stage: "candidate_proxy",
      details: { candidateId: candidate.candidateId, safetyWindow: candidate.safetyWindow },
    },
  );
  await mkdir(path.dirname(outputPath), { recursive: true });

  await runner("ffmpeg", [
    "-v", "error",
    "-ss", startSec.toFixed(3),
    "-i", sourcePath,
    "-t", (endSec - startSec).toFixed(3),
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-vf", "scale=-2:min(1280\\,ih)",
    "-c:v", "libx264",
    "-threads", "1",
    "-preset", "veryfast",
    "-crf", "25",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "-y",
    outputPath,
  ], { signal, timeoutMs });
  if (verifyOutput) await assertProxyArtifact(outputPath);

  return {
    candidateId: candidate.candidateId,
    path: outputPath,
    sourceWindow: {
      startSec,
      endSec,
      durationSec: Math.round((endSec - startSec) * 1000) / 1000,
    },
    purpose: "continuous_normal_playback_review",
    includesAudio: true,
    includesVideo: true,
    isFinalCut: false,
    validationStatus: "proxy_rendered_needs_human_normal_playback",
    generatedAt: new Date().toISOString(),
  };
}

export async function renderCandidateRoughCut({
  sourcePath,
  candidate,
  outputPath,
  mediaDurationSec,
  runner = runCommand,
  signal = undefined,
  verifyOutput = true,
} = {}) {
  invariant(sourcePath && outputPath, "sourcePath and outputPath are required", {
    code: "CANDIDATE_PROXY_PATH_REQUIRED",
    stage: "candidate_rough_cut",
  });
  invariant(
    candidate?.validationStatus === "editorial_candidate_needs_av_review"
    && candidate.semanticClosureStatus === "complete"
    && typeof candidate.tianzongSpeakerLabel === "string"
    && candidate.tianzongSpeakerLabel.length > 0
    && typeof candidate.openingSegmentId === "string"
    && typeof candidate.closingSegmentId === "string",
    "Only complete Tianzong-bound candidates can be rendered as rough cuts",
    {
      code: "CANDIDATE_ROUGH_CUT_NOT_DELIVERABLE",
      stage: "candidate_rough_cut",
      details: {
        candidateId: candidate?.candidateId,
        semanticClosureStatus: candidate?.semanticClosureStatus,
        tianzongSpeakerLabel: candidate?.tianzongSpeakerLabel,
      },
    },
  );
  const { startSec, endSec } = candidate.recallWindow ?? {};
  invariant(
    Number.isFinite(startSec)
    && Number.isFinite(endSec)
    && startSec >= 0
    && endSec > startSec
    && (!Number.isFinite(mediaDurationSec) || endSec <= mediaDurationSec + 0.05),
    "Candidate recall window is invalid",
    {
      code: "INVALID_CANDIDATE_WINDOW",
      stage: "candidate_rough_cut",
      details: { candidateId: candidate.candidateId, recallWindow: candidate.recallWindow },
    },
  );
  const ranges = keptRanges(candidate);
  invariant(ranges.length > 0, "Candidate deletions remove the entire rough cut", {
    code: "CANDIDATE_ROUGH_CUT_EMPTY",
    stage: "candidate_rough_cut",
    details: { candidateId: candidate.candidateId },
  });
  const filterParts = [];
  const concatInputs = [];
  const inputStartSec = Math.max(0, ranges[0].startSec - 0.25);
  const inputEndSec = ranges.at(-1).endSec;
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const localStartSec = roundMillis(range.startSec - inputStartSec);
    const localEndSec = roundMillis(range.endSec - inputStartSec);
    filterParts.push(
      `[0:v:0]trim=start=${localStartSec.toFixed(3)}:end=${localEndSec.toFixed(3)},`
      + `setpts=PTS-STARTPTS,scale=-2:min(1280\\,ih)[v${index}]`,
      `[0:a:0]atrim=start=${localStartSec.toFixed(3)}:end=${localEndSec.toFixed(3)},`
      + `asetpts=PTS-STARTPTS[a${index}]`,
    );
    concatInputs.push(`[v${index}][a${index}]`);
  }
  filterParts.push(
    `${concatInputs.join("")}concat=n=${ranges.length}:v=1:a=1[vout][aout]`,
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await runner("ffmpeg", [
    "-v", "error",
    "-ss", inputStartSec.toFixed(3),
    "-i", sourcePath,
    "-t", (inputEndSec - inputStartSec).toFixed(3),
    "-filter_complex", filterParts.join(";"),
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "-y",
    outputPath,
  ], { signal });
  if (verifyOutput) await assertProxyArtifact(outputPath);

  return {
    candidateId: candidate.candidateId,
    path: outputPath,
    sourceWindow: {
      startSec,
      endSec,
      durationSec: roundMillis(
        ranges.reduce(
          (sum, range) => sum + range.endSec - range.startSec,
          0,
        ),
      ),
    },
    keptRanges: ranges,
    removedRanges: candidate.deleteSuggestions ?? [],
    purpose: "tianzong_only_right_biased_rough_cut",
    includesAudio: true,
    includesVideo: true,
    isFinalCut: false,
    validationStatus: "rough_cut_rendered_needs_human_normal_playback",
    generatedAt: new Date().toISOString(),
  };
}

export async function renderCandidateSafetyProxies({
  sourcePath,
  candidates,
  outputDir,
  mediaDurationSec,
  runner = runCommand,
  signal = undefined,
  verifyOutput = true,
  onProgress = undefined,
} = {}) {
  invariant(Array.isArray(candidates), "Candidate list is required", {
    code: "CANDIDATES_REQUIRED",
    stage: "candidate_proxy",
  });
  const proxies = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const outputPath = path.join(outputDir, `${candidate.candidateId}_review.mp4`);
    proxies.push(await renderCandidateSafetyProxy({
      sourcePath,
      candidate,
      outputPath,
      mediaDurationSec,
      runner,
      signal,
      verifyOutput,
    }));
    await onProgress?.({
      stage: "candidate_proxy",
      completed: index + 1,
      total: candidates.length,
      candidateId: candidate.candidateId,
    });
  }
  return proxies;
}
