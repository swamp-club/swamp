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

import { assertStringIncludes } from "@std/assert/string-includes";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";

const PROJECT_ROOT = Deno.cwd();

async function runCli(
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", "dev", ...args],
    stdout: "piped",
    stderr: "piped",
    cwd: PROJECT_ROOT,
    env: {
      ...Deno.env.toObject(),
      SWAMP_NO_TELEMETRY: "1",
      ...env,
    },
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

/** Initialize a swamp repo in a temp directory. */
async function initTempRepo(): Promise<string> {
  const tmpDir = await Deno.makeTempDir();
  await runCli(["init", tmpDir]);
  return tmpDir;
}

Deno.test("extension push --help shows usage", async () => {
  const { stdout } = await runCli(["extension", "push", "--help"]);
  assertStringIncludes(stdout, "push");
  assertStringIncludes(stdout, "manifest-path");
});

Deno.test("extension --help shows subcommands", async () => {
  const { stdout } = await runCli(["extension", "--help"]);
  assertStringIncludes(stdout, "push");
  assertStringIncludes(stdout, "extension");
});

Deno.test("extension push with missing manifest file gives clear error", async () => {
  const tmpDir = await initTempRepo();
  try {
    const { stderr, code } = await runCli([
      "extension",
      "push",
      join(tmpDir, "nonexistent-manifest.yaml"),
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "not found");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension push with invalid manifest (no manifestVersion) gives clear error", async () => {
  const tmpDir = await initTempRepo();
  try {
    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        name: "@test/myext",
        version: "2026.02.26.1",
        models: ["model.ts"],
      }),
    );

    const { stderr, code } = await runCli([
      "extension",
      "push",
      manifestPath,
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "manifestVersion");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension push with invalid manifest (bad version) gives clear error", async () => {
  const tmpDir = await initTempRepo();
  try {
    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "1.0.0",
        models: ["model.ts"],
      }),
    );

    const { stderr, code } = await runCli([
      "extension",
      "push",
      manifestPath,
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "CalVer");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension push with invalid manifest (no models or workflows) gives clear error", async () => {
  const tmpDir = await initTempRepo();
  try {
    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.02.26.1",
      }),
    );

    const { stderr, code } = await runCli([
      "extension",
      "push",
      manifestPath,
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "at least one model, workflow, or vault");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension push without auth credentials gives clear error", async () => {
  const tmpDir = await initTempRepo();
  const fakeHome = await Deno.makeTempDir();
  try {
    // Create models directory and a model file
    const modelsDir = join(tmpDir, "extensions", "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    await Deno.writeTextFile(
      join(modelsDir, "model.ts"),
      "export const x = 1;\n",
    );

    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.02.26.1",
        models: ["model.ts"],
      }),
    );

    const { stderr, code } = await runCli(
      [
        "extension",
        "push",
        manifestPath,
        "--repo-dir",
        tmpDir,
        "--no-color",
      ],
      {
        HOME: fakeHome,
        XDG_CONFIG_HOME: join(fakeHome, ".config"),
      },
    );
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "Not authenticated");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    await Deno.remove(fakeHome, { recursive: true });
  }
});

