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

import { assertEquals } from "@std/assert";
import { isPartialId } from "../../domain/models/model_lookup.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { createRunMatcher } from "./run_lookup.ts";
import { resolveRunReference, type RunReferenceDeps } from "./run_reference.ts";

const FLOW = Workflow.create({ name: "my-flow" });

function run(id: string, workflow: Workflow = FLOW): WorkflowRun {
  return WorkflowRun.fromData({ ...WorkflowRun.create(workflow).toData(), id });
}

const RUN_A = run("abd00000-0000-4000-8000-000000000001");
const RUN_B = run("abd11111-0000-4000-8000-000000000001");

/** Deps over in-memory runs and workflows, recording calls. */
function fakeDeps(
  runs: WorkflowRun[],
  workflows: Workflow[],
): RunReferenceDeps & { calls: string[] } {
  const calls: string[] = [];
  const matcher = createRunMatcher({
    findGlobalById: (id) => {
      const hit = runs.find((r) => r.id === id);
      return Promise.resolve(
        hit ? { run: hit, workflowId: hit.workflowId as never } : null,
      );
    },
    findAllGlobal: () =>
      Promise.resolve(
        runs.map((r) => ({ run: r, workflowId: r.workflowId as never })),
      ),
  });
  return {
    calls,
    isPartialId,
    matchRunByPartialId: (prefix) => {
      calls.push(`match:${prefix}`);
      return matcher(prefix);
    },
    findWorkflow: (idOrName) => {
      calls.push(`workflow:${idOrName}`);
      return Promise.resolve(
        workflows.find((w) => w.name === idOrName) ??
          workflows.find((w) => w.id === idOrName) ?? null,
      );
    },
    findLatestRun: (workflowId) => {
      calls.push(`latest:${workflowId}`);
      return Promise.resolve(
        runs.filter((r) => r.workflowId === workflowId).at(-1) ?? null,
      );
    },
  };
}

Deno.test("resolveRunReference: a run id prefix resolves to that run", async () => {
  const deps = fakeDeps([RUN_A, RUN_B], [FLOW]);
  const reference = await resolveRunReference(deps, "abd0");
  assertEquals(reference.kind === "run" && reference.run.id, RUN_A.id);
  assertEquals(deps.calls, ["match:abd0"]);
});

Deno.test("resolveRunReference: a prefix matching several runs is ambiguous, never a workflow", async () => {
  const hexNamed = Workflow.create({ name: "abd" });
  const deps = fakeDeps([RUN_A, RUN_B], [hexNamed]);
  const reference = await resolveRunReference(deps, "abd");
  assertEquals(
    reference.kind === "ambiguous" && reference.ids.sort(),
    [RUN_A.id, RUN_B.id],
  );
  assertEquals(deps.calls, ["match:abd"]);
});

Deno.test("resolveRunReference: a workflow name resolves to the workflow with its latest run", async () => {
  const deps = fakeDeps([RUN_A, RUN_B], [FLOW]);
  const reference = await resolveRunReference(deps, "my-flow");
  assertEquals(reference.kind === "workflow" && reference.workflow, FLOW);
  assertEquals(reference.kind === "workflow" && reference.latest?.id, RUN_B.id);
});

Deno.test("resolveRunReference: a hex workflow name matching no run resolves to the workflow", async () => {
  const hexNamed = Workflow.create({ name: "beef" });
  const deps = fakeDeps([RUN_A], [hexNamed]);
  const reference = await resolveRunReference(deps, "beef");
  assertEquals(reference.kind === "workflow" && reference.workflow, hexNamed);
  assertEquals(reference.kind === "workflow" && reference.latest, null);
});

Deno.test("resolveRunReference: nothing matching is not found", async () => {
  const deps = fakeDeps([RUN_A], [FLOW]);
  assertEquals(await resolveRunReference(deps, "missing"), {
    kind: "not_found",
  });
  assertEquals(await resolveRunReference(deps, "fedcba"), {
    kind: "not_found",
  });
});
