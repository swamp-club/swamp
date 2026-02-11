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
 * Integration tests for forEach iteration in workflows.
 *
 * Tests the forEach feature:
 * - Iteration over arrays
 * - Iteration over objects (key/value pairs)
 * - Step name interpolation with self.{item}
 * - Input validation for array items
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-foreach-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function initializeTestRepo(repoDir: string): Promise<void> {
  const subdirs = [
    ".swamp/definitions",
    ".swamp/outputs",
    ".swamp/data",
    ".swamp/logs",
    ".swamp/workflows",
    ".swamp/workflow-runs",
    ".swamp/workflows-evaluated",
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

async function createEchoModel(repoDir: string, name: string): Promise<void> {
  const modelData = {
    type: "swamp/echo",
    typeVersion: 1,
    id: crypto.randomUUID(),
    name,
    version: 1,
    tags: {},
    globalArguments: {},
    methods: {
      write: {
        arguments: {
          message: "default",
        },
      },
    },
  };

  const modelDir = join(repoDir, ".swamp/definitions/swamp/echo");
  await ensureDir(modelDir);
  await Deno.writeTextFile(
    join(modelDir, `${modelData.id}.yaml`),
    stringifyYaml(modelData as Record<string, unknown>),
  );
}

// Test 4: forEach Iteration Over Array

Deno.test("CLI: workflow with forEach over array creates multiple steps", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "echo-model");
    await createEchoModel(repoDir, "test-model");

    // Create workflow with forEach over array
    const workflowData = {
      id: crypto.randomUUID(),
      name: "test-foreach-array",
      version: 1,
      inputs: {
        properties: {
          environments: {
            type: "array",
            items: {
              type: "string",
            },
            minItems: 1,
          },
        },
        required: ["environments"],
      },
      jobs: [
        {
          name: "deploy-job",
          steps: [
            {
              name: "deploy-${{self.env}}",
              forEach: {
                item: "env",
                in: "${{ inputs.environments }}",
              },
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "write",
              },
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    };

    const workflowDir = join(repoDir, ".swamp/workflows");
    await ensureDir(workflowDir);
    await Deno.writeTextFile(
      join(workflowDir, `workflow-${workflowData.id}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "test-foreach-array",
        "--repo-dir",
        repoDir,
        "--input",
        '{"environments": ["dev", "staging", "production"]}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);

    // Parse the output and verify steps were expanded
    const output = JSON.parse(result.stdout);
    const job = output.jobs?.find(
      (j: { name: string }) => j.name === "deploy-job",
    );

    // There should be 3 expanded steps
    if (job?.steps) {
      assertEquals(job.steps.length >= 3, true, "Should have at least 3 steps");
    }
  });
});

Deno.test("CLI: workflow with forEach single item array", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "echo-single");
    await createEchoModel(repoDir, "test-model");

    const workflowData = {
      id: crypto.randomUUID(),
      name: "test-foreach-single",
      version: 1,
      inputs: {
        properties: {
          items: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["items"],
      },
      jobs: [
        {
          name: "process-job",
          steps: [
            {
              name: "process-${{self.item}}",
              forEach: {
                item: "item",
                in: "${{ inputs.items }}",
              },
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "write",
              },
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    };

    const workflowDir = join(repoDir, ".swamp/workflows");
    await ensureDir(workflowDir);
    await Deno.writeTextFile(
      join(workflowDir, `workflow-${workflowData.id}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "test-foreach-single",
        "--repo-dir",
        repoDir,
        "--input",
        '{"items": ["only-one"]}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
  });
});

Deno.test("CLI: workflow with forEach validates array minItems", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const workflowData = {
      id: crypto.randomUUID(),
      name: "test-foreach-minitems",
      version: 1,
      inputs: {
        properties: {
          environments: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
          },
        },
        required: ["environments"],
      },
      jobs: [
        {
          name: "job1",
          steps: [
            {
              name: "step-${{self.env}}",
              forEach: {
                item: "env",
                in: "${{ inputs.environments }}",
              },
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "write",
              },
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    };

    const workflowDir = join(repoDir, ".swamp/workflows");
    await ensureDir(workflowDir);
    await Deno.writeTextFile(
      join(workflowDir, `workflow-${workflowData.id}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "test-foreach-minitems",
        "--repo-dir",
        repoDir,
        "--input",
        '{"environments": []}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code !== 0, true, "Should fail for empty array");
    assertStringIncludes(result.stderr, "at least 1 item");
  });
});

// Test 5: forEach Iteration Over Object

Deno.test("CLI: workflow with forEach over object", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "test-model");

    const workflowData = {
      id: crypto.randomUUID(),
      name: "test-foreach-object",
      version: 1,
      inputs: {
        properties: {
          tags: {
            type: "object",
            additionalProperties: {
              type: "string",
            },
          },
        },
        required: ["tags"],
      },
      jobs: [
        {
          name: "apply-tags",
          steps: [
            {
              name: "apply-tag-${{self.tag.key}}",
              forEach: {
                item: "tag",
                in: "${{ inputs.tags }}",
              },
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "write",
              },
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    };

    const workflowDir = join(repoDir, ".swamp/workflows");
    await ensureDir(workflowDir);
    await Deno.writeTextFile(
      join(workflowDir, `workflow-${workflowData.id}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "test-foreach-object",
        "--repo-dir",
        repoDir,
        "--input",
        '{"tags": {"env": "prod", "team": "platform"}}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
  });
});

Deno.test("CLI: workflow with forEach over empty object succeeds", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const workflowData = {
      id: crypto.randomUUID(),
      name: "test-foreach-empty-object",
      version: 1,
      inputs: {
        properties: {
          tags: {
            type: "object",
          },
        },
        required: ["tags"],
      },
      jobs: [
        {
          name: "apply-tags",
          steps: [
            {
              name: "apply-tag-${{self.tag.key}}",
              forEach: {
                item: "tag",
                in: "${{ inputs.tags }}",
              },
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "write",
              },
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    };

    const workflowDir = join(repoDir, ".swamp/workflows");
    await ensureDir(workflowDir);
    await Deno.writeTextFile(
      join(workflowDir, `workflow-${workflowData.id}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "test-foreach-empty-object",
        "--repo-dir",
        repoDir,
        "--input",
        '{"tags": {}}',
        "--json",
      ],
      Deno.cwd(),
    );

    // Empty object should result in 0 expanded steps, but not fail
    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
  });
});

// Mixed forEach and regular steps

Deno.test("CLI: workflow with mixed forEach and regular steps", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createEchoModel(repoDir, "test-model");

    const workflowData = {
      id: crypto.randomUUID(),
      name: "test-foreach-mixed",
      version: 1,
      inputs: {
        properties: {
          environments: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["environments"],
      },
      jobs: [
        {
          name: "deploy-job",
          steps: [
            {
              name: "prepare",
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "write",
              },
              dependsOn: [],
              weight: 0,
            },
            {
              name: "deploy-${{self.env}}",
              forEach: {
                item: "env",
                in: "${{ inputs.environments }}",
              },
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "write",
              },
              dependsOn: [
                {
                  step: "prepare",
                  condition: { type: "succeeded" },
                },
              ],
              weight: 0,
            },
            {
              name: "cleanup",
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "write",
              },
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    };

    const workflowDir = join(repoDir, ".swamp/workflows");
    await ensureDir(workflowDir);
    await Deno.writeTextFile(
      join(workflowDir, `workflow-${workflowData.id}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "run",
        "test-foreach-mixed",
        "--repo-dir",
        repoDir,
        "--input",
        '{"environments": ["dev", "prod"]}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);
  });
});
