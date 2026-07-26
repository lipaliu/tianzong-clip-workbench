import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { AppError } from "./errors.js";

export type MediaProbe = {
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
  hasAudio: boolean;
};

export type ExtractedFrame = {
  path: string;
  timestamp: number;
};

async function run(
  command: string,
  args: string[],
  options: { capture?: boolean } = {},
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${String(code)}: ${stderr}`));
    });
  });
}

function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator = "1"] = value.split("/");
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) ? rate : 0;
}

export async function probeMedia(path: string): Promise<MediaProbe> {
  const output = await run(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration:stream=index,codec_type,width,height,avg_frame_rate",
      "-of", "json",
      path,
    ],
    { capture: true },
  );
  const parsed = JSON.parse(output) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
    }>;
  };
  const durationSeconds = Number(parsed.format?.duration);
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !video) {
    throw new AppError(422, "media_invalid", "原片不是可读取的有效视频。");
  }
  const hasAudio = parsed.streams?.some((stream) => stream.codec_type === "audio") ?? false;
  if (!hasAudio) {
    throw new AppError(422, "media_audio_missing", "原片没有可转写的音轨。");
  }
  return {
    durationSeconds,
    width: video.width ?? 0,
    height: video.height ?? 0,
    frameRate: parseFrameRate(video.avg_frame_rate),
    hasAudio,
  };
}

export async function hashAndSize(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const details = await stat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", resolve);
  });
  return { sha256: hash.digest("hex"), sizeBytes: details.size };
}

export async function splitAudio(
  sourcePath: string,
  directory: string,
  segmentSeconds: number,
): Promise<Array<{ path: string; offsetSeconds: number }>> {
  await mkdir(directory, { recursive: true });
  const pattern = join(directory, "audio-%05d.mp3");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", sourcePath,
    "-map", "0:a:0",
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "48k",
    "-f", "segment",
    "-segment_time", String(segmentSeconds),
    "-reset_timestamps", "1",
    pattern,
  ]);
  const files = (await readdir(directory))
    .filter((name) => /^audio-\d{5}\.mp3$/.test(name))
    .sort();
  if (!files.length) throw new AppError(422, "audio_extract_failed", "无法提取原片音轨。");
  return files.map((name, index) => ({
    path: join(directory, name),
    offsetSeconds: index * segmentSeconds,
  }));
}

export async function extractFrames(
  sourcePath: string,
  directory: string,
  intervalSeconds: number,
  options: { start?: number; end?: number; maxFrames?: number } = {},
): Promise<ExtractedFrame[]> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (options.start !== undefined) args.push("-ss", String(options.start));
  args.push("-i", sourcePath);
  if (options.end !== undefined && options.start !== undefined) {
    args.push("-t", String(Math.max(options.end - options.start, 0.1)));
  }
  args.push(
    "-vf",
    `fps=1/${intervalSeconds},scale='min(768,iw)':-2`,
    "-q:v",
    "5",
    join(directory, "frame-%05d.jpg"),
  );
  await run("ffmpeg", args);
  const files = (await readdir(directory))
    .filter((name) => /^frame-\d{5}\.jpg$/.test(name))
    .sort();
  const frames = files.map((name, index) => ({
    path: join(directory, name),
    timestamp: (options.start ?? 0) + index * intervalSeconds,
  }));
  const maxFrames = options.maxFrames;
  if (!maxFrames || frames.length <= maxFrames) return frames;
  if (maxFrames === 1) return [frames[0]!];
  const selected: ExtractedFrame[] = [];
  for (let index = 0; index < maxFrames; index += 1) {
    const frameIndex = Math.round((index * (frames.length - 1)) / (maxFrames - 1));
    selected.push(frames[frameIndex]!);
  }
  return selected;
}

export async function renderPreview(
  sourcePath: string,
  outputPath: string,
  start: number,
  end: number,
): Promise<void> {
  await mkdir(join(outputPath, ".."), { recursive: true });
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(start),
    "-i", sourcePath,
    "-t", String(Math.max(end - start, 0.2)),
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "24",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath,
  ]);
}

export function safeWorkName(value: string): string {
  return basename(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(-180);
}
