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
 * Format: { error: string, stack?: string }
 * Matches the format used by createJsonErrorSink in the logging layer.
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
  return data;
}

/**
 * Renders an error via LogTape at fatal level.
 * UserError instances and Cliffy ValidationErrors log just the message (no stack trace).
 * Other errors log the full Error object (including stack trace via Deno.inspect).
 *
 * In JSON mode, also writes the error as JSON to stdout so pipe consumers
 * (jq, AI agents) see the failure instead of receiving empty stdout.
 */
export function renderError(error: unknown, outputMode?: OutputMode): void {
  const err = error instanceof Error ? error : new Error(String(error));

  if (outputMode === "json") {
    // deno-lint-ignore no-console
    console.log(JSON.stringify(buildErrorJson(err), null, 2));
  }

  if (err instanceof UserError || err instanceof ValidationError) {
    logger.fatal("Error: {message}", { message: err.message });
  } else {
    logger.fatal("{error}", { error: err });
  }
}
