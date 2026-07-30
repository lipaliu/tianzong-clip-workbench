import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  VALIDATION_STATUSES,
  analyzeDenseVisualRecall,
  analyzeVisualTimeline,
  augmentVisualMapWithDenseRecall,
  assertChunkPlanCoverage,
  buildFrameExtractionPlan,
  checkMediaToolchain,
  createDoubaoEditorClient,
  createOpenAIClient,
  deriveCandidateValidation,
  extractDenseTimelineFrames,
  generateCandidates,
  mergeTextAndVisualCandidateResults,
  mergeCandidateBatchResults,
  parseFfprobeOutput,
  parseShotChangeTimestamps,
  planCandidateRecallWindows,
  planAudioChunks,
  planPeriodicTimestamps,
  renderCandidateSafetyProxy,
  refineCandidatesWithDenseEvidence,
  stitchDiarizedChunks,
  validateCandidateResult,
} from "../index.mjs";

async function withTempDir(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tianzong-pipeline-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("ffprobe parser requires both video and audio and returns normalized metadata", () => {
  const raw = {
    format: {
      duration: "125.5",
      start_time: "0.0",
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
      bit_rate: "4000000",
    },
    streams: [
      {
        index: 0,
        codec_type: "video",
        codec_name: "h264",
        width: 1080,
        height: 1920,
        avg_frame_rate: "30000/1001",
        pix_fmt: "yuv420p",
      },
      {
        index: 1,
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
      },
    ],
  };

  const metadata = parseFfprobeOutput(raw, {
    sourcePath: "/tmp/live.mp4",
    sourceSizeBytes: 1234,
  });
  assert.equal(metadata.durationSec, 125.5);
  assert.equal(metadata.video.width, 1080);
  assert.ok(Math.abs(metadata.video.fps - 29.97002997) < 0.001);
  assert.deepEqual(metadata.video.frameRate, {
    numerator: 30000,
    denominator: 1001,
    rational: "30000/1001",
    fps: 30000 / 1001,
    source: "avg_frame_rate",
  });
  assert.equal(metadata.audio.channels, 2);
  assert.equal(metadata.audio.sampleRate, 48000);

  assert.throws(
    () => parseFfprobeOutput({ ...raw, streams: [raw.streams[0]] }),
    (error) => error.code === "AUDIO_STREAM_MISSING",
  );
});

test("ffprobe parser preserves the effective rational rate and only falls back when average rate is invalid", () => {
  const metadata = parseFfprobeOutput({
    format: { duration: "10" },
    streams: [
      {
        index: 0,
        codec_type: "video",
        width: 1920,
        height: 1080,
        avg_frame_rate: "0/0",
        r_frame_rate: "25/1",
      },
      {
        index: 1,
        codec_type: "audio",
        channels: 1,
      },
    ],
  });

  assert.deepEqual(metadata.video.frameRate, {
    numerator: 25,
    denominator: 1,
    rational: "25/1",
    fps: 25,
    source: "r_frame_rate",
  });
});

test("media toolchain readiness requires recognizable ffmpeg and ffprobe binaries", async () => {
  const calls = [];
  const result = await checkMediaToolchain({
    runner: async (command, args) => {
      calls.push([command, args]);
      return {
        stdout: `${command} version 7.1 Copyright\n`,
        stderr: "",
      };
    },
  });
  assert.equal(result.ready, true);
  assert.match(result.ffmpeg, /^ffmpeg version/);
  assert.deepEqual(calls, [
    ["ffmpeg", ["-version"]],
    ["ffprobe", ["-version"]],
  ]);

  await assert.rejects(
    () => checkMediaToolchain({
      runner: async (command) => ({ stdout: `${command} unavailable`, stderr: "" }),
    }),
    (error) => error.code === "MEDIA_TOOLCHAIN_VERSION_INVALID",
  );
});

test("audio chunk planner partitions the complete timeline without ownership gaps", () => {
  const chunks = planAudioChunks({
    durationSec: 1250,
    chunkDurationSec: 600,
    overlapSec: 2,
  });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].startSec, 0);
  assert.equal(chunks[1].startSec, 598);
  assert.equal(chunks.at(-1).endSec, 1250);
  assert.equal(chunks[0].ownershipEndSec, chunks[1].ownershipStartSec);
  assert.equal(chunks[1].ownershipEndSec, chunks[2].ownershipStartSec);
  assert.equal(assertChunkPlanCoverage(chunks, 1250), true);
});

test("OpenAI audio client sends the required diarization contract", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "audio_0001.flac");
    await writeFile(filePath, Buffer.from("fake flac bytes"));
    let request;
    const client = createOpenAIClient({
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        request = { url, init };
        return jsonResponse({
          task: "transcribe",
          duration: 1,
          text: "你好",
          segments: [{
            id: "seg_1",
            start: 0,
            end: 1,
            speaker: "A",
            text: "你好",
          }],
        });
      },
    });

    const result = await client.transcribeDiarized({ filePath });
    assert.equal(result.segments[0].speaker, "A");
    assert.equal(request.url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(request.init.body.get("model"), "gpt-4o-transcribe-diarize");
    assert.equal(request.init.body.get("response_format"), "diarized_json");
    assert.equal(request.init.body.get("chunking_strategy"), "auto");
    assert.match(request.init.headers.Authorization, /^Bearer /);
  });
});

test("diarized chunk stitching uses ownership boundaries to remove overlap duplicates", () => {
  const chunks = planAudioChunks({
    durationSec: 700,
    chunkDurationSec: 600,
    overlapSec: 2,
  });
  const results = [
    {
      chunk: chunks[0],
      raw: {
        segments: [
          { id: "one", start: 0, end: 2, speaker: "A", text: "第一句" },
          { id: "dup-a", start: 598.5, end: 599.5, speaker: "A", text: "交界句" },
        ],
      },
    },
    {
      chunk: chunks[1],
      raw: {
        segments: [
          { id: "dup-b", start: 0.5, end: 1.5, speaker: "A", text: "交界句" },
          { id: "two", start: 2, end: 5, speaker: "B", text: "第二句" },
        ],
      },
    },
  ];

  const transcript = stitchDiarizedChunks(results, { mediaDurationSec: 700 });
  assert.deepEqual(transcript.segments.map((segment) => segment.text), [
    "第一句",
    "交界句",
    "第二句",
  ]);
  assert.deepEqual(transcript.speakerLabels, ["A", "B"]);
});

test("frame planning combines periodic full-timeline coverage with detected shot changes", async () => {
  const timestamps = planPeriodicTimestamps({ durationSec: 31, intervalSec: 10 });
  assert.deepEqual(timestamps, [0, 10, 20, 30, 30.95]);
  assert.deepEqual(
    parseShotChangeTimestamps("n:1 pts_time:4.25 foo\nn:2 pts_time:18.5", { durationSec: 31 }),
    [4.25, 18.5],
  );

  const plan = await buildFrameExtractionPlan({
    sourcePath: "/tmp/live.mp4",
    durationSec: 31,
    periodicIntervalSec: 10,
    runner: async (command, args) => {
      assert.equal(command, "ffmpeg");
      assert.ok(args.some((arg) => arg.includes("select=gt(scene")));
      return {
        stdout: "",
        stderr: "showinfo n:1 pts_time:4.25\nshowinfo n:2 pts_time:18.5",
      };
    },
  });
  assert.equal(plan.coverage.fullTimelineScreeningPlanned, true);
  assert.equal(plan.coverage.continuousVideoReviewPlanned, false);
  assert.ok(plan.frames.some((frame) => frame.timestampSec === 4.25 && frame.reasons.includes("shot_change")));
  assert.ok(plan.frames.some((frame) => frame.timestampSec === 30.95 && frame.reasons.includes("periodic")));
});

test("dense frame extraction decodes the full timeline in two ffmpeg passes, not one process per frame", async () => {
  await withTempDir(async (directory) => {
    const calls = [];
    const manifest = await extractDenseTimelineFrames({
      sourcePath: "/tmp/live.mp4",
      outputDir: directory,
      durationSec: 5,
      intervalSec: 2,
      runner: async (command, args) => {
        calls.push({ command, args });
        const isPeriodic = args.some((arg) => String(arg).includes("fps=fps=1/2"));
        if (isPeriodic) {
          await Promise.all([
            writeFile(path.join(directory, "periodic_0000001.jpg"), "p0"),
            writeFile(path.join(directory, "periodic_0000002.jpg"), "p1"),
            writeFile(path.join(directory, "periodic_0000003.jpg"), "p2"),
          ]);
          return {
            stdout: "",
            stderr: [
              "showinfo n:0 pts_time:0",
              "showinfo n:1 pts_time:2",
              "showinfo n:2 pts_time:4",
            ].join("\n"),
          };
        }
        await writeFile(path.join(directory, "shot_0000001.jpg"), "s0");
        return {
          stdout: "",
          stderr: "showinfo n:0 pts_time:1.1",
        };
      },
    });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.command === "ffmpeg"));
    assert.equal(manifest.coverage.extractionPassCount, 2);
    assert.equal(manifest.coverage.periodicFrameCount, 3);
    assert.equal(manifest.coverage.shotChangeFrameCount, 1);
    assert.deepEqual(
      manifest.frames.map((frame) => frame.timestampSec),
      [0, 1.1, 2, 4],
    );
    assert.equal(manifest.coverage.fullTimelineScreeningExtracted, true);
    assert.equal(manifest.coverage.continuousVideoReviewed, false);
  });
});

