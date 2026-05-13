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

import { assertEquals, assertNotMatch } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { CLI_ARGS } from "./test_helpers.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import {
  YamlWorkflowRepository,
} from "../src/infrastructure/persistence/yaml_workflow_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "swamp-direct-type-exec-",
  });
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
    args: [...CLI_ARGS, ...args],
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

const EXTENSION_MODEL_CODE = `
import { z } from "npm:zod@4";

export const model = {
  type: "@user/direct-exec-fixture",
  version: "2026.01.01.1",
  methods: {
    ping: {
      description: "Returns a fixed greeting",
      arguments: z.object({
        name: z.string().default("world"),
      }),
      execute: async (args) => {
        return { message: "hello " + args.name };
      },
    },
  },
};
`;

// Regression test for swamp-club#349: direct type execution with @-prefixed
// types must resolve locally without falling through to the auto-resolver.
Deno.test("direct type execution: model @type resolves local extension without auto-resolver cascade", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const extDir = join(repoDir, "extensions", "models");
    await ensureDir(extDir);
    await Deno.writeTextFile(
      join(extDir, "direct_exec_fixture.ts"),
      EXTENSION_MODEL_CODE,
    );

    const { code, stderr } = await runCliCommand(
      [
        "model",
        "@user/direct-exec-fixture",
        "method",
        "run",
        "ping",
        "fixture-instance",
        "--input",
        "name=test",
        "--repo-dir",
        repoDir,
      ],
      repoDir,
    );

    assertNotMatch(
      stderr,
      /not found locally.*searching registry/i,
      "Auto-resolver should not be triggered for a locally-defined @-prefixed type",
    );
    assertEquals(code, 0, `Direct type execution failed: ${stderr}`);
  });
});

// Regression test for the same @-stripping bug in the workflow direct type
// resolver (workflow_run.ts). A workflow step with modelType: "@user/..."
// must resolve locally without cascading to the auto-resolver.
Deno.test("direct type execution: workflow step with @type resolves local extension without auto-resolver cascade", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const extDir = join(repoDir, "extensions", "models");
    await ensureDir(extDir);
    await Deno.writeTextFile(
      join(extDir, "direct_exec_fixture.ts"),
      EXTENSION_MODEL_CODE,
    );

    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const workflow = Workflow.create({
      name: "direct-type-workflow",
      jobs: [
        Job.create({
          name: "direct-job",
          steps: [
            Step.create({
              name: "direct-step",
              task: StepTask.directExecution(
                "@user/direct-exec-fixture",
                "wf-fixture-instance",
                "ping",
                { name: "workflow" },
              ),
            }),
          ],
        }),
      ],
    });
    await workflowRepo.save(workflow);

    const { code, stderr } = await runCliCommand(
      [
        "workflow",
        "run",
        "direct-type-workflow",
        "--repo-dir",
        repoDir,
      ],
      repoDir,
    );

    assertNotMatch(
      stderr,
      /not found locally.*searching registry/i,
      "Auto-resolver should not be triggered for a locally-defined @-prefixed type in workflow steps",
    );
    assertEquals(
      code,
      0,
      `Workflow with direct type execution failed: ${stderr}`,
    );
  });
});
