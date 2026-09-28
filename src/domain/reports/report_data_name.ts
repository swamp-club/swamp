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

/**
 * Sanitizes a report name for use as a data name component.
 *
 * Report names use the `@collective/name` scoped pattern, but data names
 * reject `/`, `\`, `..`, and null bytes as path traversal risks.
 * Follows the same pattern as `sanitizeVaultKey` in `data_writer.ts`.
 *
 * Kept in its own dependency-free module: the dashboard derives the same
 * data name to deep-link a report, and its parity test imports this.
 */
export function sanitizeReportNameForData(reportName: string): string {
  return reportName
    .replace(/@/g, "")
    .replace(/[/\\]/g, "-")
    .replace(/\.\./g, ".")
    .replace(/\0/g, "");
}
