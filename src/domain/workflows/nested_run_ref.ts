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

import { z } from "zod";
import { workflowNameBase } from "./workflow.ts";

export const MAX_WORKFLOW_NESTING_DEPTH = 10;

/**
 * ids are UUIDs, so a run record cannot steer a lookup outside the runs
 * directory or match another run's id by substring
 */
export const NestedRunRefSchema = z.object({
  workflowId: z.string().uuid(),
  workflowName: workflowNameBase,
  runId: z.string().uuid(),
});

export type NestedRunRef = z.infer<typeof NestedRunRefSchema>;

export const ParentRunRefSchema = z.object({
  workflowId: z.string().uuid(),
  workflowName: workflowNameBase,
  runId: z.string().uuid(),
  jobName: z.string().min(1),
  stepName: z.string().min(1),
  nestingDepth: z.number().int().min(1).max(MAX_WORKFLOW_NESTING_DEPTH),
  ancestorWorkflowNames: z.array(workflowNameBase),
});

export type ParentRunRef = z.infer<typeof ParentRunRefSchema>;

/**
 * A link as read from a run record. A malformed link is kept as `broken`
 * with its raw value, so the run stays loadable, a save writes the value
 * back unchanged, and nothing ever follows it.
 */
export type RunLink<T> =
  | { readonly kind: "valid"; readonly ref: T }
  | { readonly kind: "broken"; readonly raw: unknown };

function parseLink<T>(schema: z.ZodType<T>, raw: unknown): RunLink<T> {
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { kind: "valid", ref: parsed.data }
    : { kind: "broken", raw };
}

export function parseNestedRunLink(
  raw: unknown,
): RunLink<NestedRunRef> | undefined {
  return raw === undefined ? undefined : parseLink(NestedRunRefSchema, raw);
}

export function parseParentRunLink(
  raw: unknown,
): RunLink<ParentRunRef> | undefined {
  return raw === undefined ? undefined : parseLink(ParentRunRefSchema, raw);
}

export function persistedLink<T>(link: RunLink<T>): unknown {
  return link.kind === "valid" ? structuredClone(link.ref) : link.raw;
}

export function sameRunId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
