/**
 * Cost ledger pricing.
 *
 * Every model call already returns a provider `usage` object. This module is
 * the only place that turns those raw counters into money, so a price change
 * never has to be chased through the pipeline.
 *
 * Two rules keep the ledger honest:
 *
 * 1. An unknown model is recorded as `priced: false`. Usage is still stored,
 *    but no number is invented. A missing price must look missing.
 * 2. Every rate carries the source it was read from and the date it was
 *    checked. Published prices move; an unsourced rate cannot be audited.
 */

export type PriceCurrency = "CNY" | "USD";

export interface ModelRate {
  readonly currency: PriceCurrency;
  /** Price per 1,000,000 input tokens. */
  readonly inputPerMillion: number;
  /** Price per 1,000,000 output tokens. */
  readonly outputPerMillion: number;
  /** Price per 1,000,000 cache-hit input tokens, when the provider offers it. */
  readonly cachedInputPerMillion: number | null;
  readonly source: string;
  /** ISO date the rate was last checked against the source. */
  readonly checkedOn: string;
}

/** Per-hour rates for services billed by media duration rather than tokens. */
export interface DurationRate {
  readonly currency: PriceCurrency;
  readonly perHour: number;
  readonly source: string;
  readonly checkedOn: string;
}

/**
 * Published list prices. Volume discounts, prepaid resource packs and free
 * trial quota are deliberately ignored: the ledger reports list cost so two
 * runs stay comparable regardless of account state.
 */
export const MODEL_RATES: Readonly<Record<string, ModelRate>> = Object.freeze({
  "gpt-5.6-sol": {
    currency: "USD",
    inputPerMillion: 5,
    outputPerMillion: 30,
    cachedInputPerMillion: 0.5,
    source: "https://openai.com/index/gpt-5-6/",
    checkedOn: "2026-08-07",
  },
  "gpt-4o-transcribe-diarize": {
    currency: "USD",
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    cachedInputPerMillion: null,
    source: "https://openai.com/api/pricing/",
    checkedOn: "2026-08-07",
  },
  "kimi-k3": {
    currency: "USD",
    inputPerMillion: 3,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.3,
    source: "https://platform.kimi.ai/docs/pricing/chat-k3",
    checkedOn: "2026-08-08",
  },
  "doubao-seed-2-0-pro-260215": {
    currency: "CNY",
    inputPerMillion: 3.2,
    outputPerMillion: 16,
    cachedInputPerMillion: 0.64,
    source: "https://www.volcengine.com/docs/84458/1585097?lang=zh",
    checkedOn: "2026-08-07",
  },
  "doubao-seed-2-0-lite-260428": {
    currency: "CNY",
    inputPerMillion: 0.6,
    outputPerMillion: 3.6,
    cachedInputPerMillion: 0.12,
    source: "https://www.volcengine.com/docs/84458/1585097?lang=zh",
    checkedOn: "2026-08-07",
  },
});

export const DURATION_RATES: Readonly<Record<string, DurationRate>> =
  Object.freeze({
    "volc.bigasr.auc": {
      currency: "CNY",
      perHour: 0.8,
      source: "https://www.volcengine.com/docs/6561/1359370?lang=zh",
      checkedOn: "2026-08-07",
    },
  });

/**
 * USD list prices are converted so a run reports a single figure. The rate is
 * an operator-supplied constant, not a live quote, and is echoed into every
 * record so a historical total can be recomputed later.
 */
export const DEFAULT_USD_TO_CNY = 7.1;

export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Subset of `inputTokens` that the provider billed at the cache-hit rate. */
  readonly cachedInputTokens: number;
}

const ZERO_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
});

function finiteNonNegative(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return numeric;
}

function readCachedTokens(usage: Record<string, unknown>): number {
  for (const key of ["input_tokens_details", "prompt_tokens_details"]) {
    const details = usage[key];
    if (details && typeof details === "object") {
      const cached = (details as Record<string, unknown>).cached_tokens;
      if (cached !== undefined) return finiteNonNegative(cached);
    }
  }
  return finiteNonNegative(
    usage.cached_tokens ?? usage.cache_read_input_tokens ?? 0,
  );
}

/**
 * Providers disagree on field names: OpenAI Responses reports
 * `input_tokens`/`output_tokens`, Ark reports `prompt_tokens`/
 * `completion_tokens`. Both shapes are accepted; anything else yields zeros
 * rather than a guess.
 */
export function normalizeUsage(usage: unknown): NormalizedUsage {
  if (!usage || typeof usage !== "object") return ZERO_USAGE;
  const record = usage as Record<string, unknown>;
  const inputTokens = finiteNonNegative(
    record.input_tokens ?? record.prompt_tokens ?? 0,
  );
  const outputTokens = finiteNonNegative(
    record.output_tokens ?? record.completion_tokens ?? 0,
  );
  const cachedInputTokens = Math.min(readCachedTokens(record), inputTokens);
  return { inputTokens, outputTokens, cachedInputTokens };
}

/** Sums the per-call usage objects a pipeline stage collected. */
export function sumUsage(
  usages: readonly unknown[],
): NormalizedUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  for (const usage of usages) {
    const normalized = normalizeUsage(usage);
    inputTokens += normalized.inputTokens;
    outputTokens += normalized.outputTokens;
    cachedInputTokens += normalized.cachedInputTokens;
  }
  return { inputTokens, outputTokens, cachedInputTokens };
}

