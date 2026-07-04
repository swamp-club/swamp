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
 * Integration test for issue #932: dynamic object expressions for workflow
 * task inputs/globalArgs.
 *
 * Verifies the full execution path: YAML load → evaluate → forEach expand →
 * execute, where task.inputs and task.globalArgs are CEL expressions that
 * evaluate to records at runtime.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { CLI_ARGS } from "./test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-dyn-inputs-" });
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
    ".swamp/workflows-evaluated",
  ];
  for (const subdir of subdirs) {
    await ensureDir(join(repoDir, subdir));
  }
  await Deno.writeTextFile(
    join(repoDir, ".swamp.yaml"),
    stringifyYaml(
      {
        swampVersion: "0.0.0",
        initializedAt: new Date().toISOString(),
      } as Record<string, unknown>,
    ),
  );
}

async function createShellModel(
  repoDir: string,
  name: string,
  command: string,
): Promise<void> {
  const modelData = {
    type: "command/shell",
    typeVersion: 1,
    id: crypto.randomUUID(),
    name,
    version: 1,
    tags: {},
    globalArguments: {},
    methods: { run: { arguments: { run: command } } },
  };
  const modelDir = join(repoDir, "models/command/shell");
  await ensureDir(modelDir);
  await Deno.writeTextFile(
    join(modelDir, `${modelData.id}.yaml`),
    stringifyYaml(modelData as Record<string, unknown>),
  );
}

async function writeWorkflow(
  repoDir: string,
  workflow: Record<string, unknown>,
): Promise<void> {
  const workflowDir = join(repoDir, "workflows");
  await ensureDir(workflowDir);
  await Deno.writeTextFile(
    join(workflowDir, `workflow-${workflow.id}.yaml`),
    stringifyYaml(workflow),
  );
}

async function runCliCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [...CLI_ARGS, ...args],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  });
  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

Deno.test("CLI: forEach with dynamic expression inputs resolves and executes", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createShellModel(repoDir, "svc-a", "echo 'hello from a'");
    await createShellModel(repoDir, "svc-b", "echo 'hello from b'");

    await writeWorkflow(repoDir, {
      id: crypto.randomUUID(),
      name: "dynamic-dispatch",
      version: 1,
      inputs: {
        properties: {
          items: { type: "array" },
        },
        required: ["items"],
      },
      jobs: [
        {
          name: "dispatch",
          steps: [
            {
              name: "run-${{ self.item.name }}",
              forEach: {
                item: "item",
                in: "${{ inputs.items }}",
              },
              task: {
                type: "model_method",
                modelIdOrName: "${{ self.item.modelName }}",
                methodName: "execute",
                inputs: "${{ self.item.inputs }}",
              },
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    });

    const items = [
      { name: "svc-a", modelName: "svc-a", inputs: { run: "echo 'a'" } },
      { name: "svc-b", modelName: "svc-b", inputs: { run: "echo 'b'" } },
    ];
    const result = await runCliCommand([
      "workflow",
      "run",
      "dynamic-dispatch",
      "--repo-dir",
      repoDir,
      "--input",
      JSON.stringify({ items }),
      "--json",
      "--skip-reports",
    ]);

    assertEquals(
      result.code,
      0,
      `Workflow should succeed. stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs[0].steps.length, 2);
    assertEquals(output.jobs[0].steps[0].name, "run-svc-a");
    assertEquals(output.jobs[0].steps[1].name, "run-svc-b");
    assertEquals(output.jobs[0].steps[0].status, "succeeded");
    assertEquals(output.jobs[0].steps[1].status, "succeeded");
  });
});

Deno.test("CLI: workflow with literal record inputs still works (backwards compat)", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createShellModel(repoDir, "my-model", "echo 'literal ran'");

    await writeWorkflow(repoDir, {
      id: crypto.randomUUID(),
      name: "literal-inputs",
      version: 1,
      jobs: [
        {
          name: "main",
          steps: [
            {
              name: "echo-step",
              task: {
                type: "model_method",
                modelIdOrName: "my-model",
                methodName: "execute",
                inputs: { run: "echo 'backwards compat'" },
              },
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    });

    const result = await runCliCommand([
      "workflow",
      "run",
      "literal-inputs",
      "--repo-dir",
      repoDir,
      "--json",
      "--skip-reports",
    ]);

    assertEquals(
      result.code,
      0,
      `Workflow should succeed. stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );

    const output = JSON.parse(result.stdout);
    assertEquals(output.status, "succeeded");
    assertEquals(output.jobs[0].steps[0].status, "succeeded");
  });
});

Deno.test("CLI: dynamic expression inputs that evaluate to non-record fails", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createShellModel(repoDir, "my-model", "echo 'should not run'");

    await writeWorkflow(repoDir, {
      id: crypto.randomUUID(),
      name: "bad-expression",
      version: 1,
      inputs: {
        properties: {
          items: { type: "array" },
        },
        required: ["items"],
      },
      jobs: [
        {
          name: "dispatch",
          steps: [
            {
              name: "run-${{ self.item.name }}",
              forEach: {
                item: "item",
                in: "${{ inputs.items }}",
              },
              task: {
                type: "model_method",
                modelIdOrName: "my-model",
                methodName: "execute",
                inputs: "${{ self.item.badField }}",
              },
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    });

    const items = [
      { name: "test", badField: "i-am-a-string-not-a-record" },
    ];
    const result = await runCliCommand([
      "workflow",
      "run",
      "bad-expression",
      "--repo-dir",
      repoDir,
      "--input",
      JSON.stringify({ items }),
      "--json",
      "--skip-reports",
    ]);

    // Should fail — expression resolves to a plain string which fails
    // schema re-validation after forEach expansion (not a valid expression
    // pattern and not a record)
    assertEquals(result.code, 1);
  });
});