test("visual timeline analysis sends GPT-5.6 Sol image inputs and remains screening-only", async () => {
  await withTempDir(async (directory) => {
    const frames = [];
    for (const [index, timestampSec] of [0, 10, 19.95].entries()) {
      const framePath = path.join(directory, `frame-${index}.jpg`);
      await writeFile(framePath, Buffer.from(`jpeg-${index}`));
      frames.push({
        id: `frame_${index + 1}`,
        timestampSec,
        reasons: ["periodic"],
        path: framePath,
        mimeType: "image/jpeg",
      });
    }
    const frameManifest = {
      durationSec: 20,
      periodicIntervalSec: 10,
      frames,
      coverage: {
        fullTimelineScreeningExtracted: true,
        continuousVideoReviewed: false,
      },
    };
    let request;
    const client = {
      async createStructuredResponse(value) {
        request = value;
        return {
          parsed: {
            events: [{
              id: "visual_1",
              startSec: 8,
              endSec: 12,
              eventType: "speaker_expression",
              description: "主播明显大笑",
              people: ["主播"],
              actions: ["大笑"],
              expressions: ["开心"],
              products: [],
              onscreenText: [],
              clipSignals: ["情绪反差"],
              evidenceFrameIds: ["frame_2"],
              confidence: 0.9,
              uncertainties: ["静帧不能证明笑声持续时间"],
            }],
            batchSummary: {
              dominantScene: "直播间",
              visibleSpeakerCount: 1,
              notes: [],
            },
          },
          responseId: "resp_visual",
          model: value.model,
          usage: { total_tokens: 10 },
        };
      },
    };

    const visualMap = await analyzeVisualTimeline({
      frameManifest,
      client,
      framesPerBatch: 3,
    });
    assert.equal(request.model, "gpt-5.6-sol");
    assert.equal(request.schemaName, "tianzong_visual_event_batch");
    const content = request.input[0].content;
    assert.equal(content.filter((item) => item.type === "input_image").length, 3);
    assert.ok(content.filter((item) => item.type === "input_image").every((item) => item.detail === "high"));
    assert.equal(visualMap.coverage.fullTimelineScreeningComplete, true);
    assert.equal(visualMap.coverage.continuousAudioVideoReviewed, false);
    assert.equal(visualMap.validationStatus, "visual_screening_complete_needs_candidate_av_review");
  });
});

test("visual timeline namespaces repeated provider event ids across batches", async () => {
  await withTempDir(async (directory) => {
    const framePath = path.join(directory, "visual-batch-frame.jpg");
    await writeFile(framePath, "visual-batch-jpeg");
    const frames = [0, 10, 20].map((timestampSec, index) => ({
      id: `frame_repeat_${index + 1}`,
      timestampSec,
      reasons: ["periodic"],
      path: framePath,
      mimeType: "image/jpeg",
    }));
    let requestIndex = 0;
    const visualMap = await analyzeVisualTimeline({
      frameManifest: {
        durationSec: 20,
        periodicIntervalSec: 10,
        frames,
        coverage: {
          fullTimelineScreeningExtracted: true,
          continuousVideoReviewed: false,
        },
      },
      framesPerBatch: 2,
      client: {
        async createStructuredResponse(value) {
          const batchIndex = requestIndex;
          requestIndex += 1;
          const frameId = batchIndex === 0 ? "frame_repeat_1" : "frame_repeat_3";
          const timestamp = batchIndex === 0 ? 0 : 20;
          return {
            parsed: {
              events: [{
                id: "event_1",
                startSec: timestamp,
                endSec: timestamp,
                eventType: "speaker_expression",
                description: `批次 ${batchIndex + 1} 的可见表情`,
                people: ["天总"],
                actions: [],
                expressions: ["微笑"],
                products: [],
                onscreenText: [],
                clipSignals: ["人物反应"],
                evidenceFrameIds: [frameId],
                confidence: 0.8,
                uncertainties: ["静帧证据"],
              }],
              batchSummary: {
                dominantScene: "直播间",
                visibleSpeakerCount: 1,
                notes: [],
              },
            },
            responseId: `resp_repeat_${batchIndex + 1}`,
            model: value.model,
            usage: { total_tokens: 10 },
          };
        },
      },
    });

    assert.deepEqual(
      visualMap.events.map((event) => event.id),
      [
        "visual_batch_0001_event_0001",
        "visual_batch_0002_event_0001",
      ],
    );
  });
});

function candidateFixtures() {
  const transcript = {
    mediaDurationSec: 30,
    segments: [
      {
        id: "tx_1",
        speaker: "A",
        startSec: 2,
        endSec: 5,
        text: "赚钱和事业根本不是一回事。",
      },
      {
        id: "tx_2",
        speaker: "A",
        startSec: 5,
        endSec: 20,
        text: "你要先想清楚长期价值。",
      },
    ],
  };
  const visualMap = {
    coverage: {
      fullTimelineScreeningComplete: true,
      continuousAudioVideoReviewed: false,
      limitation: "Sparse still-frame evidence.",
    },
    events: [{
      id: "visual_1",
      startSec: 3,
      endSec: 6,
      eventType: "gesture",
      description: "主播强调时抬手",
      actions: ["抬手"],
      expressions: ["认真"],
      products: [],
      onscreenText: [],
      clipSignals: ["强调"],
      evidenceFrameIds: ["frame_1"],
      confidence: 0.8,
      uncertainties: [],
    }],
  };
  const candidate = {
    candidateId: "candidate_1",
    title: "赚钱和事业不是一回事",
    douyinTitle: "赚钱和事业，根本不是一回事",
    xiaohongshuTitle: "为什么赚钱了，也不一定是在做事业？",
    hook: "很多人把短期收入当成事业",
    openingLine: "赚钱和事业根本不是一回事",
    topic: "事业",
    contentPillar: "幽默反转测试",
    rationale: "天然完整的短反应测试候选",
    recallWindow: { startSec: 2, endSec: 20 },
    safetyWindow: { startSec: 1, endSec: 21 },
    transcriptSegmentIds: ["tx_1", "tx_2"],
    visualEventIds: ["visual_1"],
    requiredVisualProof: ["确认抬手动作与重音同步", "确认前后没有他人必要提问"],
    deleteSuggestions: [],
    score: {
      hook: 20,
      emotion: 15,
      insight: 20,
      controversy: 15,
      completeness: 15,
      titlePotential: 15,
      total: 100,
    },
    risks: [],
    validationStatus: "editorial_candidate_needs_av_review",
  };
  return {
    transcript,
    visualMap,
    candidate,
    coreBundle: {
      coreId: "tianzong-core",
      coreVersion: "1.0.0",
      coreSha256: "a".repeat(64),
      promptVersion: "1.0.0",
      privateKnowledge: "天总不是单纯的商业金句账号，要保留强姐姐、老板、搞笑和脆弱之间的切换。",
      modeRules: {
        chat: "聊播优先独立结论、完整因果和必要提问，不按固定时长硬切。",
        sales: "带货保留长期价值判断、产品证据与真实使用动作。",
      },
    },
  };
}

function completeRefinementFields() {
  return {
    closureText: "你要先想清楚长期价值。",
    tianzongSpeakerLabel: "A",
    openingSegmentId: "tx_1",
    closingSegmentId: "tx_2",
    spokenContentSegmentIds: ["tx_1", "tx_2"],
    contextOnlySegmentIds: [],
    questionCardText: "",
    semanticClosureStatus: "complete",
    roughCutCategory: "micro_complete",
    roughCutDurationRationale: "测试候选是天然完整的短反应闭环。",
  };
}

