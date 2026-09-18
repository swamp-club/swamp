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
import type { ExpressionContext } from "./model_resolver.ts";

/**
 * Zod v4 z.record() explicitly skips __proto__ keys, silently dropping
 * any binding whose key is "__proto__".  This helper bypasses z.record()
 * and copies keys via Object.defineProperty on a null-prototype object.
 */
function protoSafeRecord<V extends z.ZodTypeAny>(
  valueSchema: V,
): z.ZodType<Record<string, z.infer<V>>> {
  return z.any().superRefine((val: unknown, ctx) => {
    if (typeof val !== "object" || val === null || Array.isArray(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected object",
      });
      return;
    }
    const obj = val as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const result = valueSchema.safeParse(obj[key]);
      if (!result.success) {
        for (const issue of result.error.issues) {
          ctx.addIssue({ ...issue, path: [key, ...(issue.path ?? [])] });
        }
      }
    }
  }).transform((val: Record<string, unknown>) => {
    const safe = Object.create(null) as Record<string, z.infer<V>>;
    for (const key of Object.keys(val)) {
      Object.defineProperty(safe, key, {
        value: val[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return safe;
  }) as unknown as z.ZodType<Record<string, z.infer<V>>>;
}

const record = protoSafeRecord(z.unknown());

/** Only durable bindings cross a workflow boundary; services are rebuilt. */
export const DeferredExpressionSchema = z.object({
  id: z.string().uuid(),
  expression: z.string().regex(/^\$\{\{(?:(?!\}\})[\s\S])+\}\}$/),
  bindings: z.object({
    inputs: record.optional(),
    self: z.object({
      id: z.string(),
      name: z.string(),
      version: z.number(),
      tags: protoSafeRecord(z.string()),
      globalArguments: record,
    }).catchall(z.unknown()).optional(),
    run: z.object({
      id: z.string(),
      workflowId: z.string(),
      workflowName: z.string(),
      startedAt: z.string(),
      tags: protoSafeRecord(z.string()),
      initiatedBy: z.string().optional(),
      inputs: record.optional(),
    }).optional(),
    workflowRunId: z.string().optional(),
    steps: protoSafeRecord(
      z.object({
        status: z.string(),
        outputs: record.optional(),
      }),
    ).optional(),
  }),
});

export type DeferredExpression = z.infer<typeof DeferredExpressionSchema>;

/** Internal reference, distinct from an identical expression authored by a child. */
export function deferredExpressionReference(id: string): string {
  return "${{ __swamp_deferred_" + id.replaceAll("-", "_") + " }}";
}

export function isDeferredExpression(cel: string): boolean {
  return /^__swamp_deferred_[a-f0-9_]+$/.test(cel);
}

/**
 * `omit` names `root.key` binding paths (e.g. `inputs.token`, `self.item`)
 * whose values must not be persisted, such as resume-time inputs and forEach
 * items derived from them. Only two-segment paths are supported.
 */
export function captureDeferredBindings(
  context: ExpressionContext,
  omit: readonly string[] = [],
): DeferredExpression["bindings"] {
  const { inputs, self, run, workflowRunId, steps } = context;
  // Copy at the call boundary: later step results must not change this scope.
  const bindings = JSON.parse(
    JSON.stringify({ inputs, self, run, workflowRunId, steps }),
  ) as Record<string, Record<string, unknown> | undefined>;
  for (const path of omit) {
    const [root, key] = path.split(".");
    delete bindings[root]?.[key];
  }
  return bindings as DeferredExpression["bindings"];
}
