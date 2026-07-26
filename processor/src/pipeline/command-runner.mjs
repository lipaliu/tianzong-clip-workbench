import { spawn } from "node:child_process";
import { PipelineError, invariant } from "./errors.mjs";

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export async function runCommand(command, args, {
  cwd = undefined,
  env = process.env,
  signal = undefined,
  timeoutMs = 10 * 60 * 1000,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  invariant(typeof command === "string" && command.length > 0, "Command is required", {
    code: "COMMAND_REQUIRED",
    stage: "command",
  });
  invariant(Array.isArray(args) && args.every((arg) => typeof arg === "string"), "Command arguments must be strings", {
    code: "INVALID_COMMAND_ARGS",
    stage: "command",
  });

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const appendBounded = (current, chunk, streamName) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > maxOutputBytes) {
        child.kill("SIGKILL");
        finishReject(new PipelineError(`${command} ${streamName} exceeded the output limit`, {
          code: "COMMAND_OUTPUT_LIMIT",
          stage: "command",
          details: { command, streamName, maxOutputBytes },
        }));
        return current;
      }
      return next;
    };

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk, "stderr");
    });

    child.on("error", (error) => {
      finishReject(new PipelineError(`Unable to start ${command}`, {
        code: "COMMAND_START_FAILED",
        stage: "command",
        details: { command, args },
        cause: error,
      }));
    });

    child.on("close", (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        command,
        args,
        exitCode,
        signal: exitSignal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      };

      if (exitCode !== 0) {
        reject(new PipelineError(`${command} exited with code ${exitCode ?? "unknown"}`, {
          code: "COMMAND_FAILED",
          stage: "command",
          details: result,
        }));
        return;
      }
      resolve(result);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finishReject(new PipelineError(`${command} timed out`, {
        code: "COMMAND_TIMEOUT",
        stage: "command",
        details: { command, args, timeoutMs },
      }));
    }, timeoutMs);
    timer.unref?.();
  });
}
