type UnknownRecord = Record<string, unknown>;

const EVIDENCE_IDENTITY_KEYS = [
  "sourceSha256",
  "sourceSizeBytes",
  "mediaDurationSec",
  "coreSha256",
  "coreVersion",
  "mode",
  "analysisWindowSeconds",
] as const;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function sameEvidenceIdentity(saved: UnknownRecord, current: UnknownRecord): boolean {
  return EVIDENCE_IDENTITY_KEYS.every(
    (key) => JSON.stringify(saved[key]) === JSON.stringify(current[key]),
  );
}

/**
 * Reuse completed editorial runs provider-by-provider. The requested comparison
 * mode is deliberately not part of the reusable identity: adding Kimi to an
 * existing OpenAI/Doubao comparison must only run Kimi, not rebill the two
 * providers whose results already match the same source, Skill and model.
 */
export function reusableEditorialResults(input: {
  checkpoint: unknown;
  currentIdentity: UnknownRecord;
  requestedModels: Record<string, string>;
}): UnknownRecord[] {
  const checkpoint = record(input.checkpoint);
  const identity = record(checkpoint?.identity);
  if (
    checkpoint?.schemaVersion !== "tianclip.editorial-recall-checkpoint.v1"
    || !identity
    || !sameEvidenceIdentity(identity, input.currentIdentity)
    || !Array.isArray(checkpoint.results)
  ) {
    return [];
  }

  const reusable = new Map<string, UnknownRecord>();
  for (const value of checkpoint.results) {
    const result = record(value);
    if (!result) continue;
    const provider = typeof result.editorProvider === "string"
      ? result.editorProvider
      : "";
    const expectedModel = input.requestedModels[provider];
    if (
      expectedModel
      && result.model === expectedModel
      && !reusable.has(provider)
    ) {
      reusable.set(provider, result);
    }
  }
  return [...reusable.values()];
}
