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
 * Task targets chosen from data an earlier step of the same run wrote
 * (swamp-club#2351).
 *
 * A driver step writes a record naming the next workflow; a later step's
 * `workflowIdOrName` reads it with `data.latest`. That target used to be
 * evaluated once at run start, before the record existed, so it silently took
 * the `orValue` fallback — or a previous run's value. These tests wire the
 * evaluator, execution service, data repository and nested workflows together
 * in-process against a real temp repo.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Step, type StepInput } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

type RepositoryContext = ReturnType<typeof createRepositoryContext>;

/** What a consumer step saw when it ran. */
interface Execution {
  definition: string;
  value: string;
  seen?: string;
}

/** The record every driver step writes: `data.latest("driver", "next")`. */
const NEXT = 'data.latest("driver", "next")';

const WriteArgs = z.object({ workflow: z.string() });
const RunArgs = z.object({ value: z.string(), seen: z.string().optional() });

async function withRepo(
  fn: (
    repo: RepositoryContext,
    dir: string,
    executions: Execution[],
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-step-output-targets-" });
  const repo = createRepositoryContext({ repoDir: dir });
  const type = ModelType.create(`test/targets-${crypto.randomUUID()}`);
  const executions: Execution[] = [];
  modelRegistry.register({
    type,
    version: "2026.09.22.1",
    resources: {
      next: {
        description: "The workflow or model a driver chose",
        schema: z.object({ workflow: z.string() }),
        lifetime: "infinite",
        garbageCollection: 20,
      },
    },
    methods: {
      write: {
        description: "Record which target runs next",
        arguments: WriteArgs,
        execute: async (args, context) => {
          const handle = await context.writeResource!("next", "next", {
            workflow: WriteArgs.parse(args).workflow,
          });
          return { dataHandles: [handle] };
        },
      },
      run: {
        description: "Capture which definition ran and what it received",
        arguments: RunArgs,
        execute: (args, context) => {
          executions.push({
            definition: context.definition.name,
            ...RunArgs.parse(args),
          });
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  });
  for (const name of ["driver", "consumer", "consumer-a", "consumer-b"]) {
    await repo.definitionRepo.save(type, Definition.create({ name }));
  }
  for (const name of ["child-a", "child-b", "child-c"]) {
    await repo.workflowRepo.save(childWorkflow(name));
  }
  try {
    await fn(repo, dir, executions);
  } finally {
    repo.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** A child workflow that reports its own name and the `seen` input. */
function childWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    inputs: {
      type: "object",
      properties: { seen: { type: "string", default: "" } },
    },
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "announce",
        task: StepTask.model("consumer", "run", {
          value: name,
          seen: "${{ inputs.seen }}",
        }),
      })],
    })],
  });
}

/** Writes `${{ inputs.target }}` into the driver record. */
function writeStep(): Step {
  return Step.create({
    name: "write",
    task: StepTask.model("driver", "write", {
      workflow: "${{ inputs.target }}",
    }),
  });
}

/** A parent workflow: the driver write, then `consumer` depending on it. */
function driverWorkflow(
  name: string,
  consumer: Omit<StepInput, "name" | "dependsOn">,
  leading: Step[] = [writeStep()],
): Workflow {
  const after = leading.at(-1)!.name;
  return Workflow.create({
    name,
    inputs: {
      type: "object",
      properties: {
        target: { type: "string", default: "" },
        payload: { type: "string", default: "" },
      },
    },
    jobs: [Job.create({
      name: "main",
      steps: [
        ...leading,
        Step.fromData({
          name: "dispatch",
          ...consumer,
          dependsOn: [{ step: after, condition: { type: "succeeded" } }],
        }),
      ],
    })],
  });
}

async function service(repo: RepositoryContext, dir: string) {
  const deps = await createWorkflowRunDeps(dir, repo, {
    type: "filesystem",
    path: join(dir, ".swamp"),
  });
  return deps.createExecutionService(
    repo.workflowRepo,
    repo.workflowRunRepo,
    dir,
    repo.catalogStore,
  );
}

async function runWorkflow(
  repo: RepositoryContext,
  dir: string,
  name: string,
  inputs: Record<string, unknown>,
  lastEvaluated = false,
): Promise<WorkflowRun> {
  return await (await service(repo, dir)).execute(name, {
    inputs,
    lastEvaluated,
  });
}

function dispatchError(run: WorkflowRun): string {
  return run.getJob("main")?.getStep("dispatch")?.error ?? "";
}

const FALLBACK_TARGET =
  `\${{ ${NEXT}.?attributes.?workflow.orValue("child-a") }}`;

