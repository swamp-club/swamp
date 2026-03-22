// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * Integration tests for workflow execution with partial inputs.
 *
 * Verifies that globalArgument expressions referencing unprovided inputs
 * are skipped during workflow execution, matching the CLI path behavior.
 * See: https://github.com/systeminit/swamp/issues/653
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { SHELL_MODEL_TYPE } from "../src/domain/models/command/shell/shell_model.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-partial-inputs-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function initializeTestRepo(repoDir: string): Promise<void> {
  const subdirs = [
    "models",
    ".swamp/outputs",
    ".swamp/data",
    ".swamp/logs",
    "workflows",
    ".swamp/workflow-runs",
    "vaults",
    ".swamp/secrets",
  ];
  for (const subdir of subdirs) {
    await ensureDir(join(repoDir, subdir));
  }

  const markerData = {
    swampVersion: "0.0.0",
    initializedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    join(repoDir, ".swamp.yaml"),
    stringifyYaml(markerData as Record<string, unknown>),
  );
}

async function runCliCommand(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", "dev", ...args],
    stdout: "piped",
    stderr: "piped",
    cwd,
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

Deno.test("Workflow: succeeds with partial inputs when globalArguments reference unprovided inputs", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    // Create a factory model with inputs schema and globalArguments
    // that reference multiple inputs. The "execute" method only uses "run"
    // (from globalArguments), so unprovided inputs should be skipped.
    const model = Definition.create({
      name: "partial-input-model",
      inputs: {
        properties: {
          instanceName: { type: "string" },
          cidrBlock: { type: "string" },
        },
        required: ["instanceName", "cidrBlock"],
      },
      globalArguments: {
        run: '${{ "echo " + inputs.instanceName }}',
        unusedArg: "${{ inputs.cidrBlock }}",
      },
      methods: {
        execute: {
          arguments: {
            run: "echo fallback",
          },
        },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, model);

    // Create a workflow that only provides instanceName (partial inputs).
    // The cidrBlock input is not provided, but the method doesn't need it.
    const workflow = Workflow.create({
      name: "partial-inputs-workflow",
      jobs: [
        Job.create({
          name: "run-job",
          steps: [
            Step.create({
              name: "run-step",
              task: StepTask.model("partial-input-model", "execute", {
                instanceName: "test-instance",
              }),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "partial-inputs-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Workflow should succeed with partial inputs. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs[0].steps[0].status, "succeeded");
  });
});

// Regression test for issue #814.
//
// A ternary expression in methods.execute.arguments.run must resolve correctly
// when the condition input is provided but one branch input is absent.
//
// The ternary is placed in methods.execute.arguments.run (not globalArguments)
// because the shell model reads args.run directly — this gives a clear pass/fail
// signal without being dependent on any model-specific globalArgs access.
//
// Before the fix: expression is skipped (regex pre-check treats all referenced
// inputs as required), shell executes the raw "${{ ... }}" string → exit code 1.
// After the fix: CEL short-circuits the ternary and resolves to "echo 100.64.0.1".
Deno.test("Workflow: ternary expression resolves when condition input provided and one branch input absent", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const workflowRepo = new YamlWorkflowRepository(repoDir);

    const model = Definition.create({
      name: "transport-host-model",
      inputs: {
        properties: {
          transport: { type: "string" },
          lan_host: { type: "string" },
          tailnet_host: { type: "string" },
        },
        required: ["transport", "tailnet_host"],
      },
      globalArguments: {},
      methods: {
        execute: {
          arguments: {
            run:
              '${{ "echo " + (inputs.transport == "lan" ? inputs.lan_host : inputs.tailnet_host) }}',
          },
        },
      },
    });
    await definitionRepo.save(SHELL_MODEL_TYPE, model);

    const workflow = Workflow.create({
      name: "ternary-transport-workflow",
      jobs: [
        Job.create({
          name: "run-job",
          steps: [
            Step.create({
              name: "run-step",
              task: StepTask.model("transport-host-model", "execute", {
                transport: "wan",
                tailnet_host: "100.64.0.1",
                // lan_host deliberately absent — only the wan branch is needed
              }),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "ternary-transport-workflow",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(
      result.code,
      0,
      `Workflow should succeed with ternary expression. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs[0].steps[0].status, "succeeded");
  });
});
