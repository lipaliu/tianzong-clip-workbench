export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly expose: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: {
      expose?: boolean;
      cause?: unknown;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.expose = options.expose ?? statusCode < 500;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function publicError(error: unknown): {
  statusCode: number;
  body: { error: { code: string; message: string } };
} {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      body: {
        error: {
          code: error.code,
          message: error.expose ? error.message : "处理失败，请稍后重试。",
        },
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      error: {
        code: "internal_error",
        message: "处理失败，请稍后重试。",
      },
    },
  };
}

export function internalErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `; cause=${error.cause.message}` : "";
    return `${error.name}: ${error.message}${cause}`.slice(0, 8_000);
  }
  return String(error).slice(0, 8_000);
}