Deno.test("step-output targets: a nested workflow target reads the record an earlier step of the same run wrote", async () => {
  await withRepo(async (repo, dir, executions) => {
    await repo.workflowRepo.save(driverWorkflow("driver-flow", {
      task: { type: "workflow", workflowIdOrName: FALLBACK_TARGET },
    }));

    // First run: no record exists at run start. Before the fix this took the
    // orValue fallback (child-a).
    const first = await runWorkflow(repo, dir, "driver-flow", {
      target: "child-b",
    });
    assertEquals(first.status, "succeeded", JSON.stringify(first.toData()));

    // Second run: the first run's record exists at run start. Before the fix
    // this ran the stale child-b.
    const second = await runWorkflow(repo, dir, "driver-flow", {
      target: "child-c",
    });
    assertEquals(second.status, "succeeded");

    assertEquals(executions.map((e) => e.value), ["child-b", "child-c"]);
  });
});

Deno.test("step-output targets: a target without the null-safe form resolves at step time", async () => {
  await withRepo(async (repo, dir, executions) => {
    await repo.workflowRepo.save(driverWorkflow("plain-target", {
      task: {
        type: "workflow",
        workflowIdOrName: `\${{ ${NEXT}.attributes.workflow }}`,
      },
    }));

    // Before the fix the whole run failed at start: "No such key: attributes".
    const run = await runWorkflow(repo, dir, "plain-target", {
      target: "child-b",
    });
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(executions.map((e) => e.value), ["child-b"]);
  });
});

Deno.test("step-output targets: a record still missing at step time fails only that step", async () => {
  await withRepo(async (repo, dir, executions) => {
    await repo.workflowRepo.save(driverWorkflow("missing-record", {
      task: {
        type: "workflow",
        workflowIdOrName:
          '${{ data.latest("driver", "never-written").attributes.workflow }}',
      },
    }));

    const run = await runWorkflow(repo, dir, "missing-record", {
      target: "child-b",
    });
    assertEquals(run.status, "failed");
    assertEquals(run.getJob("main")?.getStep("write")?.status, "succeeded");
    assertEquals(run.getJob("main")?.getStep("dispatch")?.status, "failed");
    assertEquals(executions, []);
  });
});

Deno.test("step-output targets: an interpolated target resolves each deferred expression", async () => {
  await withRepo(async (repo, dir, executions) => {
    await repo.workflowRepo.save(driverWorkflow("interpolated-target", {
      task: {
        type: "workflow",
        workflowIdOrName: `child-\${{ ${NEXT}.attributes.workflow }}`,
      },
    }));

    const run = await runWorkflow(repo, dir, "interpolated-target", {
      target: "b",
    });
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(executions.map((e) => e.value), ["child-b"]);
  });
});

Deno.test("step-output targets: a model_method target reads the same-run record", async () => {
  await withRepo(async (repo, dir, executions) => {
    await repo.workflowRepo.save(driverWorkflow("model-target", {
      task: {
        type: "model_method",
        modelIdOrName:
          `\${{ ${NEXT}.?attributes.?workflow.orValue("consumer-a") }}`,
        methodName: "run",
        inputs: { value: "model" },
      },
    }));

    const run = await runWorkflow(repo, dir, "model-target", {
      target: "consumer-b",
    });
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(executions.map((e) => e.definition), ["consumer-b"]);
  });
});

Deno.test("step-output targets: forEach with self.* and data.* in the target resolves per expansion", async () => {
  await withRepo(async (repo, dir, executions) => {
    await repo.workflowRepo.save(driverWorkflow("foreach-target", {
      forEach: { item: "x", in: '${{ ["go"] }}' },
      task: {
        type: "workflow",
        workflowIdOrName:
          `\${{ self.x == "go" ? ${NEXT}.?attributes.?workflow.orValue("child-a") : "child-a" }}`,
      },
    }));

    // Before the fix the raw template reached the child lookup:
    // "Workflow not found: ${{ self.x == ... }}".
    const run = await runWorkflow(repo, dir, "foreach-target", {
      target: "child-b",
    });
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(executions.map((e) => e.value), ["child-b"]);
  });
});

Deno.test("step-output targets: an input sharing the target's text gets the fresh value", async () => {
  await withRepo(async (repo, dir, executions) => {
    await repo.workflowRepo.save(driverWorkflow("shared-text", {
      task: {
        type: "workflow",
        workflowIdOrName: FALLBACK_TARGET,
        inputs: { seen: FALLBACK_TARGET },
      },
    }));

    // Before the fix substitution, keyed on the raw text, wrote the target's
    // run-start value (the fallback) into the identical input too.
    const run = await runWorkflow(repo, dir, "shared-text", {
      target: "child-b",
    });
    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(executions, [{
      definition: "consumer",
      value: "child-b",
      seen: "child-b",
    }]);
  });
});

