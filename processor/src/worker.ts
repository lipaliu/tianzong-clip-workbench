import { hostname } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { analyzeCandidateWindows } from "./candidate-analysis.js";
import { loadConfig } from "./config.js";
import {
  loadTianClipCore,
  TianClipCoreError,
  type LoadedTianClipCore,
} from "./core/index.js";
import { createDatabase } from "./db.js";
import {
  buildAndValidateEngineArtifacts,
  type EngineArtifacts,
} from "./engine-artifacts.js";
import { AppError, internalErrorMessage } from "./errors.js";
import { hashAndSize, safeWorkName } from "./media.js";
import {
  planAudioChunks,
  extractAudioChunks,
} from "./pipeline/audio.mjs";
import { createOpenAIClient } from "./pipeline/openai-client.mjs";
import {
  buildFrameExtractionPlan,
  extractDenseTimelineFrames,
  extractFrames,
} from "./pipeline/frames.mjs";
import {
  analyzeDenseVisualRecall,
  augmentVisualMapWithDenseRecall,
  mergeTextAndVisualCandidateResults,
} from "./pipeline/dense-visual-recall.mjs";
import { refineCandidatesWithDenseEvidence } from "./pipeline/candidate-refinement.mjs";
import { probeMedia } from "./pipeline/media.mjs";
import { renderCandidateSafetyProxy } from "./pipeline/proxy.mjs";
import { checkMediaToolchain } from "./pipeline/toolchain.mjs";
import { transcribeAudioChunks } from "./pipeline/transcription.mjs";
import { analyzeVisualTimeline } from "./pipeline/visual-map.mjs";
import { ProcessorRepository } from "./repository.js";
import { renderCandidateRevision } from "./revision-render.js";
import { PrivateObjectStorage } from "./storage.js";
import type {
  CandidatePayload,
  ClaimedJob,
  ClaimedRender,
} from "./types.js";

type AnyFunction = (...args: any[]) => any;

const audioPlan = planAudioChunks as AnyFunction;
const audioExtract = extractAudioChunks as AnyFunction;
const mediaProbe = probeMedia as AnyFunction;
const framePlan = buildFrameExtractionPlan as AnyFunction;
const frameExtract = extractFrames as AnyFunction;
const denseFrameExtract = extractDenseTimelineFrames as AnyFunction;
const transcribe = transcribeAudioChunks as AnyFunction;
const visualAnalyze = analyzeVisualTimeline as AnyFunction;
const denseVisualRecall = analyzeDenseVisualRecall as AnyFunction;
const visualMapAugment = augmentVisualMapWithDenseRecall as AnyFunction;
const candidateSourceMerge = mergeTextAndVisualCandidateResults as AnyFunction;
const candidateDenseRefine = refineCandidatesWithDenseEvidence as AnyFunction;
const renderRoughProxy = renderCandidateSafetyProxy as AnyFunction;
const toolchainCheck = checkMediaToolchain as AnyFunction;

const config = loadConfig();
const database = createDatabase(config);
const repository = new ProcessorRepository(database, config);
const storage = new PrivateObjectStorage(config);
const openai = createOpenAIClient({
  apiKey: config.openai.apiKey,
  baseUrl: config.openai.baseUrl,
});
const workerId = `${hostname()}:${process.pid}:${crypto.randomUUID()}`;
let stopping = false;

function r2Uri(objectKey: string): string {
  return `r2://${config.r2.bucket}/${objectKey}`;
}

async function withJobHeartbeat<T>(
  job: ClaimedJob,
  operation: () => Promise<T>,
): Promise<T> {
  let leaseError: unknown;
  const interval = setInterval(() => {
    void repository.heartbeat(job.id, job.workerId).catch((error) => {
      leaseError = error;
    });
  }, Math.max(5_000, Math.floor(config.worker.leaseSeconds * 1_000 / 3)));
  interval.unref();
  try {
    const result = await operation();
    if (leaseError) throw leaseError;
    return result;
  } finally {
    clearInterval(interval);
  }
}

