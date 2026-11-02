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

const DEFAULT_COLUMNS = 80;

/**
 * falls back to 80 columns when stdout is not a TTY or the width is not
 * positive (a pty can report 0 and consoleSize returns it); callers divide by
 * it and String.repeat it, so zero would collapse layout.
 */
export function getTerminalColumns(
  consoleSize: () => { columns: number; rows: number } = () =>
    Deno.consoleSize(),
): number {
  try {
    const { columns } = consoleSize();
    if (columns > 0) return columns;
  } catch {
    // No console attached.
  }
  return DEFAULT_COLUMNS;
}