export interface PricedUsage {
  readonly priced: boolean;
  /** Populated only when `priced` is true. */
  readonly costCny: number | null;
  /** Why a cost is absent, for the operator-facing ledger. */
  readonly unpricedReason: string | null;
  readonly usage: NormalizedUsage;
  readonly rate: ModelRate | null;
  readonly usdToCny: number;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function priceModelUsage(
  model: string,
  usage: unknown,
  options: { usdToCny?: number } = {},
): PricedUsage {
  const usdToCny = options.usdToCny ?? DEFAULT_USD_TO_CNY;
  const normalized = normalizeUsage(usage);
  const rate = MODEL_RATES[model];
  if (!rate) {
    return {
      priced: false,
      costCny: null,
      unpricedReason: `no published rate on file for model ${model}`,
      usage: normalized,
      rate: null,
      usdToCny,
    };
  }

  // Cache-hit tokens are billed at the discounted rate and must not also be
  // charged at the full input rate.
  const billableCached = rate.cachedInputPerMillion === null
    ? 0
    : normalized.cachedInputTokens;
  const fullRateInput = normalized.inputTokens - billableCached;
  const raw = (fullRateInput * rate.inputPerMillion
    + billableCached * (rate.cachedInputPerMillion ?? 0)
    + normalized.outputTokens * rate.outputPerMillion) / 1_000_000;
  const costCny = rate.currency === "USD" ? raw * usdToCny : raw;

  return {
    priced: true,
    costCny: round4(costCny),
    unpricedReason: null,
    usage: normalized,
    rate,
    usdToCny,
  };
}

export interface PricedDuration {
  readonly priced: boolean;
  readonly costCny: number | null;
  readonly unpricedReason: string | null;
  readonly billedSeconds: number;
  readonly rate: DurationRate | null;
  readonly usdToCny: number;
}

export function priceDurationUsage(
  resourceId: string,
  seconds: number,
  options: { usdToCny?: number } = {},
): PricedDuration {
  const usdToCny = options.usdToCny ?? DEFAULT_USD_TO_CNY;
  const billedSeconds = finiteNonNegative(seconds);
  const rate = DURATION_RATES[resourceId];
  if (!rate) {
    return {
      priced: false,
      costCny: null,
      unpricedReason: `no published rate on file for resource ${resourceId}`,
      billedSeconds,
      rate: null,
      usdToCny,
    };
  }
  const raw = billedSeconds / 3600 * rate.perHour;
  return {
    priced: true,
    costCny: round4(rate.currency === "USD" ? raw * usdToCny : raw),
    unpricedReason: null,
    billedSeconds,
    rate,
    usdToCny,
  };
}

/** Pipeline stages the ledger bills separately. */
export type CostStage =
  | "transcription"
  | "candidate_recall"
  | "candidate_av_review"
  | "final_editorial"
  | "dense_visual_recall";

export interface CostEntry {
  readonly stage: CostStage;
  readonly provider: string;
  readonly model: string;
  readonly priced: boolean;
  readonly costCny: number | null;
  readonly unpricedReason: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly billedSeconds: number | null;
  readonly rateSource: string | null;
  readonly rateCheckedOn: string | null;
  readonly usdToCny: number;
}

export interface JobCostSummary {
  /** Sum over priced entries only. */
  readonly totalCny: number;
  /** True when every entry carried a published rate. */
  readonly complete: boolean;
  readonly unpricedStages: readonly string[];
  readonly perStageCny: Readonly<Record<string, number>>;
  /** Total seconds of rough-cut delivered by this job. */
  readonly deliveredClipSeconds: number;
  readonly deliveredClipCount: number;
  /**
   * Cost per delivered second — the figure that survives a livestream of any
   * length. Null when nothing was delivered or a stage went unpriced, because
   * a total missing one leg would understate the true rate.
   */
  readonly cnyPerDeliveredSecond: number | null;
  readonly sourceMediaSeconds: number;
  readonly cnyPerSourceHour: number | null;
}

export function summarizeJobCost(
  entries: readonly CostEntry[],
  delivered: {
    clipSeconds: number;
    clipCount: number;
    sourceMediaSeconds: number;
  },
): JobCostSummary {
  const perStage: Record<string, number> = {};
  const unpricedStages: string[] = [];
  let totalCny = 0;
  for (const entry of entries) {
    if (!entry.priced || entry.costCny === null) {
      if (!unpricedStages.includes(entry.stage)) unpricedStages.push(entry.stage);
      continue;
    }
    totalCny += entry.costCny;
    perStage[entry.stage] = round4((perStage[entry.stage] ?? 0) + entry.costCny);
  }
  totalCny = round4(totalCny);
  const complete = unpricedStages.length === 0 && entries.length > 0;
  const clipSeconds = finiteNonNegative(delivered.clipSeconds);
  const sourceMediaSeconds = finiteNonNegative(delivered.sourceMediaSeconds);
  return {
    totalCny,
    complete,
    unpricedStages,
    perStageCny: perStage,
    deliveredClipSeconds: round4(clipSeconds),
    deliveredClipCount: Math.max(0, Math.trunc(delivered.clipCount)),
    cnyPerDeliveredSecond: complete && clipSeconds > 0
      ? Math.round(totalCny / clipSeconds * 1_000_000) / 1_000_000
      : null,
    sourceMediaSeconds: round4(sourceMediaSeconds),
    cnyPerSourceHour: complete && sourceMediaSeconds > 0
      ? round4(totalCny / (sourceMediaSeconds / 3600))
      : null,
  };
}
