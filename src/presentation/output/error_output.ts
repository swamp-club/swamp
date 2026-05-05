// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { ValidationError } from "@cliffy/command";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import type { OutputMode } from "./output.ts";

const logger = getSwampLogger(["error"]);

/**
 * Builds the JSON error object for structured output.
 *
 * Shape: `{ error: string, stack?: string, code?: string }`. The `code`
 * field is set when the underlying error carries a machine-readable
 * identifier (e.g. `UserError.code` or any error object exposing a
 * string `code` property — `SwampError`-like). Both `code` and `stack`
 * are optional; consumers must tolerate their presence or absence.
 */
export function buildErrorJson(err: Error): Record<string, string> {
  const data: Record<string, string> = { error: err.message };
  if (
    !(err instanceof UserError) && !(err instanceof ValidationError) &&
    err.stack
  ) {
    const stackLines = err.stack.split("\n").filter((line) =>
      line.trim().startsWith("at ")
    );
    if (stackLines.length > 0) {
      data.stack = stackLines.join("\n");
    }
  }
  const maybeCode = (err as { code?: unknown }).code;
  if (typeof maybeCode === "string" && maybeCode.length > 0) {
    data.code = maybeCode;
  }
  return data;
}

/**
 * Renders an error to the user.
 *
 * In JSON mode this is the SINGLE emitter for fatal output: it writes
 * the JSON error to stdout and does NOT call `logger.fatal`, so log-mode
 * sinks never produce a duplicate FTL line. In log mode it falls
 * through to LogTape — UserError / Cliffy ValidationError emit just the
 * message; other errors emit the full Error (stack trace included).
 */
export function renderError(error: unknown, outputMode?: OutputMode): void {
  const err = error instanceof Error ? error : new Error(String(error));

  if (outputMode === "json") {
    // deno-lint-ignore no-console
    console.log(JSON.stringify(buildErrorJson(err), null, 2));
    return;
  }

  if (err instanceof UserError || err instanceof ValidationError) {
    logger.fatal("Error: {message}", { message: err.message });
  } else {
    logger.fatal("{error}", { error: err });
  }
}
