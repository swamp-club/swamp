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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowValidationResult } from "../../domain/workflows/validation_service.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { z } from "zod";
import { Definition } from "../../domain/definitions/definition.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { Job } from "../../domain/workflows/job.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import {
  createWorkflowValidateDeps,
  isWorkflowValidateAllData,
  workflowValidate,
  type WorkflowValidateData,
  type WorkflowValidateDeps,
  type WorkflowValidateEvent,
} from "./validate.ts";

function makeWorkflow(name = "my-workflow"): Workflow {
  return Workflow.create({ name });
}

function makeDeps(
  overrides?: Partial<WorkflowValidateDeps>,
): WorkflowValidateDeps {
  const workflow = makeWorkflow();
  return {
    findWorkflowById: () => Promise.resolve(workflow),
    findWorkflowByName: () => Promise.resolve(workflow),
    findAllWorkflows: () => Promise.resolve([workflow]),
    validate: () =>
      Promise.resolve([
        WorkflowValidationResult.pass("schema"),
        WorkflowValidationResult.pass("refs"),
      ]),
    ...overrides,
  };
}

Deno.test("workflowValidate single workflow yields completed", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as WorkflowValidateData;
  assertEquals(data.passed, true);
});

Deno.test("workflowValidate single workflow with a failing validation reports passed=false", async () => {
  // Guards the exit-code path: a failing validation result (e.g. an
  // unresolvable step-input type, see swamp-club#506) must surface as
  // passed=false so the CLI exits non-zero rather than reporting PASSED.
  const deps = makeDeps({
    validate: () =>
      Promise.resolve([
        WorkflowValidationResult.pass("schema"),
        WorkflowValidationResult.fail(
          "step inputs",
          "type could not be resolved",
        ),
      ]),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
    }),
  );

  const completed = events[1] as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as WorkflowValidateData;
  assertEquals(data.passed, false);
});

Deno.test("workflowValidate all workflows yields aggregate", async () => {
  const deps = makeDeps();
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {}),
  );

  const completed = events[1] as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  assertEquals(isWorkflowValidateAllData(completed.data), true);
});

Deno.test("workflowValidate by UUID tries the name first, then the id", async () => {
  const calls: string[] = [];
  const deps = makeDeps({
    findWorkflowById: () => {
      calls.push("id");
      return Promise.resolve(makeWorkflow("wf"));
    },
    findWorkflowByName: () => {
      calls.push("name");
      return Promise.resolve(null);
    },
  });
  await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "550e8400-e29b-41d4-a716-446655440000",
    }),
  );
  assertEquals(calls, ["name", "id"]);
});

Deno.test("workflowValidate: a workflow named with a UUID wins over the workflow with that id", async () => {
  const deps = makeDeps({
    findWorkflowById: () => Promise.resolve(makeWorkflow("by-id")),
    findWorkflowByName: () => Promise.resolve(makeWorkflow("by-name")),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "550e8400-e29b-41d4-a716-446655440000",
    }),
  );
  const completed = events.find((e) => e.kind === "completed") as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  assertEquals(
    (completed.data as WorkflowValidateData).workflowName,
    "by-name",
  );
});

Deno.test("workflowValidate with byId looks up by id only", async () => {
  const deps = makeDeps({
    findWorkflowById: () => Promise.resolve(makeWorkflow("by-id")),
    findWorkflowByName: () => {
      throw new Error("should not be called");
    },
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "550e8400-e29b-41d4-a716-446655440000",
      byId: true,
    }),
  );
  const completed = events.find((e) => e.kind === "completed") as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  assertEquals((completed.data as WorkflowValidateData).workflowName, "by-id");
});

Deno.test("workflowValidate with byId matches a broken workflow file by id only", async () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const deps = makeDeps({
    findWorkflowById: () => Promise.resolve(null),
    findWorkflowByName: () => Promise.resolve(null),
    listBrokenWorkflows: () =>
      Promise.resolve([
        { file: "/w/workflow-a.yaml", name: id, id: null, error: "bad" },
      ]),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: id,
      byId: true,
    }),
  );
  assertEquals(events.at(-1)?.kind, "error");
});

Deno.test("workflowValidate: warning does not affect passed aggregation", async () => {
  const deps = makeDeps({
    validate: () =>
      Promise.resolve([
        WorkflowValidationResult.pass("schema"),
        WorkflowValidationResult.warning(
          "step inputs (behavior not found)",
          "Behavior instance not found",
        ),
      ]),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "my-workflow",
    }),
  );

  const completed = events[1] as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as WorkflowValidateData;
  assertEquals(data.passed, true);
  assertEquals(data.totalWarnings, 1);
  const warningItem = data.validations.find((v) => v.warning);
  assertEquals(warningItem?.passed, true);
  assertEquals(warningItem?.warning, true);
  assertEquals(warningItem?.error?.includes("not found"), true);
});

