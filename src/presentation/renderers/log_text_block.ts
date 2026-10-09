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

import type { Logger } from "@logtape/logtape";
import { escapeLogTemplate } from "../../infrastructure/logging/logger.ts";

export type LogTextLevel = "info" | "warn" | "error";

/**
 * Prints free text one line per log line, verbatim. Interpolated as a value,
 * LogTape would print a multi-line string as a JS string concatenation.
 */
export function logTextBlock(
  logger: Logger,
  level: LogTextLevel,
  text: string,
  indent: string,
): void {
  for (const line of text.replace(/(\r?\n)+$/, "").split(/\r?\n/)) {
    logger[level](escapeLogTemplate(`${indent}${line}`));
  }
}
