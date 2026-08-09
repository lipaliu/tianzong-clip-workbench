import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_USD_TO_CNY,
  MODEL_RATES,
  normalizeUsage,
  priceDurationUsage,
  priceModelUsage,
  summarizeJobCost,
  sumUsage,
} from "../pricing.js";
import type { CostEntry } from "../pricing.js";

test("usage counters are read from both provider field conventions", () => {
  // OpenAI Responses.
  assert.deepEqual(
    normalizeUsage({
      input_tokens: 1_000,
      output_tokens: 200,
      input_tokens_details: { cached_tokens: 400 },
    }),
    { inputTokens: 1_000, outputTokens: 200, cachedInputTokens: 400 },
  );
  // Ark chat/responses.
  assert.deepEqual(
    normalizeUsage({
      prompt_tokens: 1_000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 400 },
    }),
    { inputTokens: 1_000, outputTokens: 200, cachedInputTokens: 400 },
  );
  // A cached count larger than the input count would let a discounted rate be
  // applied to tokens that were never billed.
  assert.equal(
    normalizeUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 900 } })
      .cachedInputTokens,
    100,
  );
  assert.deepEqual(normalizeUsage(null), {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  });
  assert.deepEqual(normalizeUsage({ input_tokens: -5 }).inputTokens, 0);
});

test("cache-hit tokens are billed once, at the discounted rate", () => {
  const priced = priceModelUsage("doubao-seed-2-0-pro-260215", {
    prompt_tokens: 100_000,
    completion_tokens: 10_000,
    prompt_tokens_details: { cached_tokens: 80_000 },
  });
  assert.equal(priced.priced, true);
  // 20k full-rate input + 80k cached input + 10k output, all in CNY.
  const expected = (20_000 * 3.2 + 80_000 * 0.64 + 10_000 * 16) / 1_000_000;
  assert.equal(priced.costCny, Math.round(expected * 10_000) / 10_000);
  // Charging the cached tokens at the full rate too would inflate this.
  assert.ok(priced.costCny! < (100_000 * 3.2 + 10_000 * 16) / 1_000_000);
});

test("USD list prices are converted with the recorded rate", () => {
  const priced = priceModelUsage(
    "gpt-5.6-sol",
    { input_tokens: 1_000_000, output_tokens: 0 },
    { usdToCny: 7 },
  );
  assert.equal(priced.costCny, 35); // $5 * 7
  assert.equal(priced.usdToCny, 7);
  const atDefault = priceModelUsage("gpt-5.6-sol", {
    input_tokens: 1_000_000,
    output_tokens: 0,
  });
  assert.equal(atDefault.usdToCny, DEFAULT_USD_TO_CNY);
});

test("an unknown model records usage but never invents a cost", () => {
  const priced = priceModelUsage("kimi-k2.5", {
    input_tokens: 500,
    output_tokens: 100,
  });
  assert.equal(priced.priced, false);
  assert.equal(priced.costCny, null);
  assert.match(priced.unpricedReason ?? "", /kimi-k2\.5/);
  // The usage itself is still preserved, so the run can be repriced later.
  assert.equal(priced.usage.inputTokens, 500);
  assert.equal(priced.usage.outputTokens, 100);
});

test("every published rate carries a source and a check date", () => {
  for (const [model, rate] of Object.entries(MODEL_RATES)) {
    assert.ok(rate.source.startsWith("https://"), `${model} has no source URL`);
    assert.match(rate.checkedOn, /^\d{4}-\d{2}-\d{2}$/, `${model} check date`);
    assert.ok(rate.inputPerMillion >= 0 && rate.outputPerMillion >= 0);
  }
});

test("duration-billed resources price by audio hour", () => {
  const priced = priceDurationUsage("volc.bigasr.auc", 10_358.755);
  assert.equal(priced.priced, true);
  assert.equal(priced.costCny, Math.round(10_358.755 / 3600 * 0.8 * 10_000) / 10_000);
  const unknown = priceDurationUsage("some.other.asr", 3600);
  assert.equal(unknown.priced, false);
  assert.equal(unknown.costCny, null);
});

test("per-call usages sum across a batched stage", () => {
  const summed = sumUsage([
    { input_tokens: 10, output_tokens: 1 },
    null,
    { prompt_tokens: 20, completion_tokens: 2 },
  ]);
  assert.deepEqual(summed, {
    inputTokens: 30,
    outputTokens: 3,
    cachedInputTokens: 0,
  });
});

function entry(overrides: Partial<CostEntry>): CostEntry {
  return {
    stage: "candidate_recall",
    provider: "doubao",
    model: "doubao-seed-2-0-pro-260215",
    priced: true,
    costCny: 1,
    unpricedReason: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    billedSeconds: null,
    rateSource: "https://example.invalid",
    rateCheckedOn: "2026-08-07",
    usdToCny: DEFAULT_USD_TO_CNY,
    ...overrides,
  };
}

test("cost per delivered second divides by output, not source length", () => {
  const summary = summarizeJobCost(
    [
      entry({ stage: "transcription", costCny: 2.3 }),
      entry({ stage: "candidate_recall", costCny: 2.52 }),
      entry({ stage: "candidate_av_review", costCny: 3.68 }),
    ],
    { clipSeconds: 6_126, clipCount: 74, sourceMediaSeconds: 10_358.755 },
  );
  assert.equal(summary.totalCny, 8.5);
  assert.equal(summary.complete, true);
  assert.equal(summary.deliveredClipSeconds, 6_126);
  assert.equal(summary.deliveredClipCount, 74);
  assert.equal(
    summary.cnyPerDeliveredSecond,
    Math.round(8.5 / 6_126 * 1_000_000) / 1_000_000,
  );
  // Same total over a different source length gives the same per-second rate,
  // which is the whole point of dividing by delivered output.
  const longer = summarizeJobCost(
    [entry({ costCny: 8.5 })],
    { clipSeconds: 6_126, clipCount: 74, sourceMediaSeconds: 5 * 3600 },
  );
  assert.equal(longer.cnyPerDeliveredSecond, summary.cnyPerDeliveredSecond);
  assert.notEqual(longer.cnyPerSourceHour, summary.cnyPerSourceHour);
});

test("one unpriced stage suppresses the per-second rate", () => {
  const summary = summarizeJobCost(
    [
      entry({ stage: "candidate_recall", costCny: 2.52 }),
      entry({
        stage: "candidate_av_review",
        priced: false,
        costCny: null,
        unpricedReason: "no published rate on file",
      }),
    ],
    { clipSeconds: 6_126, clipCount: 74, sourceMediaSeconds: 10_358.755 },
  );
  // The partial total is still reported, but publishing a rate derived from it
  // would understate the true cost by however much the missing stage came to.
  assert.equal(summary.totalCny, 2.52);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.unpricedStages, ["candidate_av_review"]);
  assert.equal(summary.cnyPerDeliveredSecond, null);
  assert.equal(summary.cnyPerSourceHour, null);
});

test("a job that delivered nothing has no per-second rate", () => {
  const summary = summarizeJobCost(
    [entry({ costCny: 4 })],
    { clipSeconds: 0, clipCount: 0, sourceMediaSeconds: 3600 },
  );
  assert.equal(summary.totalCny, 4);
  assert.equal(summary.cnyPerDeliveredSecond, null);
  // Source-hour cost is still meaningful: the run burned money for no output.
  assert.equal(summary.cnyPerSourceHour, 4);
});
