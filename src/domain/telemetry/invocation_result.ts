// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { errorPaths } from "../errors.ts";
import { isPathLike, redactErrorMessage } from "./error_message_redaction.ts";

export type InvocationStatus = "success" | "error" | "user_error";

export interface InvocationResult {
  readonly status: InvocationStatus;
  readonly errorType?: string;
  readonly errorMessage?: string;
  readonly exitCode: number;
}

export interface InvocationResultData {
  status: InvocationStatus;
  errorType?: string;
  errorMessage?: string;
  exitCode: number;
}

export function createSuccessResult(): InvocationResult {
  return {
    status: "success",
    exitCode: 0,
  };
}

/**
 * paths the error marked with markErrorPaths are removed exactly alongside
 * knownValues, so a path the patterns cannot delimit is still replaced whole
 */
export function createErrorResult(
  error: Error,
  isUserError: boolean = false,
  knownValues: readonly string[] = [],
): InvocationResult {
  const firstLine = error.message.split("\n")[0];

  return {
    status: isUserError ? "user_error" : "error",
    errorType: error.constructor.name,
    errorMessage: redactErrorMessage(firstLine, [
      ...knownValues,
      // A marked value that is not path-like would be removed as a whole
      // word wherever it appears, which costs diagnostics and protects
      // nothing, so it is left to the patterns.
      ...errorPaths(error).filter(isPathLike),
    ]),
    exitCode: 1,
  };
}

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
