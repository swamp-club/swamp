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
 * Resolves the argument of a workflow history read — a run id prefix, a
 * workflow name or a workflow id — to the run the read acts on
 * (swamp-club#2673).
 *
 * The lookup is split from the read so a caller that authorizes can resolve
 * once, authorize the run's workflow, and hand the read that same
 * reference: the read then acts on exactly what was authorized, never on a
 * second lookup of the raw string.
 */

import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { PartialMatchResult } from "./run_lookup.ts";

/**
 * What a run-or-workflow argument names. A workflow carries its latest run,
 * found as it resolves, so the read never looks one up afterwards.
 */
export type RunReference =
  | { kind: "run"; run: WorkflowRun }
  | { kind: "workflow"; workflow: Workflow; latest: WorkflowRun | null }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "not_found" };

/** Lookups a run-or-workflow argument resolves through. */
export interface RunReferenceDeps {
  isPartialId: (value: string) => boolean;
  matchRunByPartialId: (idPrefix: string) => Promise<PartialMatchResult>;
  findWorkflow: (idOrName: string) => Promise<Workflow | null>;
  findLatestRun: (workflowId: WorkflowId) => Promise<WorkflowRun | null>;
}

/**
 * Resolves a run-or-workflow argument: a 3+ hex-character string is first
 * matched as a run id prefix across every workflow; failing that, the
 * argument names a workflow, and the read takes its latest run.
 */
export async function resolveRunReference(
  deps: RunReferenceDeps,
  runIdOrWorkflow: string,
): Promise<RunReference> {
  if (deps.isPartialId(runIdOrWorkflow)) {
    const result = await deps.matchRunByPartialId(runIdOrWorkflow);
    if (result.status === "found" && result.match) {
      return { kind: "run", run: result.match };
    }
    if (result.status === "ambiguous" && result.matches) {
      return { kind: "ambiguous", ids: result.matches.map((m) => m.id) };
    }
  }
  const workflow = await deps.findWorkflow(runIdOrWorkflow);
  if (!workflow) return { kind: "not_found" };
  return {
    kind: "workflow",
    workflow,
    latest: await deps.findLatestRun(workflow.id),
  };
}
