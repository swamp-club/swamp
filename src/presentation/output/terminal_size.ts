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
 * Returns the current terminal width in columns for non-Ink (log-mode)
 * renderers. Falls back to 80 columns when stdout is not a TTY (piped
 * output, CI, non-interactive environments), and when the console reports a
 * non-positive width: a pty can report `0` columns — `script` with no
 * attached window does, as do some CI runners — and `Deno.consoleSize()`
 * returns that zero rather than throwing. Callers divide by this value and
 * pass it to `String.repeat`, so a zero would silently collapse their layout.
 *
 * `consoleSize` is injectable so both branches can be selected explicitly
 * rather than by whether the process happens to have a console attached.
 *
 * For Ink/React components, use the useTerminalSize() hook instead.
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
