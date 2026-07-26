import { invariant } from "./errors.mjs";

function normalizeText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function roundMillis(value) {
  return Math.round(value * 1000) / 1000;
}

export function normalizeDiarizedChunk(raw, chunk) {
  invariant(raw && Array.isArray(raw.segments), "Diarized transcription returned no speaker segments", {
    code: "DIARIZED_SEGMENTS_MISSING",
    stage: "transcription",
    details: { chunkId: chunk?.id },
  });
  invariant(chunk && Number.isFinite(chunk.startSec) && Number.isFinite(chunk.endSec), "Audio chunk metadata is invalid", {
    code: "INVALID_AUDIO_CHUNK",
    stage: "transcription",
  });

  return raw.segments.map((segment, index) => {
    const localStartSec = Number(segment.start);
    const localEndSec = Number(segment.end);
    const text = normalizeText(segment.text);
    const speaker = normalizeText(segment.speaker);
    invariant(Number.isFinite(localStartSec) && Number.isFinite(localEndSec) && localEndSec >= localStartSec, "Transcription segment timestamps are invalid", {
      code: "INVALID_TRANSCRIPT_TIMESTAMPS",
      stage: "transcription",
      details: { chunkId: chunk.id, segment },
    });
    invariant(text.length > 0 && speaker.length > 0, "Transcription segment is missing text or speaker", {
      code: "INVALID_TRANSCRIPT_SEGMENT",
      stage: "transcription",
      details: { chunkId: chunk.id, segment },
    });

    const absoluteStartSec = roundMillis(chunk.startSec + localStartSec);
    const absoluteEndSec = roundMillis(chunk.startSec + localEndSec);
    invariant(absoluteStartSec >= chunk.startSec - 0.05 && absoluteEndSec <= chunk.endSec + 0.5, "Transcription segment falls outside its audio chunk", {
      code: "TRANSCRIPT_OUTSIDE_CHUNK",
      stage: "transcription",
      details: { chunkId: chunk.id, absoluteStartSec, absoluteEndSec },
    });

    return {
      id: `tx_${chunk.id}_${String(index + 1).padStart(5, "0")}`,
      sourceSegmentId: segment.id ?? null,
      chunkId: chunk.id,
      speaker,
      text,
      localStartSec: roundMillis(localStartSec),
      localEndSec: roundMillis(localEndSec),
      startSec: absoluteStartSec,
      endSec: absoluteEndSec,
    };
  });
}

export function stitchDiarizedChunks(chunkResults, {
  mediaDurationSec,
} = {}) {
  invariant(Array.isArray(chunkResults) && chunkResults.length > 0, "No transcription chunks were provided", {
    code: "TRANSCRIPTION_CHUNKS_MISSING",
    stage: "transcription_stitch",
  });
  invariant(Number.isFinite(mediaDurationSec) && mediaDurationSec > 0, "mediaDurationSec is required", {
    code: "INVALID_MEDIA_DURATION",
    stage: "transcription_stitch",
  });

  const ownedSegments = [];
  for (const { chunk, raw } of chunkResults) {
    const segments = normalizeDiarizedChunk(raw, chunk);
    for (const segment of segments) {
      const midpoint = (segment.startSec + segment.endSec) / 2;
      const belongsToChunk = midpoint >= chunk.ownershipStartSec - 0.001
        && midpoint < chunk.ownershipEndSec + (chunk.ownershipEndSec === mediaDurationSec ? 0.001 : 0);
      if (belongsToChunk) ownedSegments.push(segment);
    }
  }

  ownedSegments.sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec);
  const segments = [];
  for (const segment of ownedSegments) {
    invariant(segment.startSec >= -0.05 && segment.endSec <= mediaDurationSec + 0.5, "Stitched transcript falls outside the media timeline", {
      code: "TRANSCRIPT_OUTSIDE_MEDIA",
      stage: "transcription_stitch",
      details: { segment, mediaDurationSec },
    });
    const previous = segments.at(-1);
    const exactOverlapDuplicate = previous
      && previous.speaker === segment.speaker
      && previous.text === segment.text
      && Math.abs(previous.startSec - segment.startSec) < 0.25
      && Math.abs(previous.endSec - segment.endSec) < 0.25;
    if (!exactOverlapDuplicate) segments.push(segment);
  }

  invariant(segments.length > 0, "No owned transcript segments remained after chunk stitching", {
    code: "EMPTY_STITCHED_TRANSCRIPT",
    stage: "transcription_stitch",
  });

  return {
    model: "gpt-4o-transcribe-diarize",
    mediaDurationSec,
    segments,
    text: segments.map((segment) => segment.text).join("\n"),
    speakerLabels: [...new Set(segments.map((segment) => segment.speaker))],
    coverage: {
      firstSegmentStartSec: segments[0].startSec,
      lastSegmentEndSec: segments.at(-1).endSec,
      chunkCount: chunkResults.length,
      ownershipPartitionApplied: true,
    },
    generatedAt: new Date().toISOString(),
  };
}

export async function transcribeAudioChunks({
  chunks,
  client,
  mediaDurationSec,
  language = "zh",
  model = "gpt-4o-transcribe-diarize",
  signal = undefined,
  onProgress = undefined,
} = {}) {
  invariant(Array.isArray(chunks) && chunks.length > 0, "Audio chunks are required", {
    code: "TRANSCRIPTION_CHUNKS_MISSING",
    stage: "transcription",
  });
  invariant(client && typeof client.transcribeDiarized === "function", "An OpenAI client is required", {
    code: "OPENAI_CLIENT_REQUIRED",
    stage: "transcription",
  });

  const results = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    invariant(typeof chunk.path === "string" && chunk.path.length > 0, "Audio chunk artifact path is missing", {
      code: "AUDIO_CHUNK_PATH_MISSING",
      stage: "transcription",
      details: { chunkId: chunk.id },
    });
    const raw = await client.transcribeDiarized({
      filePath: chunk.path,
      model,
      language,
      signal,
    });
    results.push({ chunk, raw });
    await onProgress?.({
      stage: "transcription",
      completed: index + 1,
      total: chunks.length,
      chunkId: chunk.id,
    });
  }

  return {
    ...stitchDiarizedChunks(results, { mediaDurationSec }),
    model,
  };
}
