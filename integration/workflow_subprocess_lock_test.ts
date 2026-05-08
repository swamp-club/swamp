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
 * Integration test: workflow shell step that invokes a nested swamp
 * structural command must complete without deadlocking on the parent's
 * per-model locks. Regression test for swamp-club#296.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { Definition } from "../src/domain/definitions/definition.ts";
import { SHELL_MODEL_TYPE } from "../src/domain/models/command/shell/shell_model.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";

const PROJECT_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");

const CLI_ARGS = [
  "run",
  "--config",
  join(PROJECT_ROOT, "deno.json"),
  "--unstable-bundle",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-sys",
  join(PROJECT_ROOT, "main.ts"),
];

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-subprocess-lock-" });
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

async function initializeTestRepo(repoDir: string): Promise<void> {
  const subdirs = [
    "models",
    ".swamp/outputs",
    ".swamp/data",
    ".swamp/workflow-runs",
    "workflows",
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

Deno.test(
  "workflow shell step: nested swamp command completes without deadlock (regression #296)",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    await withTempDir(async (repoDir) => {
      await initializeTestRepo(repoDir);

      // Create a shell model via the definition repository
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      const model = Definition.create({
        name: "nested-cmd",
        methods: { execute: { arguments: { run: "echo placeholder" } } },
      });
      await definitionRepo.save(SHELL_MODEL_TYPE, model);

      // Build the nested swamp command that the shell step will run.
      // `model search` calls requireInitializedRepoReadOnly which doesn't
      // acquire per-model locks, but the workflow run itself holds them.
      // The child process still passes through waitForPerModelLocks in
      // requireInitializedRepo if it's a structural command — but even
      // read-only commands validate the repo structure. Use `model search`
      // as a lightweight nested command that exercises the env var
      // propagation path.
      const denoPath = Deno.execPath();
      const nestedCmd = [
        denoPath,
        ...CLI_ARGS,
        "model",
        "search",
        "--repo-dir",
        repoDir,
        "--json",
      ].join(" ");

      // Create a workflow whose shell step runs the nested swamp command
      const workflowRepo = new YamlWorkflowRepository(repoDir);
      const workflow = Workflow.create({
        name: "subprocess-test",
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "nested-swamp",
                task: StepTask.model("nested-cmd", "execute", {
                  run: nestedCmd,
                }),
              }),
            ],
          }),
        ],
      });
      await workflowRepo.save(workflow);

      // Run the workflow with a 30s timeout to prevent CI hangs
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 30_000);

      try {
        const command = new Deno.Command(denoPath, {
          args: [
            ...CLI_ARGS,
            "workflow",
            "run",
            "subprocess-test",
            "--repo-dir",
            repoDir,
            "--log",
            "--skip-reports",
            "--skip-checks",
          ],
          stdout: "piped",
          stderr: "piped",
          cwd: Deno.cwd(),
          signal: abortController.signal,
        });

        const { code, stdout, stderr } = await command.output();
        const stdoutStr = new TextDecoder().decode(stdout);
        const stderrStr = new TextDecoder().decode(stderr);

        assertEquals(
          code,
          0,
          `workflow run should succeed without deadlock.\nstdout: ${stdoutStr}\nstderr: ${stderrStr}`,
        );

        const combined = stdoutStr + stderrStr;
        assertStringIncludes(
          combined,
          "Step started",
          "workflow should have started the step",
        );
      } finally {
        clearTimeout(timeoutId);
      }
    });
  },
);