test("dense visual-only recall records evidence but never creates standalone delivery candidates", async () => {
  await withTempDir(async (directory) => {
    const fixtures = candidateFixtures();
    const frames = [];
    for (const [index, timestampSec] of [0, 2, 4, 5.95].entries()) {
      const framePath = path.join(directory, `dense-${index}.jpg`);
      await writeFile(framePath, `dense-jpeg-${index}`);
      frames.push({
        id: `dense_frame_${index + 1}`,
        timestampSec,
        reasons: ["periodic"],
        path: framePath,
        mimeType: "image/jpeg",
      });
    }
    const frameManifest = {
      durationSec: 6,
      periodicIntervalSec: 2,
      frames,
      coverage: {
        fullTimelineScreeningExtracted: true,
        continuousVideoReviewed: false,
      },
    };
    const transcript = {
      mediaDurationSec: 6,
      segments: [{
        id: "dense_tx_1",
        speaker: "天总",
        startSec: 1,
        endSec: 3,
        text: "你看这个动作",
      }],
    };
    let request;
    const result = await analyzeDenseVisualRecall({
      frameManifest,
      transcript,
      coreBundle: fixtures.coreBundle,
      mode: "chat",
      client: {
        async createStructuredResponse(value) {
          request = value;
          return {
            parsed: {
              proposals: [{
                proposalId: "model_visual_1",
                title: "权威感刚起来就被现实拆台",
                description: "主播抬手展示后立刻露出惊讶表情",
                eventType: "failure_or_comedy",
                startSec: 1.5,
                endSec: 2.5,
                evidenceFrameIds: ["dense_frame_2"],
                visualSignals: ["抬手", "惊讶"],
                riskNotes: ["静帧不能证明动作先后"],
                confidence: 0.9,
              }],
              notes: [],
            },
            responseId: "resp_dense_visual",
            model: value.model,
            usage: { total_tokens: 12 },
          };
        },
      },
      expectedPeriodicIntervalSec: 2,
      framesPerBatch: 6,
      overlapFrames: 1,
    });
    assert.match(request.instructions, /VISUAL-ONLY/);
    assert.match(request.instructions, new RegExp(fixtures.coreBundle.coreSha256));
    const inputText = request.input[0].content
      .filter((item) => item.type === "input_text")
      .map((item) => item.text)
      .join("\n");
    assert.doesNotMatch(inputText, /你看这个动作/);
    assert.equal(
      request.input[0].content.filter((item) => item.type === "input_image").length,
      4,
    );
    assert.equal(result.candidates.length, 0);
    assert.equal(result.selectionSummary.qualifyingCount, 0);
    assert.match(result.selectionSummary.notes.join("\n"), /不直接生成交付候选/);
    assert.deepEqual(result.events[0].transcriptSegmentIds, ["dense_tx_1"]);
    assert.equal(result.events[0].continuousRangeReviewed, false);
    assert.equal(result.coverage.continuousAudioVideoReviewed, false);
  });
});

