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
 * User-facing deprecation guard for the removed execution-driver fields.
 *
 * Execution drivers (`driver`/`driverConfig` on workflows, jobs, steps, and
 * definitions, plus `defaultDriver`/`defaultDriverConfig` in `.swamp.yaml`)
 * were replaced by remote execution (see design/remote-execution.md). Old
 * YAML carrying those fields must fail loudly with an actionable message
 * instead of being silently ignored.
 */

/**
 * Builds the actionable error message for a removed driver field.
 */
export function removedDriverFieldMessage(field: string): string {
  return `The '${field}' field has been removed — execution drivers are ` +
    `replaced by remote execution (see design/remote-execution.md). ` +
    `Remove the field; for isolation, run a containerized worker and use ` +
    `step 'labels' placement.`;
}

/**
 * Zod preprocess hook that rejects objects still carrying the removed
 * `driver`/`driverConfig` fields. Wrap an object schema with
 * `z.preprocess(rejectRemovedDriverFields, schema)` so old YAML fails with
 * an actionable error before unknown-key stripping silently drops it.
 */
export function rejectRemovedDriverFields(data: unknown): unknown {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    for (const field of ["driver", "driverConfig"]) {
      if (field in data) {
        throw new Error(removedDriverFieldMessage(field));
      }
    }
  }
  return data;
}
