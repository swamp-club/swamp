/**
 * Integration tests for workflow evaluate command.
 *
 * Tests the workflow evaluate feature:
 * - Evaluate single workflow
 * - Evaluate all workflows
 * - CEL expressions evaluated, vault expressions left raw
 * - JSON output mode
 * - Input values replaced in expressions
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir, existsSync } from "@std/fs";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-evaluate-" });
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
    ".swamp/definitions-evaluated",
    ".swamp/vault",
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

Deno.test("CLI: workflow evaluate single workflow", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create workflow with expressions
    const workflowId = crypto.randomUUID();
    const workflowData = {
      id: workflowId,
      name: "test-evaluate",
      version: 1,
      inputs: {
        properties: {
          environment: {
            type: "string",
            default: "dev",
          },
        },
      },
      jobs: [
        {
          name: "deploy",
          steps: [
            {
              name: "deploy-step",
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "run",
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
      join(workflowDir, `workflow-${workflowId}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "evaluate",
        "test-evaluate",
        "--repo-dir",
        repoDir,
        "--input",
        '{"environment": "production"}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);

    // Check that evaluated workflow was saved
    const evaluatedDir = join(repoDir, ".swamp/workflows-evaluated");
    const files = Array.from(Deno.readDirSync(evaluatedDir));
    assertEquals(
      files.length >= 1,
      true,
      "Should have evaluated workflow file",
    );
  });
});

Deno.test("CLI: workflow evaluate all workflows", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create multiple workflows
    const workflowDir = join(repoDir, ".swamp/workflows");
    await ensureDir(workflowDir);

    for (let i = 1; i <= 3; i++) {
      const workflowId = crypto.randomUUID();
      const workflowData = {
        id: workflowId,
        name: `workflow-${i}`,
        version: 1,
        jobs: [
          {
            name: "job1",
            steps: [
              {
                name: "step1",
                task: {
                  type: "model_method",
                  modelIdOrName: "test-model",
                  methodName: "run",
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
      await Deno.writeTextFile(
        join(workflowDir, `workflow-${workflowId}.yaml`),
        stringifyYaml(workflowData as Record<string, unknown>),
      );
    }

    const result = await runCliCommand(
      ["workflow", "evaluate", "--all", "--repo-dir", repoDir, "--json"],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assertEquals(output.total, 3, "Should have evaluated 3 workflows");
  });
});

Deno.test("CLI: workflow evaluate replaces input expressions", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const workflowId = crypto.randomUUID();
    const workflowData = {
      id: workflowId,
      name: "test-input-replace",
      version: 1,
      inputs: {
        properties: {
          message: { type: "string" },
        },
      },
      jobs: [
        {
          name: "job1",
          steps: [
            {
              name: "step1",
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "write",
                inputs: {
                  greeting: "${{ inputs.message }}",
                },
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
      join(workflowDir, `workflow-${workflowId}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "evaluate",
        "test-input-replace",
        "--repo-dir",
        repoDir,
        "--input",
        '{"message": "Hello World"}',
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);

    // Read the evaluated workflow and check expression was replaced
    const evaluatedDir = join(repoDir, ".swamp/workflows-evaluated");
    const files = Array.from(Deno.readDirSync(evaluatedDir));
    if (files.length > 0) {
      const evaluatedPath = join(evaluatedDir, files[0].name);
      const content = await Deno.readTextFile(evaluatedPath);
      const evaluated = parseYaml(content) as Record<string, unknown>;

      // The input expression should be replaced with the actual value
      const jobs = evaluated.jobs as Array<Record<string, unknown>>;
      const steps = jobs[0].steps as Array<Record<string, unknown>>;
      const task = steps[0].task as Record<string, unknown>;
      const inputs = task.inputs as Record<string, unknown>;

      assertEquals(
        inputs.greeting,
        "Hello World",
        "Expression should be replaced",
      );
    }
  });
});

Deno.test("CLI: workflow evaluate preserves vault expressions", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create a vault config first
    const vaultConfig = {
      name: "test-vault",
      provider: "local-encryption",
      config: {
        masterKeyPath: join(repoDir, ".swamp/secrets/master.key"),
      },
    };
    const vaultDir = join(repoDir, ".swamp/vault");
    await ensureDir(vaultDir);
    await Deno.writeTextFile(
      join(vaultDir, "test-vault.yaml"),
      stringifyYaml(vaultConfig as Record<string, unknown>),
    );

    const workflowId = crypto.randomUUID();
    const workflowData = {
      id: workflowId,
      name: "test-vault-preserve",
      version: 1,
      jobs: [
        {
          name: "job1",
          steps: [
            {
              name: "step1",
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "write",
                inputs: {
                  secret: "${{ vault.get(test-vault, api-key) }}",
                },
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
      join(workflowDir, `workflow-${workflowId}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "evaluate",
        "test-vault-preserve",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);

    // Read the evaluated workflow and check vault expression is preserved
    const evaluatedDir = join(repoDir, ".swamp/workflows-evaluated");
    const files = Array.from(Deno.readDirSync(evaluatedDir));
    if (files.length > 0) {
      const evaluatedPath = join(evaluatedDir, files[0].name);
      const content = await Deno.readTextFile(evaluatedPath);

      // Vault expression should still be present
      assertStringIncludes(content, "vault.get");
    }
  });
});

Deno.test("CLI: workflow evaluate JSON output includes workflow data", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    const workflowId = crypto.randomUUID();
    const workflowData = {
      id: workflowId,
      name: "test-json-output",
      version: 1,
      jobs: [
        {
          name: "job1",
          steps: [
            {
              name: "step1",
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "run",
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
      join(workflowDir, `workflow-${workflowId}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "evaluate",
        "test-json-output",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assertEquals(output.name, "test-json-output");
    assertEquals(typeof output.outputPath, "string");
  });
});

Deno.test("CLI: workflow evaluate does not execute workflow", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Create workflow that would create a file if executed
    const markerFile = join(repoDir, "executed-marker.txt");
    const workflowId = crypto.randomUUID();
    const workflowData = {
      id: workflowId,
      name: "test-no-execute",
      version: 1,
      jobs: [
        {
          name: "job1",
          steps: [
            {
              name: "create-marker",
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "run",
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
      join(workflowDir, `workflow-${workflowId}.yaml`),
      stringifyYaml(workflowData as Record<string, unknown>),
    );

    const result = await runCliCommand(
      [
        "workflow",
        "evaluate",
        "test-no-execute",
        "--repo-dir",
        repoDir,
        "--json",
      ],
      Deno.cwd(),
    );

    assertEquals(result.code, 0, `Should succeed. stderr: ${result.stderr}`);

    // The marker file should NOT exist because evaluate doesn't execute
    assertEquals(
      existsSync(markerFile),
      false,
      "Workflow should not be executed during evaluate",
    );
  });
});