Deno.test("step-output targets: a --last-evaluated replay resolves the target at step time", async () => {
  await withRepo(async (repo, dir, executions) => {
    await repo.workflowRepo.save(driverWorkflow("replayed", {
      task: { type: "workflow", workflowIdOrName: FALLBACK_TARGET },
    }));

    await runWorkflow(repo, dir, "replayed", { target: "child-b" });
    // The cache baked the writer's input (child-b) but must keep the target
    // raw. Before the fix it baked the run-start fallback, child-a.
    const replay = await runWorkflow(
      repo,
      dir,
      "replayed",
      { target: "child-b" },
      true,
    );
    assertEquals(replay.status, "succeeded", JSON.stringify(replay.toData()));
    assertEquals(executions.map((e) => e.value), ["child-b", "child-b"]);
  });
});

Deno.test("step-output targets: template text inside a record stays inert", async () => {
  await withRepo(async (repo, dir, executions) => {
    // The writer records the payload input verbatim. Its text appears nowhere
    // in the workflow source, so it is data content, never an expression —
    // even though evaluating it would name a real child.
    const injected = "${{ inputs.target }}";
    await repo.workflowRepo.save(driverWorkflow(
      "inert-record",
      {
        task: {
          type: "workflow",
          workflowIdOrName: `\${{ ${NEXT}.attributes.workflow }}`,
        },
      },
      [Step.create({
        name: "write",
        task: StepTask.model("driver", "write", {
          workflow: "${{ inputs.payload }}",
        }),
      })],
    ));

    const run = await runWorkflow(repo, dir, "inert-record", {
      target: "child-b",
      payload: injected,
    });
    assertEquals(run.status, "failed");
    assertStringIncludes(dispatchError(run), `Workflow not found: ${injected}`);
    assertEquals(executions, []);
  });
});

Deno.test("step-output targets: a target resolving to a record fails the step with a clear error", async () => {
  await withRepo(async (repo, dir, executions) => {
    await repo.workflowRepo.save(driverWorkflow("record-target", {
      task: {
        type: "workflow",
        workflowIdOrName: `\${{ ${NEXT}.attributes }}`,
      },
    }));

    const run = await runWorkflow(repo, dir, "record-target", {
      target: "child-b",
    });
    assertEquals(run.status, "failed");
    assertStringIncludes(
      dispatchError(run),
      "task.workflowIdOrName expression",
    );
    assertStringIncludes(dispatchError(run), "expected a name");
    assertEquals(executions, []);
  });
});

Deno.test("step-output targets: resume resolves the target from the record written after it", async () => {
  await withRepo(async (repo, dir, executions) => {
    // A stale record from an earlier run names child-a.
    await repo.workflowRepo.save(driverWorkflow("seed", {
      task: { type: "workflow", workflowIdOrName: "child-a" },
    }));
    await runWorkflow(repo, dir, "seed", { target: "child-a" });
    executions.length = 0;

    const gated = driverWorkflow(
      "gated",
      { task: { type: "workflow", workflowIdOrName: FALLBACK_TARGET } },
      [
        Step.create({ name: "gate", task: StepTask.manualApproval("Go?") }),
        Step.fromData({
          ...writeStep().toData(),
          dependsOn: [{ step: "gate", condition: { type: "succeeded" } }],
        }),
      ],
    );
    await repo.workflowRepo.save(gated);

    const svc = await service(repo, dir);
    const suspended = await svc.execute("gated", {
      inputs: { target: "child-b" },
    });
    assertEquals(suspended.status, "suspended");

    const toApprove = await repo.workflowRunRepo.findById(
      gated.id,
      suspended.id,
    );
    const waiting = toApprove!.findWaitingApprovalStep()!;
    toApprove!.getJob(waiting.jobName)!.getStep(waiting.stepName)!.succeed();
    await repo.workflowRunRepo.save(gated.id, toApprove!);

    // Resume re-evaluates the workflow while the record still names child-a.
    // Before the fix the target baked that in; now it waits for the writer.
    let resumed: WorkflowRun | undefined;
    for await (const event of svc.resume("gated", suspended.id)) {
      if (event.kind === "completed") resumed = event.run;
    }
    assertEquals(resumed?.status, "succeeded");
    assertEquals(executions.map((e) => e.value), ["child-b"]);
  });
});

Deno.test("step-output targets: steps.* in task inputs and a target resolves at step time", async () => {
  await withRepo(async (repo, dir, executions) => {
    await repo.workflowRepo.save(driverWorkflow("steps-namespace", {
      task: {
        type: "workflow",
        workflowIdOrName:
          '${{ steps.write.status == "succeeded" ? "child-b" : "child-a" }}',
        inputs: { seen: "${{ steps.write.status }}" },
      },
    }));

    // Before the fix both runs failed at start: "Unknown variable: steps".
    for (const lastEvaluated of [false, true]) {
      const run = await runWorkflow(
        repo,
        dir,
        "steps-namespace",
        { target: "child-c" },
        lastEvaluated,
      );
      assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    }
    assertEquals(executions.map((e) => [e.value, e.seen]), [
      ["child-b", "succeeded"],
      ["child-b", "succeeded"],
    ]);
  });
});