test("text and visual candidate merge rejects visual-only candidates", () => {
  const fixtures = candidateFixtures();
  const visualMap = {
    ...fixtures.visualMap,
    events: [
      ...fixtures.visualMap.events,
      {
        ...fixtures.visualMap.events[0],
        id: "visual_cut_a",
        startSec: 2,
        endSec: 4,
      },
      {
        ...fixtures.visualMap.events[0],
        id: "visual_cut_b",
        startSec: 6,
        endSec: 8,
      },
    ],
  };
  const visualBase = {
    ...fixtures.candidate,
    discoveryMethods: ["visual_only_dense_reverse_recall"],
    coreBinding: {
      coreId: fixtures.coreBundle.coreId,
      coreVersion: fixtures.coreBundle.coreVersion,
      coreSha256: fixtures.coreBundle.coreSha256,
      promptVersion: fixtures.coreBundle.promptVersion,
    },
    evidenceBinding: {
      transcriptSegmentIds: fixtures.candidate.transcriptSegmentIds,
      visualEventIds: [],
      continuousAudioVideoReviewed: false,
      audioVideoVerified: false,
    },
    recallProvenance: { sources: [] },
  };
  const visualA = {
    ...visualBase,
    candidateId: "visual_a",
    recallWindow: { startSec: 2, endSec: 5 },
    safetyWindow: { startSec: 1, endSec: 6 },
    transcriptSegmentIds: ["tx_1"],
    visualEventIds: ["visual_cut_a"],
    openingLine: "赚钱和事业根本不是一回事",
  };
  const visualB = {
    ...visualBase,
    candidateId: "visual_b",
    recallWindow: { startSec: 5, endSec: 9 },
    safetyWindow: { startSec: 4, endSec: 10 },
    transcriptSegmentIds: ["tx_2"],
    visualEventIds: ["visual_cut_b"],
    openingLine: "你要先想清楚长期价值",
  };
  const result = mergeTextAndVisualCandidateResults({
    textResult: {
      candidates: [],
      selectionSummary: {
        qualifyingCount: 0,
        rejectedThemes: [],
        notes: [],
      },
    },
    visualResult: {
      candidates: [visualA, visualB],
      selectionSummary: {
        qualifyingCount: 2,
        rejectedThemes: [],
        notes: [],
      },
    },
    transcript: fixtures.transcript,
    visualMap,
    coreBundle: fixtures.coreBundle,
    mode: "chat",
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.sourceFunnel.visualCandidateCount, 0);
  assert.equal(result.sourceFunnel.exactDuplicateCount, 0);
});

test("candidate-level dense still plus transcript refinement remains human-gated", async () => {
  await withTempDir(async (directory) => {
    const fixtures = candidateFixtures();
    const frames = [];
    for (const [index, timestampSec] of [2, 4, 6, 8, 10].entries()) {
      const framePath = path.join(directory, `candidate-${index}.jpg`);
      await writeFile(framePath, `candidate-jpeg-${index}`);
      frames.push({
        id: `candidate_frame_${index + 1}`,
        timestampSec,
        reasons: ["periodic"],
        path: framePath,
        mimeType: "image/jpeg",
      });
    }
    const candidateResult = {
      candidates: [{
        ...fixtures.candidate,
        coreBinding: {
          coreId: fixtures.coreBundle.coreId,
          coreVersion: fixtures.coreBundle.coreVersion,
          coreSha256: fixtures.coreBundle.coreSha256,
          promptVersion: fixtures.coreBundle.promptVersion,
        },
        evidenceBinding: {
          transcriptSegmentIds: fixtures.candidate.transcriptSegmentIds,
          visualEventIds: fixtures.candidate.visualEventIds,
          continuousAudioVideoReviewed: false,
          audioVideoVerified: false,
        },
        recallProvenance: { sources: [] },
        discoveryMethods: ["transcript_core_recall"],
      }],
      selectionSummary: {
        qualifyingCount: 1,
        rejectedThemes: [],
        notes: [],
      },
      sourceFunnel: {
        textCandidateCount: 1,
        visualCandidateCount: 0,
        exactDuplicateCount: 0,
        mergedCandidateCount: 1,
      },
    };
    let request;
    const result = await refineCandidatesWithDenseEvidence({
      candidateResult,
      transcript: fixtures.transcript,
      visualMap: fixtures.visualMap,
      frameManifest: {
        durationSec: 30,
        periodicIntervalSec: 2,
        frames,
        coverage: {
          fullTimelineScreeningExtracted: true,
          continuousVideoReviewed: false,
        },
      },
      coreBundle: fixtures.coreBundle,
      mode: "chat",
      client: {
        async createStructuredResponse(value) {
          request = value;
          return {
            parsed: {
              candidateId: "candidate_1",
              decision: "retain",
              refinedRecallWindow: { startSec: 2, endSec: 20 },
              refinedSafetyWindow: { startSec: 1, endSec: 21 },
              openingLine: "赚钱和事业根本不是一回事",
              ...completeRefinementFields(),
              transcriptSegmentIds: ["tx_1", "tx_2"],
              visualEventIds: ["visual_1"],
              visualPunchline: {
                present: true,
                description: "抬手和重音构成视觉强调",
                evidenceFrameIds: ["candidate_frame_1"],
                confidence: 0.8,
              },
              actionCompleteness: {
                status: "uncertain",
                description: "两秒采样不能证明抬手动作完整落下",
                evidenceFrameIds: ["candidate_frame_1", "candidate_frame_2"],
              },
              boundaryAssessment: {
                openingStatus: "supported",
                closingStatus: "supported",
                riskNotes: ["句尾后的表情是否完成需正常播放"],
              },
              requiredHumanNormalPlaybackChecks: [
                "完整正常倍速播放1到10秒，确认动作与重音同步",
              ],
              risks: ["静帧不能证明连续动作"],
              rejectionReason: "",
              machineReviewMethod: "dense_still_frames_plus_diarized_transcript",
              continuousAudioVideoReviewed: false,
              humanNormalPlaybackRequired: true,
              validationStatus:
                "candidate_dense_av_screening_needs_human_normal_playback",
            },
            responseId: "resp_candidate_refine",
            model: value.model,
            usage: { total_tokens: 20 },
          };
        },
      },
    });
    assert.match(request.instructions, /SECOND PASS/);
    assert.equal(
      request.input[0].content.filter((item) => item.type === "input_image").length,
      5,
    );
    assert.equal(result.candidates.length, 1);
    assert.equal(
      result.candidates[0].refinement.continuousAudioVideoReviewed,
      false,
    );
    assert.equal(result.candidates[0].refinement.humanNormalPlaybackRequired, true);
    assert.equal(
      result.visualMap.coverage.candidateDenseStillTranscriptRefinementComplete,
      true,
    );
    assert.equal(result.refinementRuns[0].denseFrameCount, 5);
  });
});

test("candidate refinement collapses exact duplicate delivery windows", async () => {
  await withTempDir(async (directory) => {
    const fixtures = candidateFixtures();
    const framePath = path.join(directory, "candidate-dedupe.jpg");
    await writeFile(framePath, "candidate-dedupe-jpeg");
    const candidates = [
      {
        ...fixtures.candidate,
        candidateId: "visual_candidate",
        title: "Visual-only duplicate",
        score: {
          hook: 15,
          emotion: 10,
          insight: 15,
          controversy: 10,
          completeness: 15,
          titlePotential: 15,
          total: 80,
        },
        discoveryMethods: ["visual_only_dense_reverse_recall"],
        recallProvenance: { sources: [{ discoveryMethod: "visual" }] },
      },
      {
        ...fixtures.candidate,
        candidateId: "text_candidate",
        title: "赚钱和事业不是一回事",
        score: {
          hook: 20,
          emotion: 10,
          insight: 20,
          controversy: 10,
          completeness: 15,
          titlePotential: 15,
          total: 90,
        },
        discoveryMethods: ["transcript_core_recall"],
        recallProvenance: { sources: [{ discoveryMethod: "transcript" }] },
      },
    ];
    let calls = 0;
    const result = await refineCandidatesWithDenseEvidence({
      candidateResult: {
        candidates,
        selectionSummary: {
          qualifyingCount: 2,
          rejectedThemes: [],
          notes: [],
        },
      },
      transcript: fixtures.transcript,
      visualMap: fixtures.visualMap,
      frameManifest: {
        durationSec: 30,
        periodicIntervalSec: 2,
        frames: [{
          id: "candidate_frame_1",
          timestampSec: 4,
          reasons: ["periodic"],
          path: framePath,
          mimeType: "image/jpeg",
        }],
        coverage: {
          fullTimelineScreeningExtracted: true,
          continuousVideoReviewed: false,
        },
      },
      coreBundle: fixtures.coreBundle,
      mode: "chat",
      concurrency: 1,
      client: {
        async createStructuredResponse(value) {
          const candidateId = candidates[calls].candidateId;
          calls += 1;
          return {
            parsed: {
              candidateId,
              decision: "retain",
              refinedRecallWindow: { startSec: 2, endSec: 20 },
              refinedSafetyWindow: { startSec: 1, endSec: 21 },
              openingLine: "赚钱和事业根本不是一回事",
              ...completeRefinementFields(),
              transcriptSegmentIds: ["tx_1", "tx_2"],
              visualEventIds: ["visual_1"],
              visualPunchline: {
                present: false,
                description: "未确认独立视觉梗",
                evidenceFrameIds: ["candidate_frame_1"],
                confidence: 0.4,
              },
              actionCompleteness: {
                status: "uncertain",
                description: "仍需人工正常倍速确认",
                evidenceFrameIds: ["candidate_frame_1"],
              },
              boundaryAssessment: {
                openingStatus: "supported",
                closingStatus: "supported",
                riskNotes: [],
              },
              requiredHumanNormalPlaybackChecks: ["完整播放1到10秒"],
              risks: [],
              rejectionReason: "",
              machineReviewMethod:
                "dense_still_frames_plus_diarized_transcript",
              continuousAudioVideoReviewed: false,
              humanNormalPlaybackRequired: true,
              validationStatus:
                "candidate_dense_av_screening_needs_human_normal_playback",
            },
            responseId: `resp_dedupe_${calls}`,
            model: value.model,
            usage: { total_tokens: 20 },
          };
        },
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].title, "赚钱和事业不是一回事");
    assert.deepEqual(
      result.candidates[0].discoveryMethods.sort(),
      ["transcript_core_recall", "visual_only_dense_reverse_recall"],
    );
    assert.equal(result.refinementSummary.exactDeliveryDuplicateCount, 1);
    assert.match(
      result.selectionSummary.notes.join("\n"),
      /重复候选已合并/,
    );
  });
});

test("candidate refinement retries a single invalid evidence answer instead of restarting the job", async () => {
  await withTempDir(async (directory) => {
    const fixtures = candidateFixtures();
    const framePath = path.join(directory, "candidate-retry.jpg");
    await writeFile(framePath, "candidate-retry-jpeg");
    let calls = 0;
    let retryInstructions = "";
    const validAnswer = {
      candidateId: "candidate_1",
      decision: "retain",
      refinedRecallWindow: { startSec: 2, endSec: 20 },
      refinedSafetyWindow: { startSec: 1, endSec: 21 },
      openingLine: "赚钱和事业根本不是一回事",
      ...completeRefinementFields(),
      transcriptSegmentIds: ["tx_1", "tx_2"],
      visualEventIds: ["visual_1"],
      visualPunchline: {
        present: false,
        description: "未确认独立视觉梗",
        evidenceFrameIds: ["candidate_frame_1"],
        confidence: 0.4,
      },
      actionCompleteness: {
        status: "uncertain",
        description: "仍需人工正常倍速确认",
        evidenceFrameIds: ["candidate_frame_1"],
      },
      boundaryAssessment: {
        openingStatus: "supported",
        closingStatus: "supported",
        riskNotes: ["句尾需人工确认"],
      },
      requiredHumanNormalPlaybackChecks: ["完整播放1到10秒"],
      risks: ["机器证据不能替代人工确认"],
      rejectionReason: "",
      machineReviewMethod: "dense_still_frames_plus_diarized_transcript",
      continuousAudioVideoReviewed: false,
      humanNormalPlaybackRequired: true,
      validationStatus:
        "candidate_dense_av_screening_needs_human_normal_playback",
    };
    const result = await refineCandidatesWithDenseEvidence({
      candidateResult: {
        candidates: [fixtures.candidate],
        selectionSummary: {
          qualifyingCount: 1,
          rejectedThemes: [],
          notes: [],
        },
      },
      transcript: fixtures.transcript,
      visualMap: fixtures.visualMap,
      frameManifest: {
        durationSec: 30,
        periodicIntervalSec: 2,
        frames: [{
          id: "candidate_frame_1",
          timestampSec: 4,
          reasons: ["periodic"],
          path: framePath,
          mimeType: "image/jpeg",
        }],
        coverage: {
          fullTimelineScreeningExtracted: true,
          continuousVideoReviewed: false,
        },
      },
      coreBundle: fixtures.coreBundle,
      mode: "chat",
      client: {
        async createStructuredResponse(value) {
          calls += 1;
          if (calls === 2) retryInstructions = value.instructions;
          return {
            parsed: calls === 1
              ? {
                  ...validAnswer,
                  visualPunchline: {
                    ...validAnswer.visualPunchline,
                    evidenceFrameIds: ["invented_frame"],
                  },
                }
              : validAnswer,
            responseId: `resp_candidate_retry_${calls}`,
            model: value.model,
            usage: { total_tokens: 20 },
          };
        },
      },
    });
    assert.equal(calls, 2);
    assert.match(
      retryInstructions,
      /CANDIDATE_REFINEMENT_FRAME_EVIDENCE_INVALID/,
    );
    assert.match(retryInstructions, /frameIds=candidate_frame_1/);
    assert.equal(result.candidates.length, 1);
  });
});

test("an incomplete provider response only retries the affected candidate", async () => {
  await withTempDir(async (directory) => {
    const fixtures = candidateFixtures();
    const framePath = path.join(directory, "candidate-provider-retry.jpg");
    await writeFile(framePath, "candidate-provider-retry-jpeg");
    let calls = 0;
    let retryInstructions = "";
    const validAnswer = {
      candidateId: "candidate_1",
      decision: "retain",
      refinedRecallWindow: { startSec: 2, endSec: 20 },
      refinedSafetyWindow: { startSec: 1, endSec: 21 },
      openingLine: "赚钱和事业根本不是一回事",
      ...completeRefinementFields(),
      transcriptSegmentIds: ["tx_1", "tx_2"],
      visualEventIds: ["visual_1"],
      visualPunchline: {
        present: false,
        description: "未确认独立视觉梗",
        evidenceFrameIds: ["candidate_frame_1"],
        confidence: 0.4,
      },
      actionCompleteness: {
        status: "uncertain",
        description: "仍需人工正常倍速确认",
        evidenceFrameIds: ["candidate_frame_1"],
      },
      boundaryAssessment: {
        openingStatus: "supported",
        closingStatus: "supported",
        riskNotes: ["句尾需人工确认"],
      },
      requiredHumanNormalPlaybackChecks: ["完整播放安全窗"],
      risks: ["机器证据不能替代人工确认"],
      rejectionReason: "",
      machineReviewMethod: "dense_still_frames_plus_diarized_transcript",
      continuousAudioVideoReviewed: false,
      humanNormalPlaybackRequired: true,
      validationStatus:
        "candidate_dense_av_screening_needs_human_normal_playback",
    };
    const result = await refineCandidatesWithDenseEvidence({
      candidateResult: {
        candidates: [fixtures.candidate],
        selectionSummary: {
          qualifyingCount: 1,
          rejectedThemes: [],
          notes: [],
        },
      },
      transcript: fixtures.transcript,
      visualMap: fixtures.visualMap,
      frameManifest: {
        durationSec: 30,
        periodicIntervalSec: 2,
        frames: [{
          id: "candidate_frame_1",
          timestampSec: 4,
          reasons: ["periodic"],
          path: framePath,
          mimeType: "image/jpeg",
        }],
        coverage: {
          fullTimelineScreeningExtracted: true,
          continuousVideoReviewed: false,
        },
      },
      coreBundle: fixtures.coreBundle,
      mode: "chat",
      client: {
        async createStructuredResponse(value) {
          calls += 1;
          if (calls === 1) {
            const error = new Error("provider response incomplete");
            error.code = "OPENAI_RESPONSE_INCOMPLETE";
            error.details = { reason: "max_output_tokens" };
            throw error;
          }
          retryInstructions = value.instructions;
          return {
            parsed: validAnswer,
            responseId: "resp_candidate_provider_retry",
            model: value.model,
            usage: { total_tokens: 20 },
          };
        },
      },
    });
    assert.equal(calls, 2);
    assert.match(retryInstructions, /OPENAI_RESPONSE_INCOMPLETE/);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.refinementSummary.rejected.length, 0);
  });
});

test("candidate refinement only adopts native AV evidence after a successful bound review", async () => {
  await withTempDir(async (directory) => {
    const fixtures = candidateFixtures();
    const framePath = path.join(directory, "candidate-native-av.jpg");
    await writeFile(framePath, "candidate-native-av-jpeg");
    const nativeEvent = {
      id: "doubao_av_candidate_1_001",
      candidateId: "candidate_1",
      startSec: 3,
      endSec: 5,
      eventType: "speaker_expression",
      description: "原声视频中主播挑眉后加重语气",
      people: ["天总"],
      actions: [],
      expressions: ["挑眉"],
      products: [],
      onscreenText: [],
      clipSignals: ["doubao_native_av:expression"],
      evidenceFrameIds: ["candidate_frame_1"],
      confidence: 0.87,
      uncertainties: ["仍需人工正常倍速确认"],
      observationMethod: "doubao_seed_2_lite_native_audio_video",
      nativeAvReviewDecision: "supported",
      nativeAudioVideoInputReviewed: true,
      continuousFrameByFrameReviewed: false,
      humanNormalPlaybackRequired: true,
    };
    let request;
    const result = await refineCandidatesWithDenseEvidence({
      candidateResult: {
        candidates: [{
          ...fixtures.candidate,
          coreBinding: {
            coreId: fixtures.coreBundle.coreId,
            coreVersion: fixtures.coreBundle.coreVersion,
            coreSha256: fixtures.coreBundle.coreSha256,
            promptVersion: fixtures.coreBundle.promptVersion,
          },
          evidenceBinding: {
            transcriptSegmentIds: fixtures.candidate.transcriptSegmentIds,
            visualEventIds: fixtures.candidate.visualEventIds,
            continuousAudioVideoReviewed: false,
            audioVideoVerified: false,
          },
          recallProvenance: { sources: [] },
          discoveryMethods: ["transcript_core_recall"],
        }],
        selectionSummary: {
          qualifyingCount: 1,
          rejectedThemes: [],
          notes: [],
        },
        sourceFunnel: {
          textCandidateCount: 1,
          visualCandidateCount: 0,
          exactDuplicateCount: 0,
          mergedCandidateCount: 1,
        },
      },
      transcript: fixtures.transcript,
      visualMap: {
        ...fixtures.visualMap,
        events: [
          ...fixtures.visualMap.events,
          nativeEvent,
          {
            ...nativeEvent,
            id: "doubao_av_candidate_other_001",
            candidateId: "candidate_other",
            description: "时间重叠但属于另一个候选的证据",
          },
        ],
      },
      frameManifest: {
        durationSec: 30,
        periodicIntervalSec: 2,
        frames: [{
          id: "candidate_frame_1",
          timestampSec: 4,
          reasons: ["periodic"],
          path: framePath,
          mimeType: "image/jpeg",
        }],
        coverage: {
          fullTimelineScreeningExtracted: true,
          continuousVideoReviewed: false,
        },
      },
      coreBundle: fixtures.coreBundle,
      mode: "chat",
      client: {
        async createStructuredResponse(value) {
          request = value;
          return {
            parsed: {
              candidateId: "candidate_1",
              decision: "retain",
              refinedRecallWindow: { startSec: 2, endSec: 20 },
              refinedSafetyWindow: { startSec: 1, endSec: 21 },
              openingLine: "赚钱和事业根本不是一回事",
              ...completeRefinementFields(),
              transcriptSegmentIds: ["tx_1", "tx_2"],
              visualEventIds: ["doubao_av_candidate_1_001"],
              visualPunchline: {
                present: true,
                description: "挑眉与重音共同形成反差",
                evidenceFrameIds: ["candidate_frame_1"],
                confidence: 0.8,
              },
              actionCompleteness: {
                status: "uncertain",
                description: "原生音视频模型支持该动作，但仍需人工播放确认",
                evidenceFrameIds: ["candidate_frame_1"],
              },
              boundaryAssessment: {
                openingStatus: "supported",
                closingStatus: "supported",
                riskNotes: ["句尾动作必须人工正常倍速确认"],
              },
              requiredHumanNormalPlaybackChecks: ["完整播放1到10秒"],
              risks: ["机器音视频证据不是人工确认"],
              rejectionReason: "",
              machineReviewMethod:
                "dense_still_frames_plus_diarized_transcript_plus_native_av_model_evidence",
              continuousAudioVideoReviewed: false,
              humanNormalPlaybackRequired: true,
              validationStatus:
                "candidate_dense_av_screening_needs_human_normal_playback",
            },
            responseId: "resp_candidate_native_av_refine",
            model: value.model,
            usage: { total_tokens: 24 },
          };
        },
      },
    });
    assert.match(request.instructions, /native audio-video MODEL review/);
    assert.match(
      request.input[0].content[0].text,
      /dense_still_frames_plus_diarized_transcript_plus_native_av_model_evidence/,
    );
    assert.doesNotMatch(
      request.input[0].content[0].text,
      /doubao_av_candidate_other_001/,
    );
    assert.equal(
      result.candidates[0].refinement.method,
      "dense_still_frames_plus_diarized_transcript_plus_native_av_model_evidence",
    );
    assert.equal(
      result.refinementSummary.nativeAvModelEvidenceCandidateCount,
      1,
    );
    assert.equal(result.refinementSummary.nativeAvSupportedCandidateCount, 1);
    assert.equal(result.refinementSummary.nativeAvUncertainCandidateCount, 0);
    assert.equal(
      result.refinementSummary.nativeAvContradictedCandidateCount,
      0,
    );
    assert.equal(result.candidates[0].refinement.humanNormalPlaybackRequired, true);
    assert.equal(result.candidates[0].refinement.continuousAudioVideoReviewed, false);
  });
});

test("uncertain and contradicted native AV decisions remain risk or counter-evidence", async () => {
  await withTempDir(async (directory) => {
    const fixtures = candidateFixtures();
    const framePath = path.join(directory, "candidate-native-av-negative.jpg");
    await writeFile(framePath, "candidate-native-av-negative-jpeg");

    for (const reviewDecision of ["uncertain", "contradicted"]) {
      const nativeEventId = `doubao_av_candidate_1_${reviewDecision}`;
      let request;
      const result = await refineCandidatesWithDenseEvidence({
        candidateResult: {
          candidates: [{
            ...fixtures.candidate,
            coreBinding: {
              coreId: fixtures.coreBundle.coreId,
              coreVersion: fixtures.coreBundle.coreVersion,
              coreSha256: fixtures.coreBundle.coreSha256,
              promptVersion: fixtures.coreBundle.promptVersion,
            },
            evidenceBinding: {
              transcriptSegmentIds: fixtures.candidate.transcriptSegmentIds,
              visualEventIds: fixtures.candidate.visualEventIds,
              continuousAudioVideoReviewed: false,
              audioVideoVerified: false,
            },
            recallProvenance: { sources: [] },
            discoveryMethods: ["transcript_core_recall"],
          }],
          selectionSummary: {
            qualifyingCount: 1,
            rejectedThemes: [],
            notes: [],
          },
          sourceFunnel: {
            textCandidateCount: 1,
            visualCandidateCount: 0,
            exactDuplicateCount: 0,
            mergedCandidateCount: 1,
          },
        },
        transcript: fixtures.transcript,
        visualMap: {
          ...fixtures.visualMap,
          events: [
            ...fixtures.visualMap.events,
            {
              id: nativeEventId,
              candidateId: "candidate_1",
              startSec: 3,
              endSec: 5,
              eventType: "other",
              description:
                reviewDecision === "contradicted"
                  ? "原生音视频复核与候选角度冲突"
                  : "原生音视频复核无法确认候选角度",
              evidenceFrameIds: ["candidate_frame_1"],
              confidence: 0.8,
              uncertainties: ["必须人工正常倍速确认"],
              observationMethod: "doubao_seed_2_lite_native_audio_video",
              nativeAvReviewDecision: reviewDecision,
              nativeAudioVideoInputReviewed: true,
              continuousFrameByFrameReviewed: false,
              humanNormalPlaybackRequired: true,
            },
          ],
        },
        frameManifest: {
          durationSec: 30,
          periodicIntervalSec: 2,
          frames: [{
            id: "candidate_frame_1",
            timestampSec: 4,
            reasons: ["periodic"],
            path: framePath,
            mimeType: "image/jpeg",
          }],
          coverage: {
            fullTimelineScreeningExtracted: true,
            continuousVideoReviewed: false,
          },
        },
        coreBundle: fixtures.coreBundle,
        mode: "chat",
        client: {
          async createStructuredResponse(value) {
            request = value;
            return {
              parsed: {
                candidateId: "candidate_1",
                decision: "reject",
                refinedRecallWindow: { startSec: 2, endSec: 20 },
                refinedSafetyWindow: { startSec: 1, endSec: 21 },
                openingLine: "赚钱和事业根本不是一回事",
                ...completeRefinementFields(),
                transcriptSegmentIds: ["tx_1", "tx_2"],
                visualEventIds: [nativeEventId],
                visualPunchline: {
                  present: false,
                  description: "原生音视频复核未形成支持",
                  evidenceFrameIds: ["candidate_frame_1"],
                  confidence: 0.2,
                },
                actionCompleteness: {
                  status: "uncertain",
                  description: "证据不足",
                  evidenceFrameIds: ["candidate_frame_1"],
                },
                boundaryAssessment: {
                  openingStatus: "uncertain",
                  closingStatus: "uncertain",
                  riskNotes: ["不得把非支持结论写成支持性证据"],
                },
                requiredHumanNormalPlaybackChecks: ["完整播放1到10秒"],
                risks: ["原生音视频结论并非 supported"],
                rejectionReason: "原生音视频复核没有支持候选角度",
                machineReviewMethod:
                  "dense_still_frames_plus_diarized_transcript_plus_native_av_model_evidence",
                continuousAudioVideoReviewed: false,
                humanNormalPlaybackRequired: true,
                validationStatus:
                  "candidate_dense_av_screening_needs_human_normal_playback",
              },
              responseId: `resp_${reviewDecision}`,
              model: value.model,
              usage: { total_tokens: 12 },
            };
          },
        },
      });

      const compactInput = request.input[0].content[0].text;
      assert.match(compactInput, new RegExp(`"nativeAvReviewDecision":"${reviewDecision}"`));
      assert.match(request.instructions, /uncertain only raises risk/);
      assert.match(request.instructions, /contradicted is counter-evidence/);
      assert.equal(result.refinementSummary.nativeAvSupportedCandidateCount, 0);
      assert.equal(
        result.refinementSummary.nativeAvUncertainCandidateCount,
        reviewDecision === "uncertain" ? 1 : 0,
      );
      assert.equal(
        result.refinementSummary.nativeAvContradictedCandidateCount,
        reviewDecision === "contradicted" ? 1 : 0,
      );
      assert.equal(result.candidates.length, 0);
    }
  });
});

test("candidate dense refinement fails closed on a premature continuous-AV claim", async () => {
  await withTempDir(async (directory) => {
    const fixtures = candidateFixtures();
    const framePath = path.join(directory, "candidate.jpg");
    await writeFile(framePath, "candidate-jpeg");
    await assert.rejects(
      () => refineCandidatesWithDenseEvidence({
        candidateResult: {
          candidates: [fixtures.candidate],
          selectionSummary: {
            qualifyingCount: 1,
            rejectedThemes: [],
            notes: [],
          },
        },
        transcript: fixtures.transcript,
        visualMap: fixtures.visualMap,
        frameManifest: {
          durationSec: 30,
          periodicIntervalSec: 2,
          frames: [{
            id: "candidate_frame_1",
            timestampSec: 3,
            reasons: ["periodic"],
            path: framePath,
            mimeType: "image/jpeg",
          }],
          coverage: {
            fullTimelineScreeningExtracted: true,
            continuousVideoReviewed: false,
          },
        },
        coreBundle: fixtures.coreBundle,
        mode: "chat",
        client: {
          async createStructuredResponse() {
            return {
              parsed: {
                candidateId: "candidate_1",
                decision: "retain",
                refinedRecallWindow: { startSec: 2, endSec: 20 },
                refinedSafetyWindow: { startSec: 1, endSec: 21 },
                openingLine: "赚钱和事业根本不是一回事",
                ...completeRefinementFields(),
                transcriptSegmentIds: ["tx_1", "tx_2"],
                visualEventIds: ["visual_1"],
                visualPunchline: {
                  present: false,
                  description: "未确认",
                  evidenceFrameIds: [],
                  confidence: 0.2,
                },
                actionCompleteness: {
                  status: "uncertain",
                  description: "仍需连续播放",
                  evidenceFrameIds: ["candidate_frame_1"],
                },
                boundaryAssessment: {
                  openingStatus: "supported",
                  closingStatus: "uncertain",
                  riskNotes: [],
                },
                requiredHumanNormalPlaybackChecks: ["完整播放安全窗"],
                risks: [],
                rejectionReason: "",
                machineReviewMethod:
                  "dense_still_frames_plus_diarized_transcript",
                continuousAudioVideoReviewed: true,
                humanNormalPlaybackRequired: true,
                validationStatus:
                  "candidate_dense_av_screening_needs_human_normal_playback",
              },
              responseId: "resp_invalid_claim",
              model: "gpt-5.6-sol",
              usage: {},
            };
          },
        },
      }),
      (error) => error.code === "CANDIDATE_REFINEMENT_PREMATURE_AV_CLAIM",
    );
  });
});

test("candidate generation binds the private core, transcript, and visual map without a quota", async () => {
  const fixtures = candidateFixtures();
  let request;
  const client = {
    async createStructuredResponse(value) {
      request = value;
      return {
        parsed: {
          candidates: [fixtures.candidate],
          selectionSummary: {
            qualifyingCount: 1,
            rejectedThemes: [],
            notes: ["按证据自然召回，不设数量目标"],
          },
        },
        responseId: "resp_candidates",
        model: value.model,
        usage: { total_tokens: 100 },
      };
    },
  };

  const result = await generateCandidates({
    transcript: fixtures.transcript,
    visualMap: fixtures.visualMap,
    coreBundle: fixtures.coreBundle,
    mode: "chat",
    client,
  });
  assert.equal(request.model, "gpt-5.6-sol");
  assert.match(request.instructions, /private Tianzong clipping core/);
  assert.match(request.instructions, /聊播优先独立结论/);
  assert.match(request.input[0].content[0].text, /There is no target number/);
  assert.equal(result.candidates[0].validationStatus, "editorial_candidate_needs_av_review");
  assert.equal(result.coreBinding.coreSha256, "a".repeat(64));
});

test("candidate generation computes score totals deterministically without retrying the model", async () => {
  const fixtures = candidateFixtures();
  let calls = 0;
  const result = await generateCandidates({
    transcript: fixtures.transcript,
    visualMap: fixtures.visualMap,
    coreBundle: fixtures.coreBundle,
    mode: "chat",
    client: {
      async createStructuredResponse(value) {
        calls += 1;
        return {
          parsed: {
            candidates: [{
              ...fixtures.candidate,
              score: { ...fixtures.candidate.score, total: 99 },
            }],
            selectionSummary: {
              qualifyingCount: 1,
              rejectedThemes: [],
              notes: [],
            },
          },
          responseId: `resp_candidate_score_${calls}`,
          model: value.model,
          usage: { total_tokens: 20 },
        };
      },
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].score.total, 100);
});

test("candidate generation rejects one unsupported opening without restarting the livestream", async () => {
  const fixtures = candidateFixtures();
  let calls = 0;
  const result = await generateCandidates({
    transcript: fixtures.transcript,
    visualMap: fixtures.visualMap,
    coreBundle: fixtures.coreBundle,
    mode: "chat",
    client: {
      async createStructuredResponse(value) {
        calls += 1;
        return {
          parsed: {
            candidates: [
              fixtures.candidate,
              {
                ...fixtures.candidate,
                candidateId: "unsupported-opening",
                openingLine: "这句原话并不存在于逐字稿里。",
              },
            ],
            selectionSummary: {
              qualifyingCount: 2,
              rejectedThemes: [],
              notes: [],
            },
          },
          responseId: `resp_candidate_salvage_${calls}`,
          model: value.model,
          usage: { total_tokens: 20 },
        };
      },
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].openingLine, fixtures.candidate.openingLine);
  assert.match(
    result.selectionSummary.rejectedThemes.join("\n"),
    /CANDIDATE_OPENING_LINE_UNSUPPORTED/,
  );
  assert.match(
    result.selectionSummary.notes.join("\n"),
    /without restarting the livestream/,
  );
});

test("candidate generation rejects one out-of-window deletion without restarting the livestream", async () => {
  const fixtures = candidateFixtures();
  let calls = 0;
  const result = await generateCandidates({
    transcript: fixtures.transcript,
    visualMap: fixtures.visualMap,
    coreBundle: fixtures.coreBundle,
    mode: "chat",
    client: {
      async createStructuredResponse(value) {
        calls += 1;
        return {
          parsed: {
            candidates: [
              fixtures.candidate,
              {
                ...fixtures.candidate,
                candidateId: "invalid-deletion",
                deleteSuggestions: [{
                  startSec: 22,
                  endSec: 24,
                  transcriptSegmentIds: ["tx_2"],
                  reason: "错误地越过候选安全窗。",
                }],
              },
            ],
            selectionSummary: {
              qualifyingCount: 2,
              rejectedThemes: [],
              notes: [],
            },
          },
          responseId: `resp_candidate_delete_salvage_${calls}`,
          model: value.model,
          usage: { total_tokens: 20 },
        };
      },
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].openingLine, fixtures.candidate.openingLine);
  assert.match(
    result.selectionSummary.rejectedThemes.join("\n"),
    /DELETE_SUGGESTION_OUTSIDE_WINDOW/,
  );
  assert.match(
    result.selectionSummary.notes.join("\n"),
    /without restarting the livestream/,
  );
});

test("semantic recall planning keeps a question and its answer together", () => {
  const transcript = {
    mediaDurationSec: 500,
    segments: [
      {
        id: "s1",
        speaker: "A",
        startSec: 0,
        endSec: 100,
        text: "先讲背景。",
      },
      {
        id: "s2",
        speaker: "B",
        startSec: 100,
        endSec: 140,
        text: "为什么？",
      },
      {
        id: "s3",
        speaker: "A",
        startSec: 141,
        endSec: 220,
        text: "因为赚钱和事业根本不是一回事。",
      },
      {
        id: "s4",
        speaker: "A",
        startSec: 230,
        endSec: 330,
        text: "另一个话题。",
      },
      {
        id: "s5",
        speaker: "A",
        startSec: 340,
        endSec: 440,
        text: "结尾。",
      },
    ],
  };
  const windows = planCandidateRecallWindows({
    transcript,
    config: {
      targetWindowSec: 140,
      maxWindowSec: 260,
      minWindowSec: 50,
      overlapSec: 10,
      maxTranscriptChars: 5_000,
      maxOutputTokensPerBatch: 1_000,
    },
  });
  assert.deepEqual(windows[0].ownedTranscriptSegmentIds, ["s1", "s2", "s3"]);
  assert.deepEqual(windows[1].ownedTranscriptSegmentIds, ["s4", "s5"]);
  assert.ok(
    windows.every((window) =>
      window.contextStartSec <= window.ownershipStartSec
      && window.contextEndSec >= window.ownershipEndSec),
  );
});

test("multi-hour recall is batched, core-bound on every request, and naturally counted", async () => {
  const transcript = {
    mediaDurationSec: 7_200,
    segments: Array.from({ length: 120 }, (_, index) => ({
      id: `tx_${index + 1}`,
      speaker: index % 3 === 0 ? "viewer" : "tianzong",
      startSec: index * 60,
      endSec: index * 60 + 45,
      text: `第${index + 1}个自然内容单元。`,
    })),
  };
  const visualMap = {
    coverage: {
      fullTimelineScreeningComplete: true,
      continuousAudioVideoReviewed: false,
      limitation: "Sparse still-frame evidence.",
    },
    events: transcript.segments.map((segment, index) => ({
      id: `visual_${index + 1}`,
      startSec: segment.startSec,
      endSec: segment.endSec,
      eventType: "speaker_expression",
      description: `第${index + 1}段的稀疏画面证据`,
      actions: [],
      expressions: ["认真"],
      products: [],
      onscreenText: [],
      clipSignals: ["观点"],
      evidenceFrameIds: [`frame_${index + 1}`],
      confidence: 0.8,
      uncertainties: ["没有连续播放"],
    })),
  };
  const requests = [];
  const progress = [];
  const coreBundle = candidateFixtures().coreBundle;
  const client = {
    async createStructuredResponse(value) {
      requests.push(value);
      const payload = JSON.parse(value.input[0].content[0].text);
      const owned = payload.transcript.find(
        (segment) =>
          segment.startSec >= payload.recallBatch.ownershipWindow.startSec
          && segment.endSec <= payload.recallBatch.ownershipWindow.endSec,
      );
      assert.ok(owned);
      const visual = payload.visualEvents.find(
        (event) => event.startSec === owned.startSec,
      );
      assert.ok(visual);
      return {
        parsed: {
          candidates: [{
            candidateId: `source_${payload.recallBatch.batchId}`,
            title: owned.text,
            douyinTitle: owned.text,
            xiaohongshuTitle: `天总把这件事讲明白了：${owned.text}`,
            hook: owned.text,
            openingLine: owned.text,
            topic: "自然主题",
            contentPillar: "直播内容",
            rationale: "证据闭环",
            recallWindow: {
              startSec: owned.startSec,
              endSec: owned.endSec,
            },
            safetyWindow: {
              startSec: Math.max(
                payload.recallBatch.evidenceWindow.startSec,
                owned.startSec - 1,
              ),
              endSec: Math.min(
                payload.recallBatch.evidenceWindow.endSec,
                owned.endSec + 1,
              ),
            },
            transcriptSegmentIds: [owned.id],
            visualEventIds: [visual.id],
            requiredVisualProof: ["仍需完整正常播放安全窗"],
            deleteSuggestions: [],
            score: {
              hook: 16,
              emotion: 10,
              insight: 16,
              controversy: 8,
              completeness: 14,
              titlePotential: 12,
              total: 76,
            },
            risks: ["稀疏静帧不能完成连续视听核验"],
            validationStatus: "editorial_candidate_needs_av_review",
          }],
          selectionSummary: {
            qualifyingCount: 1,
            rejectedThemes: [],
            notes: [`${payload.recallBatch.batchId} 自然召回 1 条`],
          },
        },
        responseId: `resp_${requests.length}`,
        model: value.model,
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      };
    },
  };

  const result = await generateCandidates({
    transcript,
    visualMap,
    coreBundle,
    mode: "chat",
    client,
    onBatchProgress: async (value) => progress.push(value),
  });

  assert.ok(requests.length > 1);
  assert.equal(result.recallRuns.length, requests.length);
  assert.equal(result.candidates.length, requests.length);
  assert.equal(progress.length, requests.length);
  assert.equal(result.usage.total_tokens, requests.length * 150);
  assert.ok(requests.every((request) =>
    request.instructions.includes(coreBundle.coreSha256)
    && request.instructions.includes(coreBundle.privateKnowledge)),
  );
  assert.ok(requests.every((request) => {
    const payload = JSON.parse(request.input[0].content[0].text);
    return payload.transcript.length < transcript.segments.length
      && payload.constraints.some((constraint) =>
        constraint.includes("no target number")
        || constraint.includes("any natural count"));
  }));
  assert.ok(result.candidates.every((candidate) =>
    candidate.coreBinding.coreSha256 === coreBundle.coreSha256
    && candidate.evidenceBinding.transcriptSegmentIds.length > 0
    && candidate.evidenceBinding.visualEventIds.length > 0
    && candidate.evidenceBinding.continuousAudioVideoReviewed === false
    && candidate.evidenceBinding.audioVideoVerified === false
    && candidate.validationStatus === "editorial_candidate_needs_av_review"),
  );
});

test("global merge removes overlap duplicates but preserves independent angles", () => {
  const fixtures = candidateFixtures();
  const independentAngle = {
    ...fixtures.candidate,
    candidateId: "angle_2",
    title: "长期价值比短期收入更重要",
    hook: "先想清楚长期价值",
    openingLine: "你要先想清楚长期价值",
    topic: "长期主义",
    contentPillar: "女性成长",
    rationale: "同一段里的另一个独立观点",
    score: {
      hook: 18,
      emotion: 10,
      insight: 18,
      controversy: 8,
      completeness: 15,
      titlePotential: 13,
      total: 82,
    },
  };
  const duplicate = {
    ...fixtures.candidate,
    candidateId: "duplicate_from_overlap",
    visualEventIds: ["visual_1"],
    requiredVisualProof: [
      ...fixtures.candidate.requiredVisualProof,
      "确认句尾没有被截断",
    ],
    score: {
      ...fixtures.candidate.score,
      completeness: 14,
      total: 99,
    },
  };
  const result = mergeCandidateBatchResults([
    {
      batch: { batchId: "recall_0001" },
      result: {
        candidates: [fixtures.candidate, independentAngle],
        selectionSummary: {
          qualifyingCount: 2,
          rejectedThemes: [],
          notes: [],
        },
      },
    },
    {
      batch: { batchId: "recall_0002" },
      result: {
        candidates: [duplicate],
        selectionSummary: {
          qualifyingCount: 1,
          rejectedThemes: [],
          notes: [],
        },
      },
    },
  ], {
    transcript: fixtures.transcript,
    visualMap: fixtures.visualMap,
    coreBundle: fixtures.coreBundle,
  });

  assert.equal(result.candidates.length, 2);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.openingLine),
    [
      "赚钱和事业根本不是一回事",
      "你要先想清楚长期价值",
    ],
  );
  assert.equal(result.candidates[0].recallProvenance.sources.length, 2);
  assert.equal(result.selectionSummary.qualifyingCount, 2);
});

test("candidate recall rejects an out-of-batch proposal without restarting the livestream", async () => {
  const fixtures = candidateFixtures();
  const client = {
    async createStructuredResponse(value) {
      return {
        parsed: {
          candidates: [{
            ...fixtures.candidate,
            recallWindow: { startSec: 2, endSec: 9 },
            safetyWindow: { startSec: 0, endSec: 11 },
          }],
          selectionSummary: {
            qualifyingCount: 1,
            rejectedThemes: [],
            notes: [],
          },
        },
        responseId: "resp_outside",
        model: value.model,
        usage: {},
      };
    },
  };
  const result = await generateCandidates({
    transcript: fixtures.transcript,
    visualMap: fixtures.visualMap,
    coreBundle: fixtures.coreBundle,
    mode: "chat",
    client,
    recallConfig: {
      targetWindowSec: 8,
      maxWindowSec: 10,
      minWindowSec: 2,
      overlapSec: 1,
      maxTranscriptChars: 5_000,
      maxOutputTokensPerBatch: 1_000,
    },
  });
  assert.equal(result.candidates.length, 0);
  assert.match(
    result.selectionSummary.rejectedThemes.join("\n"),
    /CANDIDATE_OUTSIDE_RECALL_BATCH/,
  );
});

test("candidate validation fails closed on invented evidence or premature AV claims", () => {
  const fixtures = candidateFixtures();
  const baseResult = {
    candidates: [fixtures.candidate],
    selectionSummary: {
      qualifyingCount: 1,
      rejectedThemes: [],
      notes: [],
    },
  };
  assert.equal(validateCandidateResult(baseResult, {
    transcript: fixtures.transcript,
    visualMap: fixtures.visualMap,
    durationSec: 30,
  }), true);

  assert.throws(
    () => validateCandidateResult({
      ...baseResult,
      candidates: [{
        ...fixtures.candidate,
        visualEventIds: ["invented_visual"],
      }],
    }, {
      transcript: fixtures.transcript,
      visualMap: fixtures.visualMap,
      durationSec: 30,
    }),
    (error) => error.code === "CANDIDATE_VISUAL_EVIDENCE_INVALID",
  );
  assert.throws(
    () => validateCandidateResult({
      ...baseResult,
      candidates: [{
        ...fixtures.candidate,
        validationStatus: "av_verified",
      }],
    }, {
      transcript: fixtures.transcript,
      visualMap: fixtures.visualMap,
      durationSec: 30,
    }),
    (error) => error.code === "PREMATURE_AV_VERIFICATION",
  );
});

test("safety-window proxy renders a continuous audio-video review artifact, not a final cut", async () => {
  const { candidate } = candidateFixtures();
  let invocation;
  const proxy = await renderCandidateSafetyProxy({
    sourcePath: "/tmp/source.mp4",
    outputPath: "/tmp/candidate-review.mp4",
    candidate,
    mediaDurationSec: 30,
    verifyOutput: false,
    runner: async (command, args) => {
      invocation = { command, args };
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(invocation.command, "ffmpeg");
  assert.equal(invocation.args[invocation.args.indexOf("-ss") + 1], "1.000");
  assert.equal(invocation.args[invocation.args.indexOf("-t") + 1], "20.000");
  assert.ok(invocation.args.includes("0:v:0"));
  assert.ok(invocation.args.includes("0:a:0"));
  assert.equal(proxy.isFinalCut, false);
  assert.equal(proxy.validationStatus, VALIDATION_STATUSES.PROXY_READY);
});

test("AV verification is impossible until a human confirms full normal playback", () => {
  const { candidate } = candidateFixtures();
  const proxy = {
    candidateId: candidate.candidateId,
    validationStatus: VALIDATION_STATUSES.PROXY_READY,
  };
  assert.equal(deriveCandidateValidation({ candidate }).audioVideoVerified, false);
  assert.equal(deriveCandidateValidation({ candidate, proxy }).audioVideoVerified, false);

  assert.throws(
    () => deriveCandidateValidation({
      candidate,
      proxy,
      humanReview: {
        reviewSource: "human_ui",
        reviewerId: "editor-1",
        reviewedAt: "2026-07-27T10:00:00.000Z",
        decision: "approved",
        normalPlaybackConfirmed: false,
        audioVideoSyncConfirmed: true,
        reviewedWholeProxy: true,
      },
    }),
    (error) => error.code === "NORMAL_PLAYBACK_CONFIRMATION_REQUIRED",
  );

  const verified = deriveCandidateValidation({
    candidate,
    proxy,
    humanReview: {
      reviewSource: "human_ui",
      reviewerId: "editor-1",
      reviewedAt: "2026-07-27T10:00:00.000Z",
      decision: "approved",
      normalPlaybackConfirmed: true,
      audioVideoSyncConfirmed: true,
      reviewedWholeProxy: true,
      notes: "完整播放安全窗，口型、动作、语义均连续。",
    },
  });
  assert.equal(verified.validationStatus, VALIDATION_STATUSES.HUMAN_AV_VERIFIED);
  assert.equal(verified.audioVideoVerified, true);
  assert.equal(verified.verifiedByHuman, true);
});

test("OpenAI structured response client fails closed on refusals and malformed output", async () => {
  const refusalClient = createOpenAIClient({
    apiKey: "test-key",
    fetchImpl: async () => jsonResponse({
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "refusal", refusal: "Cannot comply" }],
      }],
    }),
  });
  await assert.rejects(
    () => refusalClient.createStructuredResponse({
      instructions: "Analyze",
      input: [{ role: "user", content: [{ type: "input_text", text: "x" }] }],
      schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
      schemaName: "empty",
    }),
    (error) => error.code === "OPENAI_RESPONSE_REFUSAL",
  );

  const malformedClient = createOpenAIClient({
    apiKey: "test-key",
    fetchImpl: async () => jsonResponse({
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "{not-json" }],
      }],
    }),
  });
  await assert.rejects(
    () => malformedClient.createStructuredResponse({
      instructions: "Analyze",
      input: [{ role: "user", content: [{ type: "input_text", text: "x" }] }],
      schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
      schemaName: "empty",
    }),
    (error) => error.code === "OPENAI_STRUCTURED_OUTPUT_INVALID",
  );
});