Deno.test("extension push --dry-run archives multiple workflows with unique names", async () => {
  const tmpDir = await initTempRepo();
  try {
    // Create a minimal model (uses z from npm:zod@4 which is externalized)
    const modelsDir = join(tmpDir, "extensions", "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    await Deno.writeTextFile(
      join(modelsDir, "echo.ts"),
      [
        'import { z } from "npm:zod@4";',
        "export const model = {",
        '  type: "@test/echo",',
        '  version: "2026.02.27.1",',
        "  methods: {",
        "    run: {",
        '      description: "echo",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    // Create workflow YAML files in .swamp/workflows/ (the real files)
    const swampWfDir = join(tmpDir, ".swamp", "workflows");
    await Deno.mkdir(swampWfDir, { recursive: true });

    const wf1Content = stringifyYaml({
      id: "a0a0a0a0-1111-4111-a111-111111111111",
      name: "alpha-workflow",
      version: 1,
      jobs: [{
        name: "main",
        steps: [{
          name: "run",
          task: {
            type: "model_method",
            modelIdOrName: "echo",
            methodName: "run",
          },
          dependsOn: [],
          weight: 0,
        }],
        dependsOn: [],
        weight: 0,
      }],
    });
    const wf2Content = stringifyYaml({
      id: "b0b0b0b0-2222-4222-b222-222222222222",
      name: "beta-workflow",
      version: 1,
      jobs: [{
        name: "main",
        steps: [{
          name: "run",
          task: {
            type: "model_method",
            modelIdOrName: "echo",
            methodName: "run",
          },
          dependsOn: [],
          weight: 0,
        }],
        dependsOn: [],
        weight: 0,
      }],
    });
    const wf3Content = stringifyYaml({
      id: "c0c0c0c0-3333-4333-b333-333333333333",
      name: "gamma-workflow",
      version: 1,
      jobs: [{
        name: "main",
        steps: [{
          name: "run",
          task: {
            type: "model_method",
            modelIdOrName: "echo",
            methodName: "run",
          },
          dependsOn: [],
          weight: 0,
        }],
        dependsOn: [],
        weight: 0,
      }],
    });

    await Deno.writeTextFile(
      join(swampWfDir, "workflow-a0a0a0a0-1111-4111-a111-111111111111.yaml"),
      wf1Content,
    );
    await Deno.writeTextFile(
      join(swampWfDir, "workflow-b0b0b0b0-2222-4222-b222-222222222222.yaml"),
      wf2Content,
    );
    await Deno.writeTextFile(
      join(swampWfDir, "workflow-c0c0c0c0-3333-4333-b333-333333333333.yaml"),
      wf3Content,
    );

    // Create symlinks at workflows/{name}/workflow.yaml (like swamp's indexer)
    const workflowsDir = join(tmpDir, "workflows");
    for (
      const [name, id] of [
        ["alpha-workflow", "a0a0a0a0-1111-4111-a111-111111111111"],
        ["beta-workflow", "b0b0b0b0-2222-4222-b222-222222222222"],
        ["gamma-workflow", "c0c0c0c0-3333-4333-b333-333333333333"],
      ]
    ) {
      const dir = join(workflowsDir, name);
      await Deno.mkdir(dir, { recursive: true });
      await Deno.symlink(
        join(swampWfDir, `workflow-${id}.yaml`),
        join(dir, "workflow.yaml"),
      );
    }

    // Create auth.json
    const configDir = join(tmpDir, ".config", "swamp");
    await Deno.mkdir(configDir, { recursive: true });
    await Deno.writeTextFile(
      join(configDir, "auth.json"),
      JSON.stringify({
        serverUrl: "http://localhost:9999",
        apiKey: "swamp_test_key",
        apiKeyId: "key-id",
        username: "test",
      }),
    );

    // Create manifest with 3 workflows
    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/multi-wf",
        version: "2026.02.27.1",
        models: ["echo.ts"],
        workflows: [
          "alpha-workflow/workflow.yaml",
          "beta-workflow/workflow.yaml",
          "gamma-workflow/workflow.yaml",
        ],
      }),
    );

    // Run dry-run
    const { stdout, stderr, code } = await runCli(
      [
        "extension",
        "push",
        manifestPath,
        "--repo-dir",
        tmpDir,
        "--dry-run",
        "-y",
        "--no-color",
      ],
      {
        HOME: tmpDir,
        XDG_CONFIG_HOME: join(tmpDir, ".config"),
      },
    );

    const combined = stderr + "\n" + stdout;
    assertEquals(code, 0);

    // Verify all 3 workflows appear in the output
    assertStringIncludes(combined, "Workflows (3)");
    assertStringIncludes(combined, "Dry run complete");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension push safety hard errors block push", async () => {
  const tmpDir = await initTempRepo();
  try {
    // Create models directory and a model file with eval
    const modelsDir = join(tmpDir, "extensions", "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    await Deno.writeTextFile(
      join(modelsDir, "evil.ts"),
      'eval("alert(1)");\nexport const x = 1;\n',
    );

    // Create auth.json so we pass the auth check
    const configDir = join(tmpDir, ".config", "swamp");
    await Deno.mkdir(configDir, { recursive: true });
    await Deno.writeTextFile(
      join(configDir, "auth.json"),
      JSON.stringify({
        serverUrl: "http://localhost:9999",
        apiKey: "swamp_test_key",
        apiKeyId: "key-id",
        username: "test",
      }),
    );

    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/myext",
        version: "2026.02.26.1",
        models: ["evil.ts"],
      }),
    );

    const { stderr, code } = await runCli(
      [
        "extension",
        "push",
        manifestPath,
        "--repo-dir",
        tmpDir,
        "--no-color",
      ],
      {
        HOME: tmpDir,
        XDG_CONFIG_HOME: join(tmpDir, ".config"),
      },
    );
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "safety errors");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension push --dry-run respects custom modelsDir from .swamp.yaml", async () => {
  const tmpDir = await initTempRepo();
  try {
    // Set custom modelsDir in .swamp.yaml
    const markerPath = join(tmpDir, ".swamp.yaml");
    const markerContent = await Deno.readTextFile(markerPath);
    const { parse: parseYaml, stringify: yamlStringify } = await import(
      "@std/yaml"
    );
    const markerData = parseYaml(markerContent) as Record<string, unknown>;
    markerData.modelsDir = "custom/models";
    await Deno.writeTextFile(markerPath, yamlStringify(markerData));

    // Create model file in the CUSTOM directory (not extensions/models)
    const customModelsDir = join(tmpDir, "custom", "models");
    await Deno.mkdir(customModelsDir, { recursive: true });
    await Deno.writeTextFile(
      join(customModelsDir, "echo.ts"),
      [
        'import { z } from "npm:zod@4";',
        "export const model = {",
        '  type: "@test/echo",',
        '  version: "2026.02.27.1",',
        "  methods: {",
        "    run: {",
        '      description: "echo",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    // Create auth.json so we pass the auth check
    const configDir = join(tmpDir, ".config", "swamp");
    await Deno.mkdir(configDir, { recursive: true });
    await Deno.writeTextFile(
      join(configDir, "auth.json"),
      JSON.stringify({
        serverUrl: "http://localhost:9999",
        apiKey: "swamp_test_key",
        apiKeyId: "key-id",
        username: "test",
      }),
    );

    // Create manifest referencing the model
    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/custom-dir",
        version: "2026.02.27.1",
        models: ["echo.ts"],
      }),
    );

    // Run dry-run — should find the model in custom/models, not extensions/models
    const { stdout, stderr, code } = await runCli(
      [
        "extension",
        "push",
        manifestPath,
        "--repo-dir",
        tmpDir,
        "--dry-run",
        "-y",
        "--no-color",
      ],
      {
        HOME: tmpDir,
        XDG_CONFIG_HOME: join(tmpDir, ".config"),
      },
    );

    const combined = stderr + "\n" + stdout;
    assertEquals(code, 0, `Expected success but got:\n${combined}`);
    assertStringIncludes(combined, "Dry run complete");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension push --dry-run resolves workflows from extensions/workflows", async () => {
  const tmpDir = await initTempRepo();
  try {
    // Create a minimal model
    const modelsDir = join(tmpDir, "extensions", "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    await Deno.writeTextFile(
      join(modelsDir, "echo.ts"),
      [
        'import { z } from "npm:zod@4";',
        "export const model = {",
        '  type: "@test/echo",',
        '  version: "2026.02.27.1",',
        "  methods: {",
        "    run: {",
        '      description: "echo",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    // Create workflow directly in extensions/workflows/ (not the indexer dir)
    const extWfDir = join(tmpDir, "extensions", "workflows");
    await Deno.mkdir(extWfDir, { recursive: true });
    await Deno.writeTextFile(
      join(extWfDir, "ext-wf.yaml"),
      stringifyYaml({
        id: "d0d0d0d0-4444-4444-a444-444444444444",
        name: "ext-wf",
        version: 1,
        jobs: [{
          name: "main",
          steps: [{
            name: "run",
            task: {
              type: "model_method",
              modelIdOrName: "echo",
              methodName: "run",
            },
            dependsOn: [],
            weight: 0,
          }],
          dependsOn: [],
          weight: 0,
        }],
      }),
    );

    // Create auth.json
    const configDir = join(tmpDir, ".config", "swamp");
    await Deno.mkdir(configDir, { recursive: true });
    await Deno.writeTextFile(
      join(configDir, "auth.json"),
      JSON.stringify({
        serverUrl: "http://localhost:9999",
        apiKey: "swamp_test_key",
        apiKeyId: "key-id",
        username: "test",
      }),
    );

    // Create manifest referencing a workflow in extensions/workflows/
    const manifestPath = join(tmpDir, "manifest.yaml");
    await Deno.writeTextFile(
      manifestPath,
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/ext-wf-test",
        version: "2026.02.27.1",
        models: ["echo.ts"],
        workflows: ["ext-wf.yaml"],
      }),
    );

    // Run dry-run — should find the workflow in extensions/workflows/
    const { stdout, stderr, code } = await runCli(
      [
        "extension",
        "push",
        manifestPath,
        "--repo-dir",
        tmpDir,
        "--dry-run",
        "-y",
        "--no-color",
      ],
      {
        HOME: tmpDir,
        XDG_CONFIG_HOME: join(tmpDir, ".config"),
      },
    );

    const combined = stderr + "\n" + stdout;
    assertEquals(code, 0, `Expected success but got:\n${combined}`);
    assertStringIncludes(combined, "Workflows (1)");
    assertStringIncludes(combined, "Dry run complete");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
