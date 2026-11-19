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
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import {
  PhaseTally,
  withDiagnosticTally,
} from "../src/domain/diagnostics/diagnostic_phase.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { WorkflowExecutionService } from "../src/domain/workflows/execution_service.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createModelValidateDeps,
  isModelValidateAllData,
  modelValidate,
  type ModelValidateEvent,
} from "../src/libswamp/models/validate.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  createWorkflowValidateDeps,
  isWorkflowValidateAllData,
  workflowValidate,
  type WorkflowValidateEvent,
} from "../src/libswamp/workflows/validate.ts";
import { initializeTestRepo } from "./test_helpers.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const DEFINITIONS = 60;
const STEPS = 20;
// each lookup re-reads its hinted file, and a run looks a step up several times
const READS_PER_LOOKUP = 8;

interface Harness {
  dir: string;
  type: ModelType;
  names: string[];
}

async function withHarness(
  argumentsFor: (index: number, names: string[]) => Record<string, unknown>,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-name-lookups-" });
  const type = ModelType.create(`@test/name-lookups-${crypto.randomUUID()}`);
  modelRegistry.register({
    type,
    version: "2026.11.19.1",
    globalArguments: z.object({ label: z.string().optional() }),
    resources: {},
    methods: {
      run: {
        description: "run",
        arguments: z.object({ note: z.string().optional() }),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  });
  try {
    await initializeTestRepo(dir);
    const names = Array.from(
      { length: DEFINITIONS },
      (_, i) => `d${String(i).padStart(2, "0")}`,
    );
    const repo = new YamlDefinitionRepository(dir);
    for (const [i, name] of names.entries()) {
      await repo.save(
        type,
        Definition.create({
          name,
          type: type.normalized,
          globalArguments: { label: name },
          methods: { run: { arguments: argumentsFor(i, names) } },
        }),
      );
    }
    await fn({ dir, type, names });
  } finally {
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function tallied<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; filesRead: number; primaryWalks: number }> {
  const tally = new PhaseTally(true);
  const result = await withDiagnosticTally("step_outputs", tally, fn);
  const counts = tally.attributes();
  return {
    result,
    filesRead: counts["swamp.diagnostic.files_read"] ?? 0,
    primaryWalks: counts["swamp.diagnostic.primary_walks"] ?? 0,
  };
}

// ascending names: each one lies past every file an earlier lookup walked
function ascendingSteps(names: string[]): Step[] {
  return names.slice(0, STEPS * 3).filter((_, i) => i % 3 === 2).map((name) =>
    Step.create({ name: `run-${name}`, task: StepTask.model(name, "run") })
  );
}

function workflowOf(steps: Step[]): Workflow {
  return Workflow.create({
    name: `lookups-${crypto.randomUUID().slice(0, 8)}`,
    jobs: [Job.create({ name: "main", steps })],
  });
}

async function runWorkflow(dir: string, workflow: Workflow) {
  const repo = createRepositoryContext({ repoDir: dir });
  try {
    await repo.workflowRepo.save(workflow);
    const service = new WorkflowExecutionService(
      repo.workflowRepo,
      repo.workflowRunRepo,
      dir,
      undefined,
      undefined,
      repo.catalogStore,
    );
    return await tallied(() => service.execute(workflow.name));
  } finally {
    repo.catalogStore.close();
  }
}

Deno.test("Integration: behavior validate of every definition reads each definition file about once, however many reference one another", async () => {
  await withHarness(
    (i, names) => ({
      note: `\${{ model.${
        names[(i * 7 + 13) % names.length]
      }.definition.globalArguments.label }}`,
    }),
    async ({ dir }) => {
      const deps = createModelValidateDeps(dir);
      const { result: events, filesRead, primaryWalks } = await tallied(() =>
        collect<ModelValidateEvent>(
          modelValidate(createLibSwampContext(), deps, {}),
        )
      );

      const completed = events.find((e) => e.kind === "completed");
      assert(completed && isModelValidateAllData(completed.data));
      assertEquals(completed.data.totalPassed, DEFINITIONS);
      assertEquals(primaryWalks, 0);
      assert(
        filesRead <= DEFINITIONS * (1 + READS_PER_LOOKUP),
        `read ${filesRead} definition files for ${DEFINITIONS} definitions`,
      );
    },
  );
});

Deno.test("Integration: workflow validate resolves steps naming behaviors in ascending order with one definition walk", async () => {
  await withHarness(() => ({}), async ({ dir, names }) => {
    const repo = createRepositoryContext({ repoDir: dir });
    try {
      const workflow = workflowOf(ascendingSteps(names));
      await repo.workflowRepo.save(workflow);
      const deps = createWorkflowValidateDeps(
        repo.workflowRepo,
        new YamlDefinitionRepository(dir),
      );
      const { result: events, filesRead, primaryWalks } = await tallied(() =>
        collect<WorkflowValidateEvent>(
          workflowValidate(createLibSwampContext(), deps, {}),
        )
      );

      const completed = events.find((e) => e.kind === "completed");
      assert(completed && isWorkflowValidateAllData(completed.data));
      assertEquals(completed.data.passed, true);
      assert(primaryWalks <= 1, `${primaryWalks} definition walks`);
      assert(
        filesRead <= DEFINITIONS + STEPS * READS_PER_LOOKUP,
        `read ${filesRead} definition files for ${STEPS} steps`,
      );
    } finally {
      repo.catalogStore.close();
    }
  });
});

Deno.test("Integration: workflow run resolves steps naming behaviors in ascending order with one definition walk, not one per step", async () => {
  await withHarness(() => ({}), async ({ dir, names }) => {
    const { result: run, filesRead, primaryWalks } = await runWorkflow(
      dir,
      workflowOf(ascendingSteps(names)),
    );

    assertEquals(run.status, "succeeded");
    assert(primaryWalks <= 1, `${primaryWalks} definition walks`);
    assert(
      filesRead <= DEFINITIONS + STEPS * READS_PER_LOOKUP,
      `read ${filesRead} definition files for ${STEPS} steps`,
    );
  });
});

Deno.test("Integration: workflow run of a forEach naming its behavior by expression reads each definition file about once", async () => {
  await withHarness(() => ({}), async ({ dir, names }) => {
    const targets = ascendingSteps(names).map((step) =>
      step.name.slice("run-".length)
    );
    const { result: run, filesRead, primaryWalks } = await runWorkflow(
      dir,
      workflowOf([
        Step.create({
          name: "run-${{ self.target }}",
          forEach: { item: "target", in: `\${{ ${JSON.stringify(targets)} }}` },
          task: StepTask.model("${{ self.target }}", "run"),
        }),
      ]),
    );

    assertEquals(run.status, "succeeded");
    assert(primaryWalks <= 1, `${primaryWalks} definition walks`);
    assert(
      filesRead <= DEFINITIONS + targets.length * READS_PER_LOOKUP,
      `read ${filesRead} definition files for ${targets.length} iterations`,
    );
  });
});