test("OpenAI Responses client sends the official image and strict text.format contract", async () => {
  let requestBody;
  const client = createOpenAIClient({
    apiKey: "test-key",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      requestBody = JSON.parse(init.body);
      return jsonResponse({
        id: "resp_1",
        status: "completed",
        model: "gpt-5.6-sol",
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({ answer: "ok" }),
          }],
        }],
      });
    },
  });

  const result = await client.createStructuredResponse({
    instructions: "Use only visible evidence.",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "FRAME frame_1" },
        { type: "input_image", image_url: "data:image/jpeg;base64,AA==", detail: "high" },
      ],
    }],
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
    schemaName: "answer_schema",
  });
  assert.deepEqual(result.parsed, { answer: "ok" });
  assert.equal(requestBody.model, "gpt-5.6-sol");
  assert.equal(requestBody.reasoning.effort, "medium");
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.equal(requestBody.text.format.name, "answer_schema");
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(requestBody.input[0].content[1].type, "input_image");
});

test("Doubao editor executes the same structured Skill contract through Ark Responses", async () => {
  let requestBody;
  const client = createDoubaoEditorClient({
    apiKey: "test-ark-key",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://ark.cn-beijing.volces.com/api/v3/responses");
      requestBody = JSON.parse(init.body);
      return jsonResponse({
        id: "resp_doubao_1",
        status: "completed",
        model: "doubao-seed-2-0-pro-260215",
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({ answer: "same-skill" }),
          }],
        }],
      });
    },
  });

  const result = await client.createStructuredResponse({
    instructions: "TIANZONG PRIVATE SKILL",
    input: [{
      role: "user",
      content: [{ type: "input_text", text: "shared evidence" }],
    }],
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
    schemaName: "same_skill_schema",
  });

  assert.deepEqual(result.parsed, { answer: "same-skill" });
  assert.equal(requestBody.model, "doubao-seed-2-0-pro-260215");
  assert.equal(requestBody.instructions, "TIANZONG PRIVATE SKILL");
  assert.equal(requestBody.input[0].content[0].text, "shared evidence");
  assert.equal(requestBody.thinking.type, "enabled");
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(result.provider, "doubao");
});
