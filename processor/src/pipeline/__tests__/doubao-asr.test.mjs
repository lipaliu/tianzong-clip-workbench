import test from "node:test";
import assert from "node:assert/strict";

import {
  createDoubaoBigAsrClient,
  normalizeDoubaoBigAsrResult,
} from "../doubao-asr.mjs";

function apiResponse(payload, {
  apiStatusCode = "20000000",
  apiMessage = "OK",
  logId = "safe-log-id",
  httpStatus = 200,
} = {}) {
  return new Response(JSON.stringify(payload), {
    status: httpStatus,
    headers: {
      "content-type": "application/json",
      "x-api-status-code": apiStatusCode,
      "x-api-message": apiMessage,
      "x-tt-logid": logId,
    },
  });
}

test("Doubao BigASR submits, polls, and normalizes a diarized transcript with API-key auth", async () => {
  const calls = [];
  const sleeps = [];
  const responses = [
    apiResponse({}),
    apiResponse({}, { apiStatusCode: "20000001" }),
    apiResponse({
      audio_info: { duration: 3200 },
      result: {
        text: "带货是长线的。上来需要先学两年。",
        utterances: [
          {
            id: "utterance-a",
            start_time: 100,
            end_time: 1400,
            text: " 带货是长线的。 ",
            additions: { speaker: "0" },
          },
          {
            id: "utterance-b",
            start_time: 1600,
            end_time: 3100,
            text: "上来需要先学两年。",
            additions: { speaker: "1" },
          },
        ],
      },
    }),
  ];
  const client = createDoubaoBigAsrClient({
    apiKey: "new-console-secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    },
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    requestIdFactory: () => "task-0001",
    now: () => Date.UTC(2026, 6, 28),
    pollIntervalMs: 25,
    pollTimeoutMs: 1_000,
    maxPollAttempts: 4,
  });

  const progress = [];
  const transcript = await client.transcribeRecording({
    audioUrl: "https://media.example.test/live.flac?signature=private",
    audioFormat: "flac",
    mediaDurationSec: 3.2,
    onProgress: (event) => progress.push(event),
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit");
  assert.equal(calls[1].url, "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query");
  assert.equal(calls[0].init.headers["X-Api-Key"], "new-console-secret");
  assert.equal(calls[0].init.headers["X-Api-App-Key"], undefined);
  assert.equal(calls[0].init.headers["X-Api-Request-Id"], "task-0001");
  assert.equal(calls[0].init.headers["X-Api-Resource-Id"], "volc.bigasr.auc");
  assert.equal(calls[0].init.headers["X-Api-Sequence"], "-1");
  assert.equal(calls[1].init.headers["X-Tt-Logid"], "safe-log-id");

  const submitBody = JSON.parse(calls[0].init.body);
  assert.equal(submitBody.audio.format, "flac");
  assert.equal(submitBody.request.model_name, "bigmodel");
  assert.equal(submitBody.request.show_utterances, true);
  assert.equal(submitBody.request.enable_speaker_info, true);
  assert.deepEqual(sleeps, [25]);
  assert.deepEqual(progress.map((event) => event.status), [
    "accepted",
    "queued",
    "completed",
  ]);

  assert.equal(transcript.model, "doubao-bigasr-2.0");
  assert.equal(transcript.provider, "doubao");
  assert.equal(transcript.mediaDurationSec, 3.2);
  assert.deepEqual(transcript.speakerLabels, ["speaker_0", "speaker_1"]);
  assert.deepEqual(transcript.segments.map((segment) => ({
    sourceSegmentId: segment.sourceSegmentId,
    speaker: segment.speaker,
    text: segment.text,
    startSec: segment.startSec,
    endSec: segment.endSec,
  })), [
    {
      sourceSegmentId: "utterance-a",
      speaker: "speaker_0",
      text: "带货是长线的。",
      startSec: 0.1,
      endSec: 1.4,
    },
    {
      sourceSegmentId: "utterance-b",
      speaker: "speaker_1",
      text: "上来需要先学两年。",
      startSec: 1.6,
      endSec: 3.1,
    },
  ]);
  assert.equal(transcript.coverage.chunkCount, 1);
  assert.equal(transcript.coverage.ownershipPartitionApplied, false);
  assert.deepEqual(transcript.provenance, {
    provider: "doubao",
    service: "recording_file_asr",
    apiVersion: "v3",
    resourceId: "volc.bigasr.auc",
    taskId: "task-0001",
    originalTimestampUnit: "milliseconds",
    speakerDiarizationRequested: true,
  });
  assert.equal(transcript.generatedAt, "2026-07-28T00:00:00.000Z");
});

test("Doubao BigASR supports legacy AppID and access-token authentication", async () => {
  let request;
  const client = createDoubaoBigAsrClient({
    appId: "legacy-app",
    accessToken: "legacy-token",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return apiResponse({});
    },
    requestIdFactory: () => "legacy-task",
  });

  const result = await client.submitRecording({
    audioUrl: "https://media.example.test/audio.wav",
  });
  assert.equal(result.taskId, "legacy-task");
  assert.equal(request.init.headers["X-Api-App-Key"], "legacy-app");
  assert.equal(request.init.headers["X-Api-Access-Key"], "legacy-token");
  assert.equal(request.init.headers["X-Api-Key"], undefined);
});

test("Doubao BigASR polling has a hard attempt limit and reports a typed timeout", async () => {
  let queryCount = 0;
  const client = createDoubaoBigAsrClient({
    apiKey: "timeout-secret",
    fetchImpl: async () => {
      queryCount += 1;
      return apiResponse({}, { apiStatusCode: "20000002" });
    },
    sleepImpl: async () => undefined,
    pollIntervalMs: 10,
    pollTimeoutMs: 10_000,
    maxPollAttempts: 3,
  });

  await assert.rejects(
    () => client.waitForRecording({ taskId: "timeout-task" }),
    (error) => {
      assert.equal(error.code, "DOUBAO_ASR_POLL_TIMEOUT");
      assert.equal(error.stage, "doubao_asr_poll");
      assert.equal(error.details.maxPollAttempts, 3);
      return true;
    },
  );
  assert.equal(queryCount, 3);
});

test("Doubao BigASR failures never expose configured credentials", async () => {
  const apiKey = "top-secret-api-key";
  const client = createDoubaoBigAsrClient({
    apiKey,
    fetchImpl: async () => apiResponse({}, {
      apiStatusCode: "45000000",
      apiMessage: `invalid X-Api-Key=${apiKey}`,
    }),
  });

  await assert.rejects(
    () => client.queryRecording({ taskId: "failed-task" }),
    (error) => {
      const serialized = JSON.stringify({
        message: error.message,
        details: error.details,
        cause: error.cause?.message,
      });
      assert.equal(error.code, "DOUBAO_ASR_TASK_FAILED");
      assert.doesNotMatch(serialized, new RegExp(apiKey));
      assert.match(serialized, /\[REDACTED\]/);
      return true;
    },
  );
});

test("Doubao BigASR normalization rejects invalid or out-of-range utterance timestamps", () => {
  assert.throws(
    () => normalizeDoubaoBigAsrResult({
      audio_info: { duration: 1_000 },
      result: {
        utterances: [{
          start_time: 900,
          end_time: 1_900,
          text: "越界",
        }],
      },
    }),
    (error) => error.code === "DOUBAO_ASR_SEGMENT_OUTSIDE_MEDIA",
  );

  assert.throws(
    () => normalizeDoubaoBigAsrResult({
      result: {
        utterances: [{
          start_time: 2_000,
          end_time: 1_000,
          text: "时间倒置",
        }],
      },
    }),
    (error) => error.code === "DOUBAO_ASR_TIMESTAMPS_INVALID",
  );
});

test("Doubao BigASR normalization skips empty utterances and fails only when every utterance is empty", () => {
  const transcript = normalizeDoubaoBigAsrResult({
    audio_info: { duration: 2_000 },
    result: {
      utterances: [
        {
          id: "empty-leading",
          start_time: 0,
          end_time: 400,
          text: " \n\t ",
        },
        {
          id: "spoken",
          start_time: 500,
          end_time: 1_500,
          text: " 有效内容 ",
          additions: { speaker: "1" },
        },
        {
          id: "empty-trailing",
          start_time: 1_600,
          end_time: 1_900,
          text: "",
        },
      ],
    },
  });

  assert.equal(transcript.segments.length, 1);
  assert.equal(transcript.segments[0].sourceSegmentId, "spoken");
  assert.equal(transcript.segments[0].text, "有效内容");
  assert.equal(transcript.segments[0].speaker, "speaker_1");
  assert.equal(transcript.text, "有效内容");

  assert.throws(
    () => normalizeDoubaoBigAsrResult({
      audio_info: { duration: 1_000 },
      result: {
        utterances: [
          {
            start_time: 0,
            end_time: 400,
            text: " ",
          },
          {
            start_time: 500,
            end_time: 900,
            text: "\n\t",
          },
        ],
      },
    }),
    (error) => error.code === "DOUBAO_ASR_UTTERANCE_EMPTY",
  );
});
