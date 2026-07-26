export class PipelineError extends Error {
  constructor(message, {
    code = "PIPELINE_ERROR",
    stage = "unknown",
    details = undefined,
    cause = undefined,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PipelineError";
    this.code = code;
    this.stage = stage;
    this.details = details;
  }
}

export function invariant(condition, message, options = {}) {
  if (!condition) {
    throw new PipelineError(message, options);
  }
}

export function asPipelineError(error, {
  message = "Pipeline stage failed",
  code = "PIPELINE_STAGE_FAILED",
  stage = "unknown",
  details = undefined,
} = {}) {
  if (error instanceof PipelineError) {
    return error;
  }

  return new PipelineError(message, {
    code,
    stage,
    details,
    cause: error,
  });
}