async function withRenderHeartbeat<T>(
  render: ClaimedRender,
  operation: () => Promise<T>,
): Promise<T> {
  let leaseError: unknown;
  const interval = setInterval(() => {
    void repository.heartbeatRender(render.id, render.workerId).catch((error) => {
      leaseError = error;
    });
  }, Math.max(5_000, Math.floor(config.worker.leaseSeconds * 1_000 / 3)));
  interval.unref();
  try {
    const result = await operation();
    if (leaseError) throw leaseError;
    return result;
  } finally {
    clearInterval(interval);
  }
}

async function loadBoundCore(
  corePath: string,
  mode: "chat" | "sales",
): Promise<LoadedTianClipCore> {
  return await loadTianClipCore({
    corePath,
    expectedSha256: config.core.sha256,
    expectedVersion: config.core.version,
    expectedPromptVersion: config.core.promptVersion,
    expectedSchemaVersion: config.core.schemaVersion,
    expectedFactSchemaVersion: config.core.factSchemaVersion,
    expectedLedgerSchemaVersion: config.core.ledgerSchemaVersion,
    mode,
    allowedReleaseStatuses: ["private_candidate"],
  });
}

async function processAnalysisJob(job: ClaimedJob): Promise<void> {
  const workDir = join(
    config.worker.workDirectory,
    `${job.id}-${job.attempt}`,
  );
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  try {
    await repository.updateJobStage(
      job.id,
      job.workerId,
      "downloading",
      4,
      "正在从私有存储读取整场直播。",
    );
    const sourcePath = join(workDir, safeWorkName(job.sourceName));
    await storage.download(job.objectKey, sourcePath);
    const sourceIntegrity = await hashAndSize(sourcePath);
    if (
      sourceIntegrity.sizeBytes !== job.expectedSizeBytes
      || sourceIntegrity.sizeBytes > config.r2.maxUploadBytes
    ) {
      throw new AppError(
        409,
        "source_size_mismatch",
        "原片下载后的大小与上传记录不一致。",
      );
    }
    if (
      job.expectedSha256 !== null
      && sourceIntegrity.sha256 !== job.expectedSha256
    ) {
      throw new AppError(
        409,
        "source_hash_mismatch",
        "原片 SHA-256 与上传声明不一致。",
      );
    }
    await repository.markUploadVerified({
      jobId: job.id,
      workerId: job.workerId,
      uploadId: job.uploadId,
      actualSizeBytes: sourceIntegrity.sizeBytes,
      actualSha256: sourceIntegrity.sha256,
    });

    await repository.updateJobStage(
      job.id,
      job.workerId,
      "binding_private_core",
      9,
      "正在绑定并校验私有天总切片核心。",
    );
    const corePath = join(workDir, "tianclip-private-core.skill");
    await storage.download(config.core.objectKey, corePath);
    const mode = job.mode === "聊播" ? "chat" : "sales";
    const core = await loadBoundCore(corePath, mode);
    const coreBundle = {
      coreId: core.provenance.coreId,
      coreVersion: core.provenance.coreVersion,
      coreSha256: core.provenance.coreSha256,
      promptVersion: core.provenance.promptVersion,
      privateKnowledge: core.prompt.text,
      modeRules:
        `执行已绑定的 ${mode} 私有 prompt bundle；不得退回通用短视频规则。`,
    };

    await repository.updateJobStage(
      job.id,
      job.workerId,
      "probing",
      13,
      "正在读取音画轨道和原片时基。",
    );
    const media = await mediaProbe({ sourcePath });

    await repository.updateJobStage(
      job.id,
      job.workerId,
      "transcribing",
      18,
      "正在分段转写并保留说话人和绝对时间码。",
    );
    const chunks = audioPlan({
      durationSec: media.durationSec,
      chunkDurationSec: config.worker.transcriptionSegmentSeconds,
      overlapSec: 2,
    });
    const audioChunks = await audioExtract({
      sourcePath,
      outputDir: join(workDir, "audio"),
      chunks,
    });
    const transcript = await transcribe({
      chunks: audioChunks,
      client: openai,
      mediaDurationSec: media.durationSec,
      language: "zh",
      model: config.openai.transcriptionModel,
      // gpt-4o-transcribe-diarize does not accept a prompt. The private core
      // is deliberately applied only at candidate reasoning time.
      onProgress: async (event: { completed: number; total: number }) => {
        const progress = 20 + Math.floor(22 * event.completed / event.total);
        await repository.updateJobStage(
          job.id,
          job.workerId,
          "transcribing",
          progress,
          `逐字稿分段 ${event.completed}/${event.total} 已完成。`,
        );
      },
    });

    await repository.updateJobStage(
      job.id,
      job.workerId,
      "sparse_visual_screening",
      44,
      "正在抽取定时帧和镜头变化帧；这是稀疏视觉筛查，不等于连续观看。",
    );
    const plannedFrames = await framePlan({
      sourcePath,
      durationSec: media.durationSec,
      periodicIntervalSec: config.worker.visionSampleSeconds,
    });
    const frameManifest = await frameExtract({
      sourcePath,
      outputDir: join(workDir, "frames"),
      plan: plannedFrames,
    });
    const visualMap = await visualAnalyze({
      frameManifest,
      client: openai,
      model: config.openai.visionModel,
      framesPerBatch: config.worker.visionBatchSize,
      safetyIdentifier: job.projectId,
      onProgress: async (event: { completed: number; total: number }) => {
        const progress = 48 + Math.floor(18 * event.completed / event.total);
        await repository.updateJobStage(
          job.id,
          job.workerId,
          "sparse_visual_screening",
          progress,
          `稀疏视觉批次 ${event.completed}/${event.total} 已完成。`,
        );
      },
    });

    await repository.updateJobStage(
      job.id,
      job.workerId,
      "dense_visual_reverse_recall",
      68,
      `正在用两次全片解码抽取每 ${config.worker.candidateFrameSeconds} 秒与镜头变化帧，并做视觉反向补召回。`,
    );
    const denseFrameManifest = await denseFrameExtract({
      sourcePath,
      outputDir: join(workDir, "dense-frames"),
      durationSec: media.durationSec,
      intervalSec: config.worker.candidateFrameSeconds,
      onProgress: async (event: {
        phase: string;
        completed: number;
        total: number;
        frameCount: number;
      }) => {
        await repository.updateJobStage(
          job.id,
          job.workerId,
          "dense_visual_reverse_recall",
          68 + Math.floor(4 * event.completed / event.total),
          event.phase === "periodic"
            ? `全片每 ${config.worker.candidateFrameSeconds} 秒密集帧已抽取 ${event.frameCount} 张。`
            : `镜头变化帧已合并，共 ${event.frameCount} 张视觉证据。`,
        );
      },
    });
    const denseRecallResult = await denseVisualRecall({
      frameManifest: denseFrameManifest,
      transcript,
      coreBundle,
      mode,
      client: openai,
      model: config.openai.visionModel,
      expectedPeriodicIntervalSec: config.worker.candidateFrameSeconds,
      framesPerBatch: Math.max(18, config.worker.visionBatchSize * 3),
      overlapFrames: 2,
      safetyIdentifier: job.projectId,
      onProgress: async (event: { completed: number; total: number }) => {
        const progress = 72 + Math.floor(7 * event.completed / event.total);
        await repository.updateJobStage(
          job.id,
          job.workerId,
          "dense_visual_reverse_recall",
          progress,
          `视觉反向补召回批次 ${event.completed}/${event.total} 已完成；输入不含逐字稿。`,
        );
      },
    });
    const augmentedVisualMap = visualMapAugment(
      visualMap,
      denseRecallResult,
    );

    await repository.updateJobStage(
      job.id,
      job.workerId,
      "private_core_reasoning",
      80,
      "私有天总核心正在从逐字稿自然召回，再与视觉反向候选合并，不预设条数。",
    );
    const textCandidateResult = await analyzeCandidateWindows({
      transcript,
      visualMap: augmentedVisualMap,
      core,
      mode,
      client: openai,
      model: config.openai.reasoningModel,
      analysisWindowSeconds: config.worker.analysisWindowSeconds,
      safetyIdentifier: job.projectId,
      onProgress: async (event) => {
        const progress = 80 + Math.floor(5 * event.completed / event.total);
        await repository.updateJobStage(
          job.id,
          job.workerId,
          "private_core_reasoning",
          progress,
          `私有核心分析窗口 ${event.completed}/${event.total} 已完成。`,
        );
      },
    });
    const mergedCandidateResult = candidateSourceMerge({
      textResult: textCandidateResult,
      visualResult: denseRecallResult,
      transcript,
      visualMap: augmentedVisualMap,
      coreBundle,
      mode,
      model: config.openai.reasoningModel,
    });

    await repository.updateJobStage(
      job.id,
      job.workerId,
      "candidate_dense_refinement",
      86,
      "正在逐候选读取安全窗密集画面与逐字稿，校正切口并标记动作完整性风险。",
    );
    const candidateResult = await candidateDenseRefine({
      candidateResult: mergedCandidateResult,
      transcript,
      visualMap: augmentedVisualMap,
      frameManifest: denseFrameManifest,
      coreBundle,
      mode,
      client: openai,
      model: config.openai.visionModel,
      safetyIdentifier: job.projectId,
      onProgress: async (event: { completed: number; total: number }) => {
        const progress = 86
          + Math.floor(4 * event.completed / Math.max(1, event.total));
        await repository.updateJobStage(
          job.id,
          job.workerId,
          "candidate_dense_refinement",
          progress,
          `候选安全窗二次理解 ${event.completed}/${event.total} 已完成；仍需人工正常倍速确认。`,
        );
      },
    });
    const evidenceVisualMap = candidateResult.visualMap;

    const artifactBase = `artifacts/${job.projectId}/${job.id}`;
    const transcriptKey = `${artifactBase}/transcript.json`;
    const denseVisualRecallKey = `${artifactBase}/dense-visual-recall.json`;
    const candidateRefinementKey = `${artifactBase}/candidate-refinement.json`;
    const factLayerKey = `${artifactBase}/fact-layer.json`;
    const editPlanKey = `${artifactBase}/edit-plan.json`;
    const engineLedgerKey = `${artifactBase}/engine-run-ledger.json`;
    const transcriptStored = await storage.uploadJson(
      transcriptKey,
      transcript,
      {
        "project-id": job.projectId,
        "job-id": job.id,
        kind: "diarized-transcript",
      },
    );
    const [denseVisualRecallStored, candidateRefinementStored] =
      await Promise.all([
        storage.uploadJson(
          denseVisualRecallKey,
          {
            model: denseRecallResult.model,
            method: denseRecallResult.method,
            events: denseRecallResult.events,
            candidates: denseRecallResult.candidates,
            selectionSummary: denseRecallResult.selectionSummary,
            runs: denseRecallResult.runs,
            unboundProposals: denseRecallResult.unboundProposals,
            coverage: denseRecallResult.coverage,
            generatedAt: denseRecallResult.generatedAt,
          },
          {
            "project-id": job.projectId,
            "job-id": job.id,
            kind: "dense-visual-reverse-recall",
          },
        ),
        storage.uploadJson(
          candidateRefinementKey,
          {
            refinementSummary: candidateResult.refinementSummary,
            refinementRuns: candidateResult.refinementRuns,
          },
          {
            "project-id": job.projectId,
            "job-id": job.id,
            kind: "candidate-dense-still-transcript-refinement",
          },
        ),
      ]);

    await repository.updateJobStage(
      job.id,
      job.workerId,
      "validating_private_contract",
      91,
      "正在生成事实层、编辑计划和运行台账，并用私有核心校验。",
    );
    const artifacts: EngineArtifacts = buildAndValidateEngineArtifacts({
      job,
      media,
      sourceSha256: sourceIntegrity.sha256,
      transcript,
      visualMap: evidenceVisualMap,
      candidateResult: candidateResult as never,
      core,
      artifactUris: {
        sourceMedia: r2Uri(job.objectKey),
        transcript: r2Uri(transcriptKey),
      },
    });

    await repository.updateJobStage(
      job.id,
      job.workerId,
      "rendering_rough_proxies",
      93,
      "正在生成无字幕、无包装的候选粗剪，等待人工完整播放。",
    );
    const previewDir = join(workDir, "rough-previews");
    await mkdir(previewDir, { recursive: true });
    for (let index = 0; index < artifacts.candidatePayloads.length; index += 1) {
      const payload = artifacts.candidatePayloads[index]!;
      // engine-artifacts preserves candidate order while exposing the
      // publish-safe window in the public payload. Bind by that stable order,
      // never by comparing recall and safety-window floats.
      const sourceCandidate = candidateResult.candidates[index];
      if (!sourceCandidate) {
        throw new AppError(
          500,
          "candidate_mapping_failed",
          "候选与编辑计划的时间窗无法对应。",
          { expose: false },
        );
      }
      const outputPath = join(previewDir, `${payload.id}.mp4`);
      await renderRoughProxy({
        sourcePath,
        candidate: sourceCandidate,
        outputPath,
        mediaDurationSec: media.durationSec,
      });
      await storage.uploadFile(
        `previews/${job.projectId}/${payload.id}.mp4`,
        outputPath,
        "video/mp4",
        {
          "project-id": job.projectId,
          "job-id": job.id,
          "candidate-id": payload.id,
          "preview-kind": "rough-cut-needs-human-normal-playback",
        },
      );
      await repository.updateJobStage(
        job.id,
        job.workerId,
        "rendering_rough_proxies",
        93 + Math.floor(5 * (index + 1) / Math.max(1, artifacts.candidatePayloads.length)),
        `候选粗剪 ${index + 1}/${artifacts.candidatePayloads.length} 已生成。`,
      );
    }

    const [factStored, planStored, ledgerStored] = await Promise.all([
      storage.uploadJson(factLayerKey, artifacts.factLayer, {
        "project-id": job.projectId,
        "job-id": job.id,
        kind: "fact-layer",
      }),
      storage.uploadJson(editPlanKey, artifacts.editPlan, {
        "project-id": job.projectId,
        "job-id": job.id,
        kind: "edit-plan",
      }),
      storage.uploadJson(engineLedgerKey, artifacts.engineLedger, {
        "project-id": job.projectId,
        "job-id": job.id,
        kind: "engine-run-ledger",
      }),
    ]);

    await repository.storeCandidates(
      job,
      artifacts.candidatePayloads,
      {
        version: core.provenance.coreVersion,
        sha256: core.provenance.coreSha256,
      },
      {
        models: {
          transcription: config.openai.transcriptionModel,
          reasoning: config.openai.reasoningModel,
          vision: config.openai.visionModel,
        },
        source: {
          uri: r2Uri(job.objectKey),
          sha256: sourceIntegrity.sha256,
          sizeBytes: sourceIntegrity.sizeBytes,
        },
        coreProvenance: core.provenance,
        visualCoverage: {
          method: evidenceVisualMap.method,
          sparseFrameCount: visualMap.coverage.frameCount,
          denseFrameCount: denseFrameManifest.coverage.extractedFrameCount,
          densePeriodicIntervalSec: denseFrameManifest.periodicIntervalSec,
          denseVisualReverseRecallComplete: true,
          candidateDenseStillTranscriptRefinementComplete: true,
          continuousAudioVideoReviewed: false,
          limitation: evidenceVisualMap.coverage.limitation,
        },
        artifacts: {
          transcript: {
            uri: r2Uri(transcriptKey),
            sha256: transcriptStored.sha256,
          },
          denseVisualRecall: {
            uri: r2Uri(denseVisualRecallKey),
            sha256: denseVisualRecallStored.sha256,
          },
          candidateRefinement: {
            uri: r2Uri(candidateRefinementKey),
            sha256: candidateRefinementStored.sha256,
          },
          factLayer: {
            uri: r2Uri(factLayerKey),
            sha256: factStored.sha256,
          },
          editPlan: {
            uri: r2Uri(editPlanKey),
            sha256: planStored.sha256,
          },
          engineLedger: {
            uri: r2Uri(engineLedgerKey),
            sha256: ledgerStored.sha256,
          },
        },
        candidateCountPolicy: "natural_evidence_bound_count_no_quota",
        candidateCount: artifacts.candidatePayloads.length,
        validation: {
          factLayer: "passed_private_core_validator",
          editPlan: "passed_private_core_validator",
          engineLedger: "passed_private_core_validator",
          visualReverseRecall:
            "dense_full_timeline_periodic_plus_scene_change_complete",
          candidateDenseRefinement:
            "dense_stills_plus_diarized_transcript_complete",
          humanNormalPlaybackStillRequired: true,
        },
      },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function processRevisionRender(render: ClaimedRender): Promise<void> {
  const workDir = join(
    config.worker.workDirectory,
    `render-${render.id}-${render.attempt}`,
  );
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  try {
    const sourcePath = join(workDir, "source");
    const outputPath = join(workDir, "revision.mp4");
    await storage.download(render.objectKey, sourcePath);
    const result = await renderCandidateRevision({
      sourcePath,
      outputPath,
      candidate: render.payload,
      spec: render.spec,
    });
    const objectKey =
      `revisions/${render.projectId}/${render.candidateId}/${render.id}.mp4`;
    await storage.uploadFile(objectKey, outputPath, "video/mp4", {
      "project-id": render.projectId,
      "candidate-id": render.candidateId,
      "render-id": render.id,
      "preview-kind": "revised-cut-needs-fresh-human-normal-playback",
    });
    const decisions = new Map(
      render.spec.transcriptDecisions.map((item) => [item.lineId, item]),
    );
    const revisedPayload: CandidatePayload = {
      ...render.payload,
      ...(render.spec.title ? { title: render.spec.title } : {}),
      sourceStart: render.spec.sourceStart,
      sourceEnd: render.spec.sourceEnd,
      durationSeconds: result.durationSeconds,
      transcript: render.payload.transcript
        .filter((line) =>
          line.end >= render.spec.sourceStart
          && line.start <= render.spec.sourceEnd
        )
        .map((line) => ({
          ...line,
          defaultDecision:
            decisions.get(line.id)?.decision ?? line.defaultDecision,
          reason:
            decisions.get(line.id)?.reason
            ?? line.reason,
        })),
      reviewStatus: render.payload.reviewStatus,
      renderStatus: "revision_ready",
      previewKind: "revised_cut",
      previewVersion: render.id,
      isFinal: false,
      previewUrl: null,
    };
    await repository.completeRender(render, objectKey, revisedPayload);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function publicJobError(error: unknown): string {
  if (error instanceof AppError && error.expose) return error.message;
  if (error instanceof TianClipCoreError) {
    return "私有天总切片核心校验失败，任务已停止。";
  }
  return "处理任务未完成，系统将自动重试或等待后台检查。";
}

function retryableJobError(error: unknown): boolean {
  if (error instanceof TianClipCoreError) return false;
  if (error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500) {
    return false;
  }
  return true;
}

async function runLoop(): Promise<void> {
  await mkdir(config.worker.workDirectory, { recursive: true });
  await toolchainCheck();
  await repository.touchWorkerHeartbeat(workerId);
  const workerHeartbeat = setInterval(() => {
    void repository.touchWorkerHeartbeat(workerId).catch((error) => {
      process.stderr.write(
        `worker heartbeat failed: ${internalErrorMessage(error)}\n`,
      );
    });
  }, config.worker.heartbeatIntervalMs);
  workerHeartbeat.unref();

  try {
    while (!stopping) {
      await repository.cleanupExpiredGuards().catch(() => undefined);

      const render = await repository.claimRender(workerId);
      if (render) {
        try {
          await withRenderHeartbeat(
            render,
            async () => await processRevisionRender(render),
          );
        } catch (error) {
          await repository.failOrRetryRender(
            render,
            internalErrorMessage(error),
          );
        }
        continue;
      }

      const job = await repository.claimJob(workerId);
      if (job) {
        try {
          await withJobHeartbeat(job, async () => await processAnalysisJob(job));
        } catch (error) {
          await repository.failOrRetryJob(
            job,
            publicJobError(error),
            internalErrorMessage(error),
            retryableJobError(error),
          );
        }
        continue;
      }
      await delay(config.worker.pollIntervalMs);
    }
  } finally {
    clearInterval(workerHeartbeat);
  }
}

const stop = (signal: string) => {
  process.stderr.write(`worker received ${signal}; stopping after current step\n`);
  stopping = true;
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

try {
  await runLoop();
  await database.end();
} catch (error) {
  process.stderr.write(`worker fatal: ${internalErrorMessage(error)}\n`);
  await database.end().catch(() => undefined);
  process.exit(1);
}
