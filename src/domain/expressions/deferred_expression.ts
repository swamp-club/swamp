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

const record = z.record(z.string(), z.unknown());

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
      tags: z.record(z.string(), z.string()),
      globalArguments: record,
    }).catchall(z.unknown()).optional(),
    run: z.object({
      id: z.string(),
      workflowId: z.string(),
      workflowName: z.string(),
      startedAt: z.string(),
      tags: z.record(z.string(), z.string()),
      initiatedBy: z.string().optional(),
      inputs: record.optional(),
    }).optional(),
    workflowRunId: z.string().optional(),
    steps: z.record(
      z.string(),
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

export function captureDeferredBindings(
  context: ExpressionContext,
): DeferredExpression["bindings"] {
  const { inputs, self, run, workflowRunId, steps } = context;
  // Copy at the call boundary: later step results must not change this scope.
  return JSON.parse(
    JSON.stringify({ inputs, self, run, workflowRunId, steps }),
  );
}
