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

import { stripAnsiCode } from "@std/fmt/colors";

/**
 * Runs `fn` with console.log captured and returns what it wrote, one string
 * per call, with colors removed.
 */
export async function captureLog(
  fn: () => void | Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) =>
    lines.push(stripAnsiCode(args.map(String).join(" ")));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines;
}
