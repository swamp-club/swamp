/**
 * Status of a command invocation.
 */
export type InvocationStatus = "success" | "error" | "user_error";

/**
 * Represents the result of a CLI command execution.
 */
export interface InvocationResult {
  /** Whether the command succeeded or failed */
  readonly status: InvocationStatus;
  /** Error class name if an error occurred */
  readonly errorType?: string;
  /** First line of error message (sanitized) */
  readonly errorMessage?: string;
  /** Exit code of the command */
  readonly exitCode: number;
}

/**
 * Data transfer object for InvocationResult.
 */
export interface InvocationResultData {
  status: InvocationStatus;
  errorType?: string;
  errorMessage?: string;
  exitCode: number;
}

/**
 * Creates a successful InvocationResult.
 */
export function createSuccessResult(): InvocationResult {
  return {
    status: "success",
    exitCode: 0,
  };
}

/**
 * Creates an error InvocationResult from an Error.
 */
export function createErrorResult(
  error: Error,
  isUserError: boolean = false,
): InvocationResult {
  // Get first line of error message only (sanitize)
  const firstLine = error.message.split("\n")[0];

  return {
    status: isUserError ? "user_error" : "error",
    errorType: error.constructor.name,
    errorMessage: firstLine,
    exitCode: 1,
  };
}

/**
 * Converts an InvocationResult to its data representation.
 */
export function invocationResultToData(
  result: InvocationResult,
): InvocationResultData {
  const data: InvocationResultData = {
    status: result.status,
    exitCode: result.exitCode,
  };
  if (result.errorType) {
    data.errorType = result.errorType;
  }
  if (result.errorMessage) {
    data.errorMessage = result.errorMessage;
  }
  return data;
}

/**
 * Creates an InvocationResult from data.
 */
export function invocationResultFromData(
  data: InvocationResultData,
): InvocationResult {
  return {
    status: data.status,
    errorType: data.errorType,
    errorMessage: data.errorMessage,
    exitCode: data.exitCode,
  };
}
