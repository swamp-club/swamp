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

/**
 * Lightweight read-model (query projection) of a workflow run.
 *
 * A `WorkflowRunSummary` is the *listing* view of a run — identity, workflow,
 * status, timing, tags, and inputs — distinct from the full {@link WorkflowRun}
 * aggregate. Run-listing/search paths render only these fields, so they must
 * NOT reconstruct the aggregate: each persisted run YAML carries the full
 * `jobs[] -> steps[] -> output` tree, and step outputs are unbounded arbitrary
 * data. Hydrating every run into a full aggregate just to show a summary row
 * makes peak memory scale with total on-disk run size, which OOMs on workflows
 * with a large accumulated history. This projection keeps only the displayed
 * fields and never retains the heavy subtrees.
 */
export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  startedAt?: Date;
  completedAt?: Date;
  tags: Record<string, string>;
  inputs: Record<string, unknown>;
}

/**
 * Zod schema for the projection. It intentionally declares ONLY the summary
 * fields — the heavy `jobs`/`steps`/`output`/`dataArtifacts` subtrees are left
 * out entirely so they are stripped from the result and never validated.
 *
 * Field constraints are deliberately lenient (looser than `WorkflowRunSchema`):
 * `status` is a bare string rather than the run-status enum, and identity
 * fields are not UUID-validated. A summary read must succeed for any run record
 * that has the displayed fields, even one whose heavy subtree would fail
 * full-aggregate validation — the listing should never be blocked by an
 * unrelated malformed field the summary never looks at.
 */
const WorkflowRunSummarySchema = z.object({
  id: z.string().min(1),
  workflowId: z.string().min(1),
  workflowName: z.string().min(1),
  status: z.string().min(1),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  tags: z.record(z.string(), z.string()).default({}),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Projects raw persisted run data onto a {@link WorkflowRunSummary}.
 *
 * This is the memory-safe read path: it never calls `WorkflowRun.fromData` and
 * never touches the heavy `jobs`/`output` subtrees, so the caller can parse a
 * run file, extract the summary, and let the full parsed tree be garbage
 * collected before moving to the next file.
 *
 * Critically, the retained string fields are *detached* from the parsed source
 * via a JSON round-trip. A YAML/JSON parser returns scalar strings as V8
 * sliced strings that keep a reference to the entire source buffer — so
 * holding a run's tiny `id` would pin its whole (largely `jobs`) file in
 * memory, and holding thousands of them reproduces the very OOM this projection
 * exists to prevent. Round-tripping reallocates each string fresh, dropping the
 * backing buffer. `startedAt`/`completedAt` become `Date`s (which store a
 * number, not the source string) so they need no detaching.
 */
export function parseWorkflowRunSummary(data: unknown): WorkflowRunSummary {
  const v = WorkflowRunSummarySchema.parse(data);
  const detached = JSON.parse(
    JSON.stringify({
      id: v.id,
      workflowId: v.workflowId,
      workflowName: v.workflowName,
      status: v.status,
      tags: v.tags,
      inputs: v.inputs,
    }),
  ) as {
    id: string;
    workflowId: string;
    workflowName: string;
    status: string;
    tags: Record<string, string>;
    inputs: Record<string, unknown>;
  };
  return {
    id: detached.id,
    workflowId: detached.workflowId,
    workflowName: detached.workflowName,
    status: detached.status,
    startedAt: v.startedAt ? new Date(v.startedAt) : undefined,
    completedAt: v.completedAt ? new Date(v.completedAt) : undefined,
    tags: detached.tags,
    inputs: detached.inputs,
  };
}
