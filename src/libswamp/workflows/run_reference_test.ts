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
import {
  resolveRunReference,
  type RunReferenceDeps,
  tracedArgument,
} from "./run_reference.ts";
import {
  findSpan,
  withCapturedSpans,
} from "../../infrastructure/tracing/span_test_helpers.ts";

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

const RESOLVE_SPAN = "swamp.workflow.run_reference.resolve";

Deno.test("resolveRunReference: a full run id is traced as an id lookup that found a run", async () => {
  const deps = fakeDeps([RUN_A, RUN_B], [FLOW]);
  await withCapturedSpans(async (spans) => {
    const reference = await resolveRunReference(deps, RUN_A.id);
    assertEquals(reference.kind === "run" && reference.run.id, RUN_A.id);
    const span = findSpan(spans, RESOLVE_SPAN);
    assertEquals(span.attributes["workflow.id_or_name"], RUN_A.id);
    assertEquals(span.attributes["workflow.lookup"], "id");
    assertEquals(span.attributes["workflow.lookup.result"], "run");
  });
});

Deno.test("resolveRunReference: a run id prefix is traced as a prefix lookup that found a run", async () => {
  const deps = fakeDeps([RUN_A, RUN_B], [FLOW]);
  await withCapturedSpans(async (spans) => {
    const reference = await resolveRunReference(deps, "abd0");
    assertEquals(reference.kind === "run" && reference.run.id, RUN_A.id);
    const span = findSpan(spans, RESOLVE_SPAN);
    assertEquals(span.attributes["workflow.id_or_name"], "abd0");
    assertEquals(span.attributes["workflow.lookup"], "prefix");
    assertEquals(span.attributes["workflow.lookup.result"], "run");
  });
});

Deno.test("resolveRunReference: an ambiguous prefix is traced with an ambiguous result", async () => {
  const deps = fakeDeps([RUN_A, RUN_B], [FLOW]);
  await withCapturedSpans(async (spans) => {
    const reference = await resolveRunReference(deps, "abd");
    assertEquals(
      reference.kind === "ambiguous" && reference.ids.sort(),
      [RUN_A.id, RUN_B.id],
    );
    const span = findSpan(spans, RESOLVE_SPAN);
    assertEquals(span.attributes["workflow.lookup"], "prefix");
    assertEquals(span.attributes["workflow.lookup.result"], "ambiguous");
  });
});

Deno.test("resolveRunReference: a workflow name is traced as a name lookup that found a workflow", async () => {
  const deps = fakeDeps([RUN_A, RUN_B], [FLOW]);
  await withCapturedSpans(async (spans) => {
    const reference = await resolveRunReference(deps, "my-flow");
    assertEquals(reference.kind === "workflow" && reference.workflow, FLOW);
    assertEquals(
      reference.kind === "workflow" && reference.latest?.id,
      RUN_B.id,
    );
    const span = findSpan(spans, RESOLVE_SPAN);
    assertEquals(span.attributes["workflow.id_or_name"], "my-flow");
    assertEquals(span.attributes["workflow.lookup"], "name");
    assertEquals(span.attributes["workflow.lookup.result"], "workflow");
  });
});

Deno.test("resolveRunReference: an unmatched name or prefix is traced with a not_found result", async () => {
  const deps = fakeDeps([RUN_A], [FLOW]);
  await withCapturedSpans(async (spans) => {
    assertEquals(await resolveRunReference(deps, "missing"), {
      kind: "not_found",
    });
    assertEquals(await resolveRunReference(deps, "fedcba"), {
      kind: "not_found",
    });
    const [byName, byPrefix] = spans.filter((s) => s.name === RESOLVE_SPAN);
    assertEquals(byName.attributes["workflow.lookup"], "name");
    assertEquals(byName.attributes["workflow.lookup.result"], "not_found");
    assertEquals(byPrefix.attributes["workflow.lookup"], "prefix");
    assertEquals(byPrefix.attributes["workflow.lookup.result"], "not_found");
  });
});

Deno.test("resolveRunReference: a long argument is traced cut to 256 characters", async () => {
  const deps = fakeDeps([RUN_A], [FLOW]);
  const long = `wf-${crypto.randomUUID()}-`.padEnd(300, "x");
  await withCapturedSpans(async (spans) => {
    assertEquals(await resolveRunReference(deps, long), { kind: "not_found" });
    assertEquals(deps.calls, [`workflow:${long}`]);
    const span = findSpan(spans, RESOLVE_SPAN);
    assertEquals(span.attributes["workflow.id_or_name"], long.slice(0, 256));
  });
});

Deno.test("tracedArgument: cuts a string longer than 256 characters to 256", () => {
  const long = "a".repeat(300);
  const traced = tracedArgument(long);
  assertEquals(traced.length, 256);
  assertEquals(traced, long.slice(0, 256));
});

Deno.test("tracedArgument: leaves a string of at most 256 characters unchanged", () => {
  assertEquals(tracedArgument("my-flow"), "my-flow");
  assertEquals(tracedArgument(""), "");
  const exact = "b".repeat(256);
  assertEquals(tracedArgument(exact), exact);
});
