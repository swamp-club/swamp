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
 * H5 regression: commands that fail must exit with code 1.
 *
 * These commands use `Deno.exitCode = 1; return` instead of `Deno.exit(1)` so
 * that runCli can flush the datastore and release locks. main.ts must call
 * `Deno.exit()` (no arg) to honor exitCode — passing 0 overwrites failures.
 */

import { assertEquals } from "@std/assert";
import { initializeTestRepo, runCliCommand } from "./test_helpers.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { SHELL_MODEL_TYPE } from "../src/domain/models/command/shell/shell_model.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-exitcode-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("H5: model validate exits 1 on validation failure", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    await definitionRepo.save(
      SHELL_MODEL_TYPE,
      Definition.create({
        name: "bad-model",
        methods: { execute: { arguments: { wrongField: "oops" } } },
      }),
    );

    const result = await runCliCommand(
      ["model", "validate", "bad-model", "--repo-dir", repoDir, "--json"],
      Deno.cwd(),
    );
    assertEquals(result.code, 1, "model validate must exit 1 on failure");
  });
});

Deno.test({
  name: "H5: model method run exits 1 when command fails",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (repoDir) => {
      await initializeTestRepo(repoDir);
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      await definitionRepo.save(
        SHELL_MODEL_TYPE,
        Definition.create({
          name: "fail-cmd",
          methods: {
            execute: { arguments: { run: "false", workingDir: "/tmp" } },
          },
        }),
      );

      const result = await runCliCommand(
        [
          "model",
          "method",
          "run",
          "fail-cmd",
          "execute",
          "--repo-dir",
          repoDir,
          "--json",
        ],
        Deno.cwd(),
      );
      assertEquals(result.code, 1, "model method run must exit 1 on failure");
    });
  },
});

Deno.test({
  name: "H5: workflow run exits 1 on step failure (static-refs path)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (repoDir) => {
      await initializeTestRepo(repoDir);
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      await definitionRepo.save(
        SHELL_MODEL_TYPE,
        Definition.create({
          name: "boom",
          methods: {
            execute: { arguments: { run: "false", workingDir: "/tmp" } },
          },
        }),
      );

      const workflowRepo = new YamlWorkflowRepository(repoDir);
      await workflowRepo.save(
        Workflow.create({
          name: "static-fail",
          jobs: [
            Job.create({
              name: "run",
              steps: [
                Step.create({
                  name: "explode",
                  task: StepTask.model("boom", "execute"),
                }),
              ],
            }),
          ],
        }),
      );

      const result = await runCliCommand(
        [
          "workflow",
          "run",
          "static-fail",
          "--repo-dir",
          repoDir,
          "--json",
        ],
        Deno.cwd(),
      );
      assertEquals(
        result.code,
        1,
        "workflow run (static refs) must exit 1 on failure",
      );
    });
  },
});

Deno.test({
  name: "H5: workflow run exits 1 on step failure (dynamic-refs path)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (repoDir) => {
      await initializeTestRepo(repoDir);
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      await definitionRepo.save(
        SHELL_MODEL_TYPE,
        Definition.create({
          name: "boom",
          methods: {
            execute: { arguments: { run: "false", workingDir: "/tmp" } },
          },
        }),
      );

      const workflowRepo = new YamlWorkflowRepository(repoDir);
      await workflowRepo.save(
        Workflow.create({
          name: "dynamic-fail",
          jobs: [
            Job.create({
              name: "run",
              steps: [
                Step.create({
                  name: "explode",
                  // CEL expression in model name triggers dynamic-refs path
                  task: StepTask.model(
                    '${{ "boom" }}',
                    "execute",
                  ),
                }),
              ],
            }),
          ],
        }),
      );

      const result = await runCliCommand(
        [
          "workflow",
          "run",
          "dynamic-fail",
          "--repo-dir",
          repoDir,
          "--json",
        ],
        Deno.cwd(),
      );
      assertEquals(
        result.code,
        1,
        "workflow run (dynamic refs) must exit 1 on failure",
      );
    });
  },
});

Deno.test({
  name: "H5: workflow resume exits 1 when resumed workflow fails",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (repoDir) => {
      await initializeTestRepo(repoDir);
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      await definitionRepo.save(
        SHELL_MODEL_TYPE,
        Definition.create({ name: "boom", methods: {} }),
      );

      const workflowRepo = new YamlWorkflowRepository(repoDir);
      await workflowRepo.save(
        Workflow.create({
          name: "gate-then-fail",
          jobs: [
            Job.create({
              name: "run",
              steps: [
                Step.create({
                  name: "gate",
                  task: StepTask.manualApproval("Approve to proceed"),
                }),
                Step.create({
                  name: "explode",
                  task: StepTask.model("boom", "execute", { run: "false" }),
                  dependsOn: [
                    { step: "gate", condition: TriggerCondition.succeeded() },
                  ],
                }),
              ],
            }),
          ],
        }),
      );

      // Run suspends at the gate
      const runResult = await runCliCommand(
        [
          "workflow",
          "run",
          "gate-then-fail",
          "--repo-dir",
          repoDir,
          "--json",
        ],
        Deno.cwd(),
      );
      assertEquals(runResult.code, 0, "run should suspend at gate");

      // Approve the gate
      const approveResult = await runCliCommand(
        [
          "workflow",
          "approve",
          "gate-then-fail",
          "gate",
          "--repo-dir",
          repoDir,
          "--json",
        ],
        Deno.cwd(),
      );
      assertEquals(approveResult.code, 0, "approve should succeed");

      // Resume — the failing step runs
      const resumeResult = await runCliCommand(
        [
          "workflow",
          "resume",
          "gate-then-fail",
          "--repo-dir",
          repoDir,
          "--json",
        ],
        Deno.cwd(),
      );
      assertEquals(
        resumeResult.code,
        1,
        "workflow resume must exit 1 when a step fails",
      );
    });
  },
});
