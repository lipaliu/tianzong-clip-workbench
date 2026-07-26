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

export async function renderCandidateSafetyProxy({
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
    "-i", sourcePath,
    "-ss", startSec.toFixed(3),
    "-t", (endSec - startSec).toFixed(3),
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-vf", "scale=-2:min(1280\\,ih)",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "25",
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
