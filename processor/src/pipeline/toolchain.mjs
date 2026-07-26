import { runCommand } from "./command-runner.mjs";
import { invariant } from "./errors.mjs";

function parseVersionLine(output, binary) {
  const firstLine = String(output ?? "").split(/\r?\n/, 1)[0].trim();
  invariant(firstLine.toLowerCase().startsWith(`${binary} version`), `${binary} returned an unrecognized version response`, {
    code: "MEDIA_TOOLCHAIN_VERSION_INVALID",
    stage: "toolchain_check",
    details: { binary, firstLine },
  });
  return firstLine;
}

export async function checkMediaToolchain({
  runner = runCommand,
  signal = undefined,
} = {}) {
  const ffmpeg = await runner("ffmpeg", ["-version"], { signal });
  const ffprobe = await runner("ffprobe", ["-version"], { signal });
  return {
    ready: true,
    ffmpeg: parseVersionLine(ffmpeg.stdout, "ffmpeg"),
    ffprobe: parseVersionLine(ffprobe.stdout, "ffprobe"),
    checkedAt: new Date().toISOString(),
  };
}
