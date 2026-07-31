import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTranscriptCheckpoint,
  restoreTranscriptCheckpoint,
} from "../transcript-checkpoint.js";

const identity = {
  sourceSha256: "a".repeat(64),
  sourceSizeBytes: 8_242_271_965,
  mediaDurationSec: 10_358.755,
  transcriptionProvider: "doubao",
};

const transcriptRoute = {
  value: {
    provider: "doubao",
    mediaDurationSec: 10_358.755,
    segments: [
      {
        id: "tx_1",
        speaker: "speaker_0",
        text: "赚钱和事业根本不是一回事。",
        startSec: 10,
        endSec: 13,
      },
      {
        id: "tx_2",
        speaker: "speaker_0",
        text: "你要先把长期价值想明白。",
        startSec: 13,
        endSec: 16,
      },
    ],
  },
  route: {
    requestedProvider: "doubao",
    effectiveProvider: "doubao",
    fallbackUsed: false,
  },
};

test("transcript checkpoint restores only the same verified source", () => {
  const checkpoint = buildTranscriptCheckpoint(transcriptRoute, identity);
  assert.deepEqual(
    restoreTranscriptCheckpoint(checkpoint, identity),
    transcriptRoute,
  );
  assert.equal(
    restoreTranscriptCheckpoint(checkpoint, {
      ...identity,
      sourceSha256: "b".repeat(64),
    }),
    null,
  );
});

test("transcript checkpoint rejects incomplete or out-of-range evidence", () => {
  const checkpoint = buildTranscriptCheckpoint(transcriptRoute, identity);
  assert.equal(
    restoreTranscriptCheckpoint({
      ...checkpoint,
      transcript: {
        ...transcriptRoute.value,
        segments: [{
          ...transcriptRoute.value.segments[0],
          endSec: identity.mediaDurationSec + 10,
        }],
      },
    }, identity),
    null,
  );
});
