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
 * Zod strips unknown keys silently, so a typo'd key would pass and its field be
 * ignored; runs in a z.preprocess so the raw keys are seen before stripping
 */

import type { z } from "zod";
import { findClosestMatch } from "../string_distance.ts";

export type WorkflowEntity = "workflow" | "job" | "step";

/**
 * owned by addRemovedDriverFieldIssues, which runs first and gives its own
 * migration message
 */
const REMOVED_DRIVER_FIELDS = ["driver", "driverConfig"];

export function unknownKeyMessage(
  field: string,
  entity: WorkflowEntity,
  entityName: string | undefined,
  knownKeys: readonly string[],
): string {
  const where = entityName ? `${entity} '${entityName}'` : `${entity}`;
  const suggestion = findClosestMatch(field, [...knownKeys]);
  const didYouMean = suggestion ? ` Did you mean '${suggestion}'?` : "";
  return `Unknown key '${field}' on ${where}.${didYouMean} ` +
    `Valid ${entity} keys: ${knownKeys.join(", ")}`;
}

/**
 * chain after addRemovedDriverFieldIssues so driver and driverConfig keep their
 * specific migration message; issues fail like any schema error instead of
 * throwing
 */
export function rejectUnknownKeys(
  entity: WorkflowEntity,
  knownKeys: readonly string[],
): (data: unknown, ctx: z.RefinementCtx) => unknown {
  const known = new Set(knownKeys);
  return (data: unknown, ctx: z.RefinementCtx): unknown => {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return data;
    }
    const record = data as Record<string, unknown>;
    const entityName = typeof record.name === "string"
      ? record.name
      : undefined;
    for (const field of Object.keys(record)) {
      if (known.has(field) || REMOVED_DRIVER_FIELDS.includes(field)) {
        continue;
      }
      ctx.addIssue({
        code: "custom",
        message: unknownKeyMessage(field, entity, entityName, knownKeys),
        path: [field],
        input: data,
      });
    }
    return data;
  };
}
