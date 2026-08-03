import assert from "node:assert/strict";
import test from "node:test";
import { reusableEditorialResults } from "../editorial-checkpoint.js";

const evidenceIdentity = {
  sourceSha256: "a".repeat(64),
  sourceSizeBytes: 123,
  mediaDurationSec: 7200,
  coreSha256: "b".repeat(64),
  coreVersion: "1.0",
  mode: "chat",
  analysisWindowSeconds: 600,
};

test("adding Kimi reuses matching OpenAI and Doubao runs from compare mode", () => {
  const results = reusableEditorialResults({
    checkpoint: {
      schemaVersion: "tianclip.editorial-recall-checkpoint.v1",
      identity: { ...evidenceIdentity, editorMode: "compare" },
      results: [
        { editorProvider: "openai", model: "gpt-5.6-sol", candidates: [] },
        { editorProvider: "doubao", model: "doubao-seed-pro", candidates: [] },
      ],
    },
    currentIdentity: { ...evidenceIdentity, editorMode: "compare_all" },
    requestedModels: {
      openai: "gpt-5.6-sol",
      doubao: "doubao-seed-pro",
      kimi: "kimi-k3",
    },
  });

  assert.deepEqual(
    results.map((result) => result.editorProvider),
    ["openai", "doubao"],
  );
});

test("changed provider models or changed evidence are never reused", () => {
  const checkpoint = {
    schemaVersion: "tianclip.editorial-recall-checkpoint.v1",
    identity: evidenceIdentity,
    results: [
      { editorProvider: "openai", model: "old-model", candidates: [] },
    ],
  };

  assert.deepEqual(reusableEditorialResults({
    checkpoint,
    currentIdentity: evidenceIdentity,
    requestedModels: { openai: "new-model" },
  }), []);
  assert.deepEqual(reusableEditorialResults({
    checkpoint,
    currentIdentity: { ...evidenceIdentity, sourceSizeBytes: 999 },
    requestedModels: { openai: "old-model" },
  }), []);
});
