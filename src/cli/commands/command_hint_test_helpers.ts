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

import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { CommandContext } from "../context.ts";

/** A log-mode command context for rendering tests, with `overrides` applied. */
export function hintTestContext(
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    outputMode: "log",
    forceLog: false,
    verbosity: "normal",
    logger: getSwampLogger(["workflow", "test"]),
    ...overrides,
  };
}

/** Runs `fn` and returns what it wrote to stdout through console.log. */
export function captureStdout(fn: () => void): string[] {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    fn();
    return lines;
  } finally {
    console.log = originalLog;
  }
}