Deno.test("workflowValidate yields error when not found", async () => {
  const deps = makeDeps({
    findWorkflowByName: () => Promise.resolve(null),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "missing",
    }),
  );

  assertEquals(events[1].kind, "error");
});

// Broken-file surfacing (swamp-club#1240): a workflow file that fails
// schema parsing is invisible to the repository, so validate must report
// the parse error rather than "not found" or an all-green aggregate.

const BROKEN = {
  file: "/repo/workflows/workflow-74ae52ba.yaml",
  name: "variant-a-job-labels",
  id: "74ae52ba-5f3f-4937-a4fd-c1de950572e7",
  error: "'labels' is a step property, not a job property",
};

Deno.test("workflowValidate single: schema-rejected file fails Schema validation instead of not-found", async () => {
  const deps = makeDeps({
    findWorkflowByName: () => Promise.resolve(null),
    listBrokenWorkflows: () => Promise.resolve([BROKEN]),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "variant-a-job-labels",
    }),
  );

  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  const data = completed.data as WorkflowValidateData;
  assertEquals(data.passed, false);
  assertEquals(data.workflowName, "variant-a-job-labels");
  assertEquals(data.validations[0].name, "Schema validation");
  assertEquals(data.validations[0].passed, false);
  assertEquals(
    data.validations[0].error?.includes("'labels' is a step property"),
    true,
  );
});

Deno.test("workflowValidate single: still not-found when no broken file matches", async () => {
  const deps = makeDeps({
    findWorkflowByName: () => Promise.resolve(null),
    listBrokenWorkflows: () => Promise.resolve([BROKEN]),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      workflowIdOrName: "some-other-workflow",
    }),
  );

  assertEquals(events[1].kind, "error");
});

Deno.test("workflowValidate all: broken files count as failures", async () => {
  const deps = makeDeps({
    listBrokenWorkflows: () => Promise.resolve([BROKEN]),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {}),
  );

  const completed = events[1] as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  if (!isWorkflowValidateAllData(completed.data)) {
    throw new Error("expected aggregate data");
  }
  assertEquals(completed.data.passed, false);
  assertEquals(completed.data.totalFailed, 1);
  assertEquals(completed.data.totalPassed, 1);
});

Deno.test("workflowValidate all: broken files alone still yield results, not no-workflows error", async () => {
  const deps = makeDeps({
    findAllWorkflows: () => Promise.resolve([]),
    listBrokenWorkflows: () => Promise.resolve([BROKEN]),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {}),
  );

  const completed = events[1] as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  if (!isWorkflowValidateAllData(completed.data)) {
    throw new Error("expected aggregate data");
  }
  assertEquals(completed.data.totalFailed, 1);
});

Deno.test("workflowValidate all: empty repository yields passed=true with no workflows", async () => {
  const deps = makeDeps({
    findAllWorkflows: () => Promise.resolve([]),
    listBrokenWorkflows: () => Promise.resolve([]),
  });
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  if (!isWorkflowValidateAllData(completed.data)) {
    throw new Error("expected aggregate data");
  }
  assertEquals(completed.data.passed, true);
  assertEquals(completed.data.workflows.length, 0);
  assertEquals(completed.data.totalPassed, 0);
  assertEquals(completed.data.totalFailed, 0);
  assertEquals(completed.data.totalWarnings, 0);
});

Deno.test("workflowValidate all with include reports only accepted workflows and broken files", async () => {
  const keep = Workflow.create({ name: "keep", tags: { env: "dev" } });
  const skip = Workflow.create({ name: "skip", tags: { env: "prod" } });
  const deps = makeDeps({
    findAllWorkflows: () => Promise.resolve([keep, skip]),
    listBrokenWorkflows: () =>
      Promise.resolve([
        { file: "/w/a.yaml", name: "broken-keep", id: null, error: "bad" },
        { file: "/w/b.yaml", name: "broken-skip", id: null, error: "bad" },
      ]),
  });

  const seen: Array<{ name: string; tags: Record<string, string> }> = [];
  const events = await collect<WorkflowValidateEvent>(
    workflowValidate(createLibSwampContext(), deps, {
      include: (workflow) => {
        seen.push(workflow);
        return workflow.name.endsWith("keep");
      },
    }),
  );

  const completed = events[1] as Extract<
    WorkflowValidateEvent,
    { kind: "completed" }
  >;
  if (!isWorkflowValidateAllData(completed.data)) {
    throw new Error("expected all data");
  }
  assertEquals(
    completed.data.workflows.map((w) => w.workflowName),
    ["broken-keep", "keep"],
  );
  assertEquals(
    seen.find((w) => w.name === "skip")?.tags,
    { env: "prod" },
  );
  assertEquals(seen.find((w) => w.name === "broken-skip")?.tags, {});
});

