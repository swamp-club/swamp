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
 * split from the read so a caller that authorizes resolves once, authorizes the
 * run's workflow, and hands the read that same reference, never the raw string
 */

import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { PartialMatchResult } from "./run_lookup.ts";
import { isUuid } from "../../domain/models/model_lookup.ts";
import { withSpan } from "../../infrastructure/tracing/mod.ts";

const TRACED_ARGUMENT_MAX_LENGTH = 256;

/** cut to a bounded length, since a remote caller chooses it */
export function tracedArgument(value: string): string {
  return value.length > TRACED_ARGUMENT_MAX_LENGTH
    ? value.slice(0, TRACED_ARGUMENT_MAX_LENGTH)
    : value;
}

/**
 * a workflow carries its latest run, found as it resolves; an ambiguous prefix
 * carries every run it matched, in the order of `ids`, so serve can authorize
 * each one's workflows
 */
export type RunReference =
  | { kind: "run"; run: WorkflowRun }
  | { kind: "workflow"; workflow: Workflow; latest: WorkflowRun | null }
  | { kind: "ambiguous"; ids: string[]; runs: WorkflowRun[] }
  | { kind: "not_found" };

export interface RunReferenceDeps {
  isPartialId: (value: string) => boolean;
  matchRunByPartialId: (idPrefix: string) => Promise<PartialMatchResult>;
  findWorkflow: (idOrName: string) => Promise<Workflow | null>;
  findLatestRun: (workflowId: WorkflowId) => Promise<WorkflowRun | null>;
}

export function resolveRunReference(
  deps: RunReferenceDeps,
  runIdOrWorkflow: string,
): Promise<RunReference> {
  const partial = deps.isPartialId(runIdOrWorkflow);
  return withSpan(
    "swamp.workflow.run_reference.resolve",
    {
      "workflow.id_or_name": tracedArgument(runIdOrWorkflow),
      "workflow.lookup": partial
        ? (isUuid(runIdOrWorkflow) ? "id" : "prefix")
        : "name",
    },
    async (span) => {
      const reference = await lookUp(deps, runIdOrWorkflow, partial);
      span.setAttribute("workflow.lookup.result", reference.kind);
      return reference;
    },
  );
}

async function lookUp(
  deps: RunReferenceDeps,
  runIdOrWorkflow: string,
  partial: boolean,
): Promise<RunReference> {
  if (partial) {
    const result = await deps.matchRunByPartialId(runIdOrWorkflow);
    if (result.status === "found" && result.match) {
      return { kind: "run", run: result.match };
    }
    if (result.status === "ambiguous" && result.matches) {
      return {
        kind: "ambiguous",
        ids: result.matches.map((m) => m.id),
        runs: result.matches.map((m) => m.run),
      };
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
