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

const DEFAULT_COLUMNS = 80;

/**
 * Returns the current terminal width in columns for non-Ink (log-mode)
 * renderers. Falls back to 80 columns when stdout is not a TTY (piped
 * output, CI, non-interactive environments).
 *
 * For Ink/React components, use the useTerminalSize() hook instead.
 */
export function getTerminalColumns(): number {
  try {
    return Deno.consoleSize().columns;
  } catch {
    return DEFAULT_COLUMNS;
  }
}
