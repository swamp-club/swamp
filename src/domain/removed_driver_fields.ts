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

import type { z } from "zod";

/**
 * User-facing deprecation guard for the removed execution-driver fields.
 *
 * Execution drivers (`driver`/`driverConfig` on workflows, jobs, steps, and
 * definitions, plus `defaultDriver`/`defaultDriverConfig` in `.swamp.yaml`)
 * were replaced by remote execution (see design/enablers/remote-execution.md). Old
 * YAML carrying those fields must fail loudly with an actionable message
 * instead of being silently ignored.
 */

/**
 * Builds the actionable error message for a removed driver field.
 */
export function removedDriverFieldMessage(field: string): string {
  return `The '${field}' field has been removed — execution drivers are ` +
    `replaced by remote execution (see design/enablers/remote-execution.md). ` +
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
  const [field] = removedDriverFieldsIn(data);
  if (field !== undefined) {
    throw new Error(removedDriverFieldMessage(field));
  }
  return data;
}

/**
 * Zod preprocess hook that reports each removed `driver`/`driverConfig`
 * field as a schema issue, so a workflow document that carries one fails
 * like any other schema error instead of throwing (swamp-club#3832).
 */
export function addRemovedDriverFieldIssues(
  data: unknown,
  ctx: z.RefinementCtx,
): unknown {
  for (const field of removedDriverFieldsIn(data)) {
    ctx.addIssue({
      code: "custom",
      message: removedDriverFieldMessage(field),
      path: [field],
      input: data,
    });
  }
  return data;
}

function removedDriverFieldsIn(data: unknown): string[] {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return [];
  }
  return ["driver", "driverConfig"].filter((field) => field in data);
}
