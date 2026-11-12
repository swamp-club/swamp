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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import {
  type WorkflowExecutionEvent,
  WorkflowExecutionService,
} from "../src/domain/workflows/execution_service.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createWorkflowApproveDeps,
  workflowApprove,
} from "../src/libswamp/workflows/approve.ts";
import { unclaimedRuns } from "../src/domain/workflows/run_claim.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { toRunData } from "../src/libswamp/workflows/run.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const SECRET = "LITERAL_SECRET_4667";

interface Harness {
  service: WorkflowExecutionService;
  workflowRepo: YamlWorkflowRepository;
  runRepo: YamlWorkflowRunRepository;
  received: unknown[];
}

async function withHarness(
  workflows: (definitionName: string) => Workflow[],
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-literal-display-" });
  const catalog = new CatalogStore(join(dir, "_catalog.db"));
  const type = ModelType.create(`@test/literal-echo-${crypto.randomUUID()}`);
  const received: unknown[] = [];
  modelRegistry.register({
    type,
    version: "2026.11.12.1",
    globalArguments: z.object({}),
    methods: {
      run: {
        description: "Receives a sensitive argument",
        arguments: z.object({
          secret: z.string().meta({ sensitive: true }),
          marker: z.string(),
        }),
        execute: (args) => {
          received.push((args as { secret: string }).secret);
          return Promise.resolve({});
        },
      },
    },
  });
  try {
    const definition = Definition.create({
      name: `echo-${crypto.randomUUID().slice(0, 8)}`,
      type: type.normalized,
      inputs: {
        properties: { secret: { type: "string" }, marker: { type: "string" } },
        required: ["secret", "marker"],
      },
      methods: {
        run: {
          arguments: {
            secret: "${{ inputs.secret }}",
            marker: "${{ inputs.marker }}",
          },
        },
      },
    });
    await new YamlDefinitionRepository(dir).save(type, definition);
    const workflowRepo = new YamlWorkflowRepository(dir);
    for (const workflow of workflows(definition.name)) {
      await workflowRepo.save(workflow);
    }
    const runRepo = new YamlWorkflowRunRepository(dir);
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      dir,
      undefined,
      undefined,
      catalog,
    );
    await fn({ service, workflowRepo, runRepo, received });
  } finally {
    catalog.close();
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function terminalRun(
  stream: AsyncIterable<WorkflowExecutionEvent>,
  seen: WorkflowExecutionEvent[] = [],
): Promise<WorkflowRun> {
  let run: WorkflowRun | undefined;
  for await (const event of stream) {
    seen.push(event);
    if (event.kind === "completed" || event.kind === "suspended") {
      run = event.run;
    }
  }
  assert(run, "no terminal event");
  return run;
}

function echoWorkflow(definitionName: string, name: string): Workflow {
  return Workflow.create({
    name,
    inputs: {
      properties: { marker: { type: "string" }, secret: { type: "string" } },
      required: ["marker", "secret"],
    },
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "echo",
        task: StepTask.model(definitionName, "run", {
          secret: "${{ inputs.secret }}",
          marker: "${{ inputs.marker }}",
        }),
      })],
    })],
  });
}

Deno.test("workflow run: a literal input reaching a sensitive argument is masked in the run view", async () => {
  let workflow!: Workflow;
  await withHarness(
    (name) => [workflow = echoWorkflow(name, "literal-display")],
    async ({ service, received }) => {
      const run = await terminalRun(
        service.run(workflow.name, { inputs: { marker: "M", secret: SECRET } }),
      );
      assertEquals(run.status, "succeeded");
      assertEquals(received, [SECRET]);
      assertEquals(toRunData(run).inputs, { marker: "M", secret: "***" });
    },
  );
});

Deno.test("workflow run: a literal a nested child reveals is masked in the parent's run view", async () => {
  let parent!: Workflow;
  await withHarness((name) => {
    const child = echoWorkflow(name, "literal-display-child");
    parent = Workflow.create({
      name: "literal-display-parent",
      inputs: {
        properties: { secret: { type: "string" } },
        required: ["secret"],
      },
      jobs: [Job.create({
        name: "parent",
        steps: [Step.create({
          name: "child",
          task: StepTask.workflow(child.name, {
            secret: "${{ inputs.secret }}",
            marker: "N",
          }),
        })],
      })],
    });
    return [child, parent];
  }, async ({ service, received }) => {
    const run = await terminalRun(
      service.run(parent.name, { inputs: { secret: SECRET } }),
    );
    assertEquals(run.status, "succeeded");
    assertEquals(received, [SECRET]);
    assertEquals(toRunData(run).inputs, { secret: "***" });
  });
});

Deno.test("workflow resume: an input a step masked before an approval stays masked in the resumed run's view", async () => {
  let workflow!: Workflow;
  await withHarness((name) => {
    workflow = Workflow.create({
      name: "literal-display-gated",
      inputs: {
        properties: {
          marker: { type: "string" },
          secret: { type: "string" },
        },
        required: ["marker", "secret"],
      },
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "echo",
            task: StepTask.model(name, "run", {
              secret: "${{ inputs.secret }}",
              marker: "${{ inputs.marker }}",
            }),
          }),
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Deploy with ${{ inputs.secret }}"),
            dependsOn: [{
              step: "echo",
              condition: TriggerCondition.succeeded(),
            }],
          }),
          Step.create({
            name: "after",
            task: StepTask.model(name, "run", {
              secret: "after-gate",
              marker: "${{ inputs.marker }}",
            }),
            dependsOn: [{
              step: "gate",
              condition: TriggerCondition.succeeded(),
            }],
          }),
        ],
      })],
    });
    return [workflow];
  }, async (h) => {
    const events: WorkflowExecutionEvent[] = [];
    const suspended = await terminalRun(
      h.service.run(workflow.name, {
        inputs: { marker: "MARKER", secret: SECRET },
      }),
      events,
    );
    assertEquals(suspended.status, "suspended");
    const prompts = events.flatMap((e) =>
      e.kind === "approval_requested" || e.kind === "suspended"
        ? [e.prompt]
        : []
    );
    assertEquals(prompts, ["Deploy with ***", "Deploy with ***"]);
    assertEquals(toRunData(suspended).inputs?.secret, "***");

    for await (
      const event of workflowApprove(
        createLibSwampContext(),
        createWorkflowApproveDeps(h.workflowRepo, h.runRepo, unclaimedRuns),
        {
          workflowIdOrName: workflow.name,
          stepName: "gate",
          runId: suspended.id,
        },
      )
    ) {
      if (event.kind === "error") throw new Error(event.error.message);
    }

    const resumed = await terminalRun(
      h.service.resume(workflow.name, suspended.id),
    );
    assertEquals(resumed.status, "succeeded");
    assertEquals(h.received, [SECRET, "after-gate"]);
    assertEquals(toRunData(resumed).inputs, {
      marker: "MARKER",
      secret: "***",
    });
  });
});