Deno.test("createWorkflowValidateDeps: fails a step whose stored definition holds a literal sensitive global (swamp-club#3555)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    const modelType = ModelType.create(
      `@test-3555/sensitive-${crypto.randomUUID().slice(0, 8)}`,
    );
    modelRegistry.register({
      type: modelType,
      version: "2026.01.01.1",
      globalArguments: z.object({
        token: z.string().meta({ sensitive: true }).optional(),
      }),
      resources: {},
      methods: {
        run: {
          description: "Run",
          arguments: z.object({}),
          execute: () => Promise.resolve({}),
        },
      },
    });
    const repo = new YamlDefinitionRepository(dir);
    const definition = Definition.create({
      name: "hand-edited",
      type: modelType.normalized,
    });
    await repo.save(modelType, definition);
    // Edited by hand after the save, so the save-time refusal never ran.
    const path = repo.getPath(modelType, definition.id);
    const yaml = await Deno.readTextFile(path);
    await Deno.writeTextFile(
      path,
      yaml.replace(
        /^globalArguments: \{\}$/m,
        "globalArguments:\n  token: GLOBAL-CANARY",
      ),
    );

    const deps = createWorkflowValidateDeps(
      {} as WorkflowRepository,
      new YamlDefinitionRepository(dir),
    );
    const results = await deps.validate(Workflow.create({
      name: "wf",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({
              name: "step1",
              task: StepTask.model("hand-edited", "run"),
            }),
          ],
        }),
      ],
    }));
    const globalResult = results.find((r) =>
      r.name.startsWith("Global arguments for 'step1'")
    );
    assertEquals(globalResult?.passed, false);
    assertStringIncludes(globalResult?.error ?? "", "'token'");
    assertEquals(globalResult?.error?.includes("GLOBAL-CANARY"), false);
    const inputResult = results.find((r) => r.name.includes("Step inputs"));
    assertEquals(inputResult?.passed, true);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("createWorkflowValidateDeps: predicts sensitive-output vaults with the step override's vaultName merged over the definition's (swamp-club#3606)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    const modelType = ModelType.create(
      `@test-3606/secret-${crypto.randomUUID().slice(0, 8)}`,
    );
    modelRegistry.register({
      type: modelType,
      version: "2026.01.01.1",
      globalArguments: z.object({}),
      resources: {
        creds: {
          description: "Credentials",
          schema: z.object({ secret: z.string().meta({ sensitive: true }) }),
          lifetime: "infinite",
          garbageCollection: 10,
        },
      },
      methods: {
        create: {
          description: "Create",
          arguments: z.object({}),
          execute: () => Promise.resolve({}),
        },
      },
    });
    const repo = new YamlDefinitionRepository(dir);
    await repo.save(
      modelType,
      Definition.create({
        name: "secret-maker",
        type: modelType.normalized,
        resources: { creds: { vaultName: "def-vault" } },
      }),
    );
    const deps = createWorkflowValidateDeps(
      {} as WorkflowRepository,
      new YamlDefinitionRepository(dir),
      undefined,
      () =>
        Promise.resolve({
          getDefaultVaultName: () => undefined,
          getUserVaultNames: () => ["fallback", "def-vault", "step-vault"],
        }),
    );
    const vaultsResult = async (
      override: { specName: string; vaultName?: string; vary?: string[] },
    ) => {
      const results = await deps.validate(Workflow.create({
        name: "wf",
        vaults: ["def-vault"],
        jobs: [
          Job.create({
            name: "job1",
            steps: [
              Step.create({
                name: "step1",
                task: StepTask.model("secret-maker", "create"),
                dataOutputOverrides: [override],
              }),
            ],
          }),
        ],
      }));
      return results.find((r) => r.name.startsWith("Sensitive outputs"));
    };

    const routed = await vaultsResult({
      specName: "creds",
      vaultName: "step-vault",
    });
    assertEquals(routed?.passed, false);
    assertStringIncludes(routed?.error ?? "", "'step-vault'");
    assertEquals(routed?.error?.includes("'fallback'"), false);

    // A step override that sets only vary keeps the definition's vaultName.
    assertEquals(
      await vaultsResult({ specName: "creds", vary: ["env"] }),
      undefined,
    );

    // An evaluated vaultName is decided at run time, not predicted here.
    assertEquals(
      await vaultsResult({
        specName: "creds",
        vaultName: "${{ inputs.vault }}",
      }),
      undefined,
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
