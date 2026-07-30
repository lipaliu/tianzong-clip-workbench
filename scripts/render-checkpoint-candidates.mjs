#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    values.set(key.slice(2), value);
  }
  for (const required of ["source", "candidates", "transcript", "output"]) {
    if (!values.has(required)) {
      throw new Error(`Missing --${required}`);
    }
  }
  return {
    source: values.get("source"),
    candidates: values.get("candidates"),
    transcript: values.get("transcript"),
    output: values.get("output"),
    speaker: values.get("speaker") ?? "speaker_2",
    concurrency: Math.max(1, Number.parseInt(values.get("concurrency") ?? "2", 10)),
  };
}

function rounded(value) {
  return Math.round(value * 1_000) / 1_000;
}

function overlaps(segment, start, end) {
  return segment.endSec > start && segment.startSec < end;
}

function containsOtherSpeaker(transcript, speaker, start, end) {
  return transcript.some(
    (segment) =>
      segment.speaker !== speaker
      && overlaps(segment, start, end)
      && Math.min(segment.endSec, end) - Math.max(segment.startSec, start) > 0.08,
  );
}

function buildIntervals(candidate, transcript, speaker, mediaDurationSec) {
  const recall = candidate.recallWindow;
  const tianzongSegments = transcript.filter(
    (segment) =>
      segment.speaker === speaker
      && overlaps(segment, recall.startSec - 0.15, recall.endSec + 0.15),
  );
  const first = tianzongSegments[0]
    ?? transcript.find(
      (segment) =>
        segment.speaker === speaker
        && segment.startSec >= recall.startSec
        && segment.startSec < recall.endSec + 8,
    );
  if (!first) return [];

  const recalledDuration = recall.endSec - recall.startSec;
  let targetEnd = recall.endSec;
  if (recalledDuration < 45) {
    targetEnd = Math.max(targetEnd, first.startSec + 50);
  } else if (recalledDuration <= 75) {
    targetEnd = Math.min(first.startSec + 75, targetEnd + 5);
  }
  targetEnd = Math.min(mediaDurationSec, targetEnd);

  const selected = transcript.filter(
    (segment) =>
      segment.speaker === speaker
      && segment.endSec > first.startSec - 0.15
      && segment.startSec < targetEnd + 0.15,
  );
  if (!selected.length) return [];

  const intervals = [];
  for (const segment of selected) {
    const start = Math.max(0, segment.startSec - 0.08);
    const end = Math.min(mediaDurationSec, segment.endSec + 0.15);
    const previous = intervals.at(-1);
    const canMerge = previous
      && start - previous.end <= 0.9
      && !containsOtherSpeaker(transcript, speaker, previous.end, start);
    if (canMerge) {
      previous.end = end;
      previous.text.push(segment.text);
    } else {
      intervals.push({ start, end, text: [segment.text] });
    }
  }
  return intervals;
}

function ffmpegArguments(source, intervals, outputPath) {
  const inputStart = Math.max(0, intervals[0].start - 0.25);
  const inputEnd = intervals.at(-1).end;
  const filter = [];
  const concatInputs = [];
  intervals.forEach((interval, index) => {
    const localStart = rounded(interval.start - inputStart);
    const localEnd = rounded(interval.end - inputStart);
    filter.push(
      `[0:v]trim=start=${localStart}:end=${localEnd},`
      + `setpts=PTS-STARTPTS[v${index}]`,
    );
    filter.push(
      `[0:a]atrim=start=${localStart}:end=${localEnd},`
      + `asetpts=PTS-STARTPTS[a${index}]`,
    );
    concatInputs.push(`[v${index}][a${index}]`);
  });
  filter.push(
    `${concatInputs.join("")}concat=n=${intervals.length}:v=1:a=1[vcat][aout]`,
  );
  filter.push("[vcat]scale=-2:min(1280\\,ih)[vout]");
  return [
    "-v",
    "error",
    "-ss",
    String(inputStart),
    "-i",
    source,
    "-t",
    String(inputEnd - inputStart),
    "-filter_complex",
    filter.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "25",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ];
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;
}

const input = parseArguments(process.argv.slice(2));
const [candidateDocument, transcriptDocument] = await Promise.all([
  readFile(input.candidates, "utf8").then(JSON.parse),
  readFile(input.transcript, "utf8").then(JSON.parse),
]);
await mkdir(input.output, { recursive: true });

const transcript = transcriptDocument.segments
  .filter(
    (segment) =>
      Number.isFinite(segment.startSec)
      && Number.isFinite(segment.endSec)
      && segment.endSec > segment.startSec,
  )
  .sort((left, right) => left.startSec - right.startSec);
const jobs = candidateDocument.candidates.map((candidate, index) => {
  const intervals = buildIntervals(
    candidate,
    transcript,
    input.speaker,
    transcriptDocument.mediaDurationSec,
  );
  const provider = candidate.editorProvider ?? "unknown";
  const fileName =
    `${String(index + 1).padStart(2, "0")}_${provider}_${candidate.candidateId}.mp4`;
  return {
    index: index + 1,
    candidateId: candidate.candidateId,
    provider,
    title: candidate.title,
    score: candidate.score?.total ?? null,
    originalRecallStart: candidate.recallWindow.startSec,
    originalRecallEnd: candidate.recallWindow.endSec,
    roughCutStart: intervals[0]?.start ?? null,
    roughCutEnd: intervals.at(-1)?.end ?? null,
    roughCutDuration: rounded(
      intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0),
    ),
    removedOtherSpeaker: true,
    tianzongSpeaker: input.speaker,
    intervals: intervals.map((interval) => ({
      start: rounded(interval.start),
      end: rounded(interval.end),
      transcript: interval.text.join(""),
    })),
    fileName,
    outputPath: join(input.output, fileName),
  };
});

let nextIndex = 0;
let completed = 0;
const renderNext = async () => {
  while (true) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= jobs.length) return;
    const job = jobs[index];
    if (!job.intervals.length) {
      throw new Error(`No Tianzong speech found for ${job.candidateId}`);
    }
    await runFfmpeg(ffmpegArguments(input.source, job.intervals, job.outputPath));
    completed += 1;
    process.stdout.write(
      `${completed}/${jobs.length} ${job.candidateId} `
      + `${job.roughCutDuration}s ${basename(job.outputPath)}\n`,
    );
  }
};
await Promise.all(
  Array.from(
    { length: Math.min(input.concurrency, jobs.length) },
    () => renderNext(),
  ),
);

const manifest = {
  generatedAt: new Date().toISOString(),
  source: input.source,
  candidateCount: jobs.length,
  deliveryStatus: "bulk_rough_cut_pending_human_review",
  rules: [
    "Only Tianzong speaker spans are retained.",
    "The opening is moved to Tianzong's first complete sentence.",
    "Short recall windows are right-expanded for rough-cut review.",
    "Another speaker's long interjections are removed.",
    "Every output remains a rough candidate and must be reviewed at normal speed.",
  ],
  candidates: jobs.map((job) => {
    const candidate = { ...job };
    delete candidate.outputPath;
    return candidate;
  }),
};
await writeFile(
  join(input.output, "候选清单.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
const header = [
  "序号",
  "模型",
  "候选ID",
  "标题",
  "评分",
  "粗剪时长秒",
  "文件名",
];
const rows = jobs.map((job) => [
  job.index,
  job.provider,
  job.candidateId,
  job.title,
  job.score,
  job.roughCutDuration,
  job.fileName,
]);
await writeFile(
  join(input.output, "候选清单.csv"),
  `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`,
);
