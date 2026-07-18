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
 * User-facing authoring guard that rejects unknown keys on workflow, job,
 * and step objects.
 *
 * Zod strips unknown keys silently by default, which turns authoring
 * mistakes into fail-open behavior: a `labels:` block placed on a job
 * instead of a step passes validation and the placement intent is
 * discarded, so the work runs on the orchestrator (swamp-club#1240).
 * Like removed_driver_fields.ts, this hook runs in a `z.preprocess`
 * wrapper so the raw keys are seen before unknown-key stripping drops
 * them.
 */

import { findClosestMatch } from "../string_distance.ts";

/** Entities whose schemas reject unknown keys. */
export type WorkflowEntity = "workflow" | "job" | "step";

/**
 * Step-level remote-placement properties (see design/remote-execution.md).
 * Misplacing these on a job or workflow is the dangerous authoring mistake:
 * the placement intent is silently dropped and the step runs locally.
 */
const STEP_PLACEMENT_KEYS = ["labels", "target", "platform", "queueTimeout"];

/**
 * Fields owned by rejectRemovedDriverFields, which runs before this hook
 * and produces its own migration message.
 */
const REMOVED_DRIVER_FIELDS = ["driver", "driverConfig"];

/**
 * Builds the error message for a step placement property found on a
 * workflow or job.
 */
export function misplacedPlacementKeyMessage(
  field: string,
  entity: WorkflowEntity,
  entityName: string | undefined,
): string {
  const where = entityName ? `${entity} '${entityName}'` : `a ${entity}`;
  return `'${field}' is a step property, not a ${entity} property — ` +
    `remote placement is declared per step (see design/remote-execution.md). ` +
    `The key was found on ${where}.\n\n` +
    `Move it onto the step:\n` +
    `  steps:\n` +
    `    - name: <step-name>\n` +
    `      ${field}: ...\n` +
    `      task:\n` +
    `        ...`;
}

/**
 * Builds the error message for an unknown key, with a did-you-mean
 * suggestion when a known key is close enough.
 */
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
 * Creates a Zod preprocess hook that rejects unknown keys on a workflow,
 * job, or step object with an actionable error. Chain it after
 * rejectRemovedDriverFields so `driver`/`driverConfig` keep their specific
 * migration message:
 * `z.preprocess(rejectRemovedDriverFields, z.preprocess(rejectUnknownKeys(...), schema))`.
 */
export function rejectUnknownKeys(
  entity: WorkflowEntity,
  knownKeys: readonly string[],
): (data: unknown) => unknown {
  const known = new Set(knownKeys);
  return (data: unknown): unknown => {
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
      if (entity !== "step" && STEP_PLACEMENT_KEYS.includes(field)) {
        throw new Error(
          misplacedPlacementKeyMessage(field, entity, entityName),
        );
      }
      throw new Error(unknownKeyMessage(field, entity, entityName, knownKeys));
    }
    return data;
  };
}
