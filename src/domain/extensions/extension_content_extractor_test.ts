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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { extractContentMetadata } from "./extension_content_extractor.ts";

Deno.test("extractContentMetadata returns empty for no inputs", async () => {
  const result = await extractContentMetadata([], "/tmp/models", []);
  assertEquals(result, {
    models: [],
    workflows: [],
    vaults: [],
    drivers: [],
    datastores: [],
    reports: [],
  });
});

Deno.test("extractContentMetadata extracts model type from ModelType.create", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "instance.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { ModelType } from "../../model_type.ts";',
        'const MY_TYPE = ModelType.create("aws/ec2-instance");',
        "export const model = {",
        "  type: MY_TYPE,",
        '  version: "2026.03.01.1",',
        "  methods: {",
        "    start: {",
        '      description: "Start the EC2 instance",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    assertEquals(result.models.length, 1);
    assertEquals(result.models[0].type, "aws/ec2-instance");
    assertEquals(result.models[0].version, "2026.03.01.1");
    assertEquals(result.models[0].fileName, "instance.ts");
    assertEquals(result.models[0].globalArguments, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts model type from string literal", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "echo.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { z } from "npm:zod@4";',
        "export const model = {",
        '  type: "@test/echo",',
        '  version: "2026.02.27.1",',
        "  methods: {",
        "    run: {",
        '      description: "Run echo",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    assertEquals(result.models.length, 1);
    assertEquals(result.models[0].type, "@test/echo");
    assertEquals(result.models[0].version, "2026.02.27.1");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts methods with descriptions", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "ec2.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { z } from "npm:zod@4";',
        "export const model = {",
        '  type: "aws/ec2",',
        '  version: "2026.03.01.1",',
        "  methods: {",
        "    start: {",
        '      description: "Start the instance",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "    stop: {",
        '      description: "Stop the instance",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    assertEquals(result.models[0].methods.length, 2);
    assertEquals(result.models[0].methods[0].name, "start");
    assertEquals(
      result.models[0].methods[0].description,
      "Start the instance",
    );
    assertEquals(result.models[0].methods[1].name, "stop");
    assertEquals(result.models[0].methods[1].description, "Stop the instance");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts method arguments from inline z.object", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "shell.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { z } from "npm:zod@4";',
        "export const model = {",
        '  type: "command/shell",',
        '  version: "2026.02.09.1",',
        "  methods: {",
        "    execute: {",
        '      description: "Execute a shell command",',
        "      arguments: z.object({",
        '        run: z.string().min(1).describe("The command to execute"),',
        '        workingDir: z.string().optional().describe("Working directory"),',
        "      }),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    const method = result.models[0].methods[0];
    assertEquals(method.arguments.length, 2);
    assertEquals(method.arguments[0].name, "run");
    assertEquals(method.arguments[0].type, "string");
    assertEquals(method.arguments[0].description, "The command to execute");
    assertEquals(method.arguments[0].required, true);
    assertEquals(method.arguments[1].name, "workingDir");
    assertEquals(method.arguments[1].type, "string");
    assertEquals(method.arguments[1].required, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts method arguments from named schema", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "model.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { z } from "npm:zod@4";',
        "const InputSchema = z.object({",
        '  name: z.string().describe("Resource name"),',
        '  count: z.number().optional().describe("Instance count"),',
        "});",
        "export const model = {",
        '  type: "test/named-args",',
        '  version: "2026.03.01.1",',
        "  methods: {",
        "    create: {",
        '      description: "Create resource",',
        "      arguments: InputSchema,",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    const method = result.models[0].methods[0];
    assertEquals(method.arguments.length, 2);
    assertEquals(method.arguments[0].name, "name");
    assertEquals(method.arguments[0].type, "string");
    assertEquals(method.arguments[0].required, true);
    assertEquals(method.arguments[1].name, "count");
    assertEquals(method.arguments[1].type, "number");
    assertEquals(method.arguments[1].required, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts resources", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "model.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { z } from "npm:zod@4";',
        "export const model = {",
        '  type: "test/resources",',
        '  version: "2026.03.01.1",',
        "  resources: {",
        '    "result": {',
        '      description: "Execution result",',
        "      schema: z.object({}),",
        '      lifetime: "infinite",',
        "      garbageCollection: 10,",
        "    },",
        "  },",
        "  methods: {",
        "    run: {",
        '      description: "Run",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    assertEquals(result.models[0].resources.length, 1);
    assertEquals(result.models[0].resources[0].key, "result");
    assertEquals(
      result.models[0].resources[0].description,
      "Execution result",
    );
    assertEquals(result.models[0].resources[0].lifetime, "infinite");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts files", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "model.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { z } from "npm:zod@4";',
        "export const model = {",
        '  type: "test/files",',
        '  version: "2026.03.01.1",',
        "  files: {",
        '    "log": {',
        '      description: "Command output log",',
        '      contentType: "text/plain",',
        '      lifetime: "infinite",',
        "      garbageCollection: 10,",
        "    },",
        "  },",
        "  methods: {",
        "    run: {",
        '      description: "Run",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    assertEquals(result.models[0].files.length, 1);
    assertEquals(result.models[0].files[0].key, "log");
    assertEquals(result.models[0].files[0].description, "Command output log");
    assertEquals(result.models[0].files[0].contentType, "text/plain");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata skips model without type", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "helper.ts");
    await Deno.writeTextFile(
      modelFile,
      "export const helper = () => 42;\n",
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    assertEquals(result.models.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata parses workflow YAML", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const wfFile = join(tmpDir, "workflow.yaml");
    await Deno.writeTextFile(
      wfFile,
      stringifyYaml({
        id: "abc-123",
        name: "test-workflow",
        description: "A test workflow",
        version: 1,
        jobs: [{
          name: "main-job",
          description: "The main job",
          steps: [{
            name: "step-one",
            description: "First step",
            task: {
              type: "model_method",
              modelIdOrName: "my-model",
              methodName: "execute",
            },
          }],
        }],
      }),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [{ sourcePath: wfFile, archiveName: "workflow.yaml" }],
    );
    assertEquals(result.workflows.length, 1);
    assertEquals(result.workflows[0].fileName, "workflow.yaml");
    assertEquals(result.workflows[0].id, "abc-123");
    assertEquals(result.workflows[0].name, "test-workflow");
    assertEquals(result.workflows[0].description, "A test workflow");
    assertEquals(result.workflows[0].jobs.length, 1);
    assertEquals(result.workflows[0].jobs[0].name, "main-job");
    assertEquals(result.workflows[0].jobs[0].description, "The main job");
    assertEquals(result.workflows[0].jobs[0].steps.length, 1);
    assertEquals(result.workflows[0].jobs[0].steps[0].name, "step-one");
    assertEquals(result.workflows[0].jobs[0].steps[0].taskType, "model_method");
    assertEquals(
      result.workflows[0].jobs[0].steps[0].modelIdOrName,
      "my-model",
    );
    assertEquals(result.workflows[0].jobs[0].steps[0].methodName, "execute");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata parses workflow with multiple jobs and steps", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const wfFile = join(tmpDir, "multi.yaml");
    await Deno.writeTextFile(
      wfFile,
      stringifyYaml({
        id: "multi-123",
        name: "multi-workflow",
        description: "Multi-job workflow",
        version: 1,
        jobs: [
          {
            name: "setup",
            description: "Setup phase",
            steps: [
              {
                name: "init",
                description: "Initialize",
                task: {
                  type: "model_method",
                  modelIdOrName: "setup-model",
                  methodName: "init",
                },
              },
            ],
          },
          {
            name: "deploy",
            description: "Deploy phase",
            steps: [
              {
                name: "build",
                description: "Build artifacts",
                task: {
                  type: "model_method",
                  modelIdOrName: "build-model",
                  methodName: "build",
                },
              },
              {
                name: "push",
                description: "Push to registry",
                task: {
                  type: "model_method",
                  modelIdOrName: "push-model",
                  methodName: "push",
                },
              },
            ],
          },
        ],
      }),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [{ sourcePath: wfFile, archiveName: "multi.yaml" }],
    );
    assertEquals(result.workflows[0].fileName, "multi.yaml");
    assertEquals(result.workflows[0].jobs.length, 2);
    assertEquals(result.workflows[0].jobs[0].steps.length, 1);
    assertEquals(result.workflows[0].jobs[1].steps.length, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata skips unparseable files gracefully", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    // A good model file
    const goodModel = join(modelsDir, "good.ts");
    await Deno.writeTextFile(
      goodModel,
      [
        "export const model = {",
        '  type: "test/good",',
        '  version: "2026.03.01.1",',
        "  methods: {",
        "    run: {",
        '      description: "Run",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    // A nonexistent file path
    const badModel = join(modelsDir, "nonexistent.ts");

    // A good workflow
    const goodWf = join(tmpDir, "good.yaml");
    await Deno.writeTextFile(
      goodWf,
      stringifyYaml({
        id: "wf-1",
        name: "good-workflow",
        version: 1,
        jobs: [{
          name: "main",
          steps: [{
            name: "run",
            task: {
              type: "model_method",
              modelIdOrName: "m",
              methodName: "r",
            },
          }],
        }],
      }),
    );

    // A bad workflow (nonexistent file)
    const badWf = join(tmpDir, "nonexistent.yaml");

    const result = await extractContentMetadata(
      [goodModel, badModel],
      modelsDir,
      [
        { sourcePath: goodWf, archiveName: "good.yaml" },
        { sourcePath: badWf, archiveName: "bad.yaml" },
      ],
    );

    // Should have partial results — the good files are extracted
    assertEquals(result.models.length, 1);
    assertEquals(result.models[0].type, "test/good");
    assertEquals(result.workflows.length, 1);
    assertEquals(result.workflows[0].fileName, "good.yaml");
    assertEquals(result.workflows[0].name, "good-workflow");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata preserves relative path for nested models", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    const subDir = join(modelsDir, "aws", "ec2");
    await Deno.mkdir(subDir, { recursive: true });

    const modelFile = join(subDir, "instance.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        "export const model = {",
        '  type: "aws/ec2-instance",',
        '  version: "2026.03.01.1",',
        "  methods: {",
        "    start: {",
        '      description: "Start",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    assertEquals(result.models[0].fileName, "aws/ec2/instance.ts");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata handles nested parens in zod types like z.record", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "model.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { z } from "npm:zod@4";',
        "export const model = {",
        '  type: "test/nested-parens",',
        '  version: "2026.03.01.1",',
        "  methods: {",
        "    run: {",
        '      description: "Run it",',
        "      arguments: z.object({",
        '        name: z.string().describe("The name"),',
        '        env: z.record(z.string(), z.string()).optional().describe("Environment vars"),',
        "      }),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    const method = result.models[0].methods[0];
    assertEquals(method.arguments.length, 2);
    assertEquals(method.arguments[0].name, "name");
    assertEquals(method.arguments[0].required, true);
    assertEquals(method.arguments[1].name, "env");
    assertEquals(method.arguments[1].type, "record");
    assertEquals(method.arguments[1].description, "Environment vars");
    assertEquals(method.arguments[1].required, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata skips workflow YAML without name", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const wfFile = join(tmpDir, "bad-wf.yaml");
    await Deno.writeTextFile(
      wfFile,
      stringifyYaml({
        id: "no-name",
        version: 1,
        jobs: [],
      }),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [{ sourcePath: wfFile, archiveName: "bad-wf.yaml" }],
    );
    assertEquals(result.workflows.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts globalArguments from inline z.object", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "model.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { z } from "npm:zod@4";',
        "export const model = {",
        '  type: "test/global-args",',
        '  version: "2026.03.01.1",',
        "  globalArguments: z.object({",
        '    region: z.string().describe("AWS region"),',
        '    profile: z.string().optional().describe("AWS profile"),',
        "  }),",
        "  methods: {",
        "    run: {",
        '      description: "Run",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    assertEquals(result.models[0].globalArguments.length, 2);
    assertEquals(result.models[0].globalArguments[0].name, "region");
    assertEquals(result.models[0].globalArguments[0].type, "string");
    assertEquals(result.models[0].globalArguments[0].required, true);
    assertEquals(result.models[0].globalArguments[1].name, "profile");
    assertEquals(result.models[0].globalArguments[1].required, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts globalArguments from named schema reference", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "model.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { z } from "npm:zod@4";',
        "const GlobalArgs = z.object({",
        '  accountId: z.string().describe("AWS account ID"),',
        "});",
        "export const model = {",
        '  type: "test/named-global",',
        '  version: "2026.03.01.1",',
        "  globalArguments: GlobalArgs,",
        "  methods: {",
        "    run: {",
        '      description: "Run",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    assertEquals(result.models[0].globalArguments.length, 1);
    assertEquals(result.models[0].globalArguments[0].name, "accountId");
    assertEquals(result.models[0].globalArguments[0].type, "string");
    assertEquals(
      result.models[0].globalArguments[0].description,
      "AWS account ID",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts vault type, name, and description", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const vaultsDir = join(tmpDir, "vaults");
    await Deno.mkdir(vaultsDir, { recursive: true });

    const vaultFile = join(vaultsDir, "hashicorp.ts");
    await Deno.writeTextFile(
      vaultFile,
      [
        'import { z } from "npm:zod";',
        "export const vault = {",
        '  type: "@hashicorp/vault",',
        '  name: "HashiCorp Vault",',
        '  description: "KV v2 secrets engine via HTTP API.",',
        "  createProvider(name: string, config: Record<string, unknown>) {",
        "    return { get: async () => '', put: async () => {}, list: async () => [], getName: () => name };",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [vaultFile],
      vaultsDir,
    );
    assertEquals(result.vaults.length, 1);
    assertEquals(result.vaults[0].type, "@hashicorp/vault");
    assertEquals(result.vaults[0].name, "HashiCorp Vault");
    assertEquals(
      result.vaults[0].description,
      "KV v2 secrets engine via HTTP API.",
    );
    assertEquals(result.vaults[0].hasConfigSchema, false);
    assertEquals(result.vaults[0].configFields, []);
    assertEquals(result.vaults[0].fileName, "hashicorp.ts");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts vault configSchema fields", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const vaultsDir = join(tmpDir, "vaults");
    await Deno.mkdir(vaultsDir, { recursive: true });

    const vaultFile = join(vaultsDir, "custom.ts");
    await Deno.writeTextFile(
      vaultFile,
      [
        'import { z } from "npm:zod";',
        "export const vault = {",
        '  type: "@myorg/custom",',
        '  name: "Custom Vault",',
        '  description: "A custom vault provider.",',
        "  configSchema: z.object({",
        '    address: z.string().url().describe("Server address"),',
        '    token_env: z.string().optional().describe("Token env var"),',
        "  }),",
        "  createProvider(name: string, config: Record<string, unknown>) {",
        "    return { get: async () => '', put: async () => {}, list: async () => [], getName: () => name };",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [vaultFile],
      vaultsDir,
    );
    assertEquals(result.vaults[0].hasConfigSchema, true);
    assertEquals(result.vaults[0].configFields.length, 2);
    assertEquals(result.vaults[0].configFields[0].name, "address");
    assertEquals(result.vaults[0].configFields[0].type, "string");
    assertEquals(result.vaults[0].configFields[0].required, true);
    assertEquals(result.vaults[0].configFields[1].name, "token_env");
    assertEquals(result.vaults[0].configFields[1].required, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts vault configSchema descriptions with chained validators", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const vaultsDir = join(tmpDir, "vaults");
    await Deno.mkdir(vaultsDir, { recursive: true });

    const vaultFile = join(vaultsDir, "onepassword.ts");
    await Deno.writeTextFile(
      vaultFile,
      [
        'import { z } from "npm:zod@4.3.6";',
        "export const vault = {",
        '  type: "@swampadmin/1password",',
        '  name: "1Password",',
        "  description:",
        '    "1Password vault provider. Uses the 1Password CLI (op) for secret operations.",',
        "  configSchema: z.object({",
        "    op_vault: z.string()",
        '      .min(1, "Vault name is required")',
        "      .describe(\"The 1Password vault to use, e.g. 'Private' or 'Shared'\"),",
        "    op_account: z.string()",
        "      .optional()",
        '      .describe("Account shorthand, UUID, or sign-in address"),',
        "  }),",
        "  createProvider(name: string, config: Record<string, unknown>) {",
        "    return { get: async () => '', put: async () => {}, list: async () => [], getName: () => name };",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [vaultFile],
      vaultsDir,
    );
    assertEquals(result.vaults.length, 1);
    assertEquals(result.vaults[0].configFields.length, 2);

    const opVault = result.vaults[0].configFields.find(
      (f) => f.name === "op_vault",
    )!;
    assertEquals(opVault.type, "string");
    assertEquals(opVault.required, true);
    assertEquals(
      opVault.description,
      "The 1Password vault to use, e.g. 'Private' or 'Shared'",
    );

    const opAccount = result.vaults[0].configFields.find(
      (f) => f.name === "op_account",
    )!;
    assertEquals(opAccount.type, "string");
    assertEquals(opAccount.required, false);
    assertEquals(
      opAccount.description,
      "Account shorthand, UUID, or sign-in address",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts vault configSchema from shorthand syntax", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const vaultsDir = join(tmpDir, "vaults");
    await Deno.mkdir(vaultsDir, { recursive: true });

    const vaultFile = join(vaultsDir, "shorthand.ts");
    await Deno.writeTextFile(
      vaultFile,
      [
        'import { z } from "npm:zod";',
        "const configSchema = z.object({",
        '  address: z.string().describe("Server address"),',
        '  token: z.string().optional().describe("Auth token"),',
        "});",
        "export const vault = {",
        '  type: "@myorg/shorthand",',
        '  name: "Shorthand Vault",',
        '  description: "Uses shorthand configSchema.",',
        "  configSchema,",
        "  createProvider(name: string, config: Record<string, unknown>) {",
        "    return { get: async () => '', put: async () => {}, list: async () => [], getName: () => name };",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [vaultFile],
      vaultsDir,
    );
    assertEquals(result.vaults[0].hasConfigSchema, true);
    assertEquals(result.vaults[0].configFields.length, 2);
    assertEquals(result.vaults[0].configFields[0].name, "address");
    assertEquals(result.vaults[0].configFields[0].type, "string");
    assertEquals(result.vaults[0].configFields[0].required, true);
    assertEquals(result.vaults[0].configFields[1].name, "token");
    assertEquals(result.vaults[0].configFields[1].required, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata skips vault file without vault export", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const vaultsDir = join(tmpDir, "vaults");
    await Deno.mkdir(vaultsDir, { recursive: true });

    const vaultFile = join(vaultsDir, "helper.ts");
    await Deno.writeTextFile(
      vaultFile,
      "export const helper = () => 42;\n",
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [vaultFile],
      vaultsDir,
    );
    assertEquals(result.vaults.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata skips vault without type", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const vaultsDir = join(tmpDir, "vaults");
    await Deno.mkdir(vaultsDir, { recursive: true });

    const vaultFile = join(vaultsDir, "bad.ts");
    await Deno.writeTextFile(
      vaultFile,
      [
        "export const vault = {",
        '  name: "Bad Vault",',
        '  description: "Missing type field.",',
        "  createProvider(name: string) {",
        "    return { get: async () => '', put: async () => {}, list: async () => [], getName: () => name };",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [vaultFile],
      vaultsDir,
    );
    assertEquals(result.vaults.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts driver type, name, and description", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const driversDir = join(tmpDir, "drivers");
    await Deno.mkdir(driversDir, { recursive: true });

    const driverFile = join(driversDir, "s3.ts");
    await Deno.writeTextFile(
      driverFile,
      [
        'import { z } from "npm:zod";',
        "export const driver = {",
        '  type: "@aws/s3",',
        '  name: "AWS S3",',
        '  description: "S3 object storage driver.",',
        "  createDriver(name: string, config: Record<string, unknown>) {",
        "    return { read: async () => new Uint8Array(), write: async () => {}, getName: () => name };",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [],
      "",
      [driverFile],
      driversDir,
    );
    assertEquals(result.drivers.length, 1);
    assertEquals(result.drivers[0].type, "@aws/s3");
    assertEquals(result.drivers[0].name, "AWS S3");
    assertEquals(result.drivers[0].description, "S3 object storage driver.");
    assertEquals(result.drivers[0].hasConfigSchema, false);
    assertEquals(result.drivers[0].configFields, []);
    assertEquals(result.drivers[0].fileName, "s3.ts");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts driver configSchema fields", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const driversDir = join(tmpDir, "drivers");
    await Deno.mkdir(driversDir, { recursive: true });

    const driverFile = join(driversDir, "custom.ts");
    await Deno.writeTextFile(
      driverFile,
      [
        'import { z } from "npm:zod";',
        "export const driver = {",
        '  type: "@myorg/custom-driver",',
        '  name: "Custom Driver",',
        '  description: "A custom storage driver.",',
        "  configSchema: z.object({",
        '    bucket: z.string().describe("Bucket name"),',
        '    region: z.string().optional().describe("AWS region"),',
        "  }),",
        "  createDriver(name: string, config: Record<string, unknown>) {",
        "    return { read: async () => new Uint8Array(), write: async () => {}, getName: () => name };",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [],
      "",
      [driverFile],
      driversDir,
    );
    assertEquals(result.drivers[0].hasConfigSchema, true);
    assertEquals(result.drivers[0].configFields.length, 2);
    assertEquals(result.drivers[0].configFields[0].name, "bucket");
    assertEquals(result.drivers[0].configFields[0].type, "string");
    assertEquals(result.drivers[0].configFields[0].required, true);
    assertEquals(result.drivers[0].configFields[1].name, "region");
    assertEquals(result.drivers[0].configFields[1].required, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts driver configSchema from shorthand syntax", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const driversDir = join(tmpDir, "drivers");
    await Deno.mkdir(driversDir, { recursive: true });

    const driverFile = join(driversDir, "shorthand.ts");
    await Deno.writeTextFile(
      driverFile,
      [
        'import { z } from "npm:zod";',
        "const configSchema = z.object({",
        '  endpoint: z.string().describe("API endpoint"),',
        '  timeout: z.number().optional().describe("Timeout in ms"),',
        "});",
        "export const driver = {",
        '  type: "@myorg/shorthand-driver",',
        '  name: "Shorthand Driver",',
        '  description: "Uses shorthand configSchema.",',
        "  configSchema,",
        "  createDriver(name: string, config: Record<string, unknown>) {",
        "    return { read: async () => new Uint8Array(), write: async () => {}, getName: () => name };",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [],
      "",
      [driverFile],
      driversDir,
    );
    assertEquals(result.drivers[0].hasConfigSchema, true);
    assertEquals(result.drivers[0].configFields.length, 2);
    assertEquals(result.drivers[0].configFields[0].name, "endpoint");
    assertEquals(result.drivers[0].configFields[0].type, "string");
    assertEquals(result.drivers[0].configFields[0].required, true);
    assertEquals(result.drivers[0].configFields[1].name, "timeout");
    assertEquals(result.drivers[0].configFields[1].required, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata skips driver file without driver export", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const driversDir = join(tmpDir, "drivers");
    await Deno.mkdir(driversDir, { recursive: true });

    const driverFile = join(driversDir, "helper.ts");
    await Deno.writeTextFile(
      driverFile,
      "export const helper = () => 42;\n",
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [],
      "",
      [driverFile],
      driversDir,
    );
    assertEquals(result.drivers.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata skips driver without type", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const driversDir = join(tmpDir, "drivers");
    await Deno.mkdir(driversDir, { recursive: true });

    const driverFile = join(driversDir, "bad.ts");
    await Deno.writeTextFile(
      driverFile,
      [
        "export const driver = {",
        '  name: "Bad Driver",',
        '  description: "Missing type field.",',
        "  createDriver(name: string) {",
        "    return { read: async () => new Uint8Array(), write: async () => {}, getName: () => name };",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [],
      "",
      [driverFile],
      driversDir,
    );
    assertEquals(result.drivers.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts datastore type, name, and description", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const datastoresDir = join(tmpDir, "datastores");
    await Deno.mkdir(datastoresDir, { recursive: true });

    const datastoreFile = join(datastoresDir, "postgres.ts");
    await Deno.writeTextFile(
      datastoreFile,
      [
        'import { z } from "npm:zod";',
        "export const datastore = {",
        '  type: "@myorg/postgres",',
        '  name: "PostgreSQL",',
        '  description: "PostgreSQL datastore provider.",',
        "  createProvider(name: string, config: Record<string, unknown>) {",
        "    return { query: async () => [], getName: () => name };",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [],
      "",
      [],
      "",
      [datastoreFile],
      datastoresDir,
    );
    assertEquals(result.datastores.length, 1);
    assertEquals(result.datastores[0].type, "@myorg/postgres");
    assertEquals(result.datastores[0].name, "PostgreSQL");
    assertEquals(
      result.datastores[0].description,
      "PostgreSQL datastore provider.",
    );
    assertEquals(result.datastores[0].hasConfigSchema, false);
    assertEquals(result.datastores[0].configFields, []);
    assertEquals(result.datastores[0].fileName, "postgres.ts");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts datastore configSchema fields", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const datastoresDir = join(tmpDir, "datastores");
    await Deno.mkdir(datastoresDir, { recursive: true });

    const datastoreFile = join(datastoresDir, "custom.ts");
    await Deno.writeTextFile(
      datastoreFile,
      [
        'import { z } from "npm:zod";',
        "export const datastore = {",
        '  type: "@myorg/custom-store",',
        '  name: "Custom Store",',
        '  description: "A custom datastore provider.",',
        "  configSchema: z.object({",
        '    host: z.string().describe("Database host"),',
        '    port: z.number().optional().describe("Database port"),',
        "  }),",
        "  createProvider(name: string, config: Record<string, unknown>) {",
        "    return { query: async () => [], getName: () => name };",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [],
      "",
      [],
      "",
      [datastoreFile],
      datastoresDir,
    );
    assertEquals(result.datastores[0].hasConfigSchema, true);
    assertEquals(result.datastores[0].configFields.length, 2);
    assertEquals(result.datastores[0].configFields[0].name, "host");
    assertEquals(result.datastores[0].configFields[0].type, "string");
    assertEquals(result.datastores[0].configFields[0].required, true);
    assertEquals(result.datastores[0].configFields[1].name, "port");
    assertEquals(result.datastores[0].configFields[1].required, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts datastore configSchema from shorthand syntax", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const datastoresDir = join(tmpDir, "datastores");
    await Deno.mkdir(datastoresDir, { recursive: true });

    const datastoreFile = join(datastoresDir, "shorthand.ts");
    await Deno.writeTextFile(
      datastoreFile,
      [
        'import { z } from "npm:zod";',
        "const configSchema = z.object({",
        '  connectionString: z.string().describe("Connection string"),',
        '  poolSize: z.number().optional().describe("Connection pool size"),',
        "});",
        "export const datastore = {",
        '  type: "@myorg/shorthand-store",',
        '  name: "Shorthand Store",',
        '  description: "Uses shorthand configSchema.",',
        "  configSchema,",
        "  createProvider(name: string, config: Record<string, unknown>) {",
        "    return { query: async () => [], getName: () => name };",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [],
      "",
      [],
      "",
      [datastoreFile],
      datastoresDir,
    );
    assertEquals(result.datastores[0].hasConfigSchema, true);
    assertEquals(result.datastores[0].configFields.length, 2);
    assertEquals(result.datastores[0].configFields[0].name, "connectionString");
    assertEquals(result.datastores[0].configFields[0].type, "string");
    assertEquals(result.datastores[0].configFields[0].required, true);
    assertEquals(result.datastores[0].configFields[1].name, "poolSize");
    assertEquals(result.datastores[0].configFields[1].required, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata skips datastore file without datastore export", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const datastoresDir = join(tmpDir, "datastores");
    await Deno.mkdir(datastoresDir, { recursive: true });

    const datastoreFile = join(datastoresDir, "helper.ts");
    await Deno.writeTextFile(
      datastoreFile,
      "export const helper = () => 42;\n",
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [],
      "",
      [],
      "",
      [datastoreFile],
      datastoresDir,
    );
    assertEquals(result.datastores.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata skips datastore without type", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const datastoresDir = join(tmpDir, "datastores");
    await Deno.mkdir(datastoresDir, { recursive: true });

    const datastoreFile = join(datastoresDir, "bad.ts");
    await Deno.writeTextFile(
      datastoreFile,
      [
        "export const datastore = {",
        '  name: "Bad Store",',
        '  description: "Missing type field.",',
        "  createProvider(name: string) {",
        "    return { query: async () => [], getName: () => name };",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [],
      "",
      [],
      "",
      [datastoreFile],
      datastoresDir,
    );
    assertEquals(result.datastores.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata: extracts methods from shorthand property", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "mymodel.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { z } from "npm:zod@4";',
        "const methods = {",
        "  list: {",
        '    description: "List resources",',
        "    arguments: z.object({}),",
        "    execute: async () => ({ dataHandles: [] }),",
        "  },",
        "  create: {",
        '    description: "Create a resource",',
        "    arguments: z.object({}),",
        "    execute: async () => ({ dataHandles: [] }),",
        "  },",
        "};",
        "export const model = {",
        '  type: "@test/mymodel",',
        '  version: "2026.03.26.1",',
        "  methods,",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    assertEquals(result.models.length, 1);
    assertEquals(result.models[0].methods.length, 2);
    assertEquals(result.models[0].methods[0].name, "list");
    assertEquals(result.models[0].methods[0].description, "List resources");
    assertEquals(result.models[0].methods[1].name, "create");
    assertEquals(
      result.models[0].methods[1].description,
      "Create a resource",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata: extracts methods from variable reference", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "refmodel.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { z } from "npm:zod@4";',
        "const myMethods = {",
        "  sync: {",
        '    description: "Sync data",',
        "    arguments: z.object({}),",
        "    execute: async () => ({ dataHandles: [] }),",
        "  },",
        "};",
        "export const model = {",
        '  type: "@test/refmodel",',
        '  version: "2026.03.26.1",',
        "  methods: myMethods,",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    assertEquals(result.models.length, 1);
    assertEquals(result.models[0].methods.length, 1);
    assertEquals(result.models[0].methods[0].name, "sync");
    assertEquals(result.models[0].methods[0].description, "Sync data");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata: ignores type: inside string literal before model export", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "organizer.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { z } from "npm:zod@4";',
        "",
        "// A const string that contains type: before the model export",
        'const PROMPT = "For Anime (type: \\"anime\\"):\\n" +',
        '  "List episodes by season.";',
        "",
        "export const model = {",
        '  type: "@keeb/mms/organizer",',
        '  version: "2026.03.01.1",',
        "  methods: {",
        "    organize: {",
        '      description: "Organize media",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    assertEquals(result.models.length, 1);
    assertEquals(result.models[0].type, "@keeb/mms/organizer");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata: ignores type: inside template literal in method", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "organizer2.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { z } from "npm:zod@4";',
        "",
        "export const model = {",
        '  type: "@keeb/mms/organizer",',
        '  version: "2026.03.01.1",',
        "  methods: {",
        "    organize: {",
        '      description: "Organize media",',
        "      arguments: z.object({}),",
        "      execute: async () => {",
        "        const prompt = `",
        '**For Anime (type: "anime"):**',
        "List episodes by season.`,",
        "        return { dataHandles: [] };",
        "      },",
        "    },",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([modelFile], modelsDir, []);
    assertEquals(result.models.length, 1);
    assertEquals(result.models[0].type, "@keeb/mms/organizer");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
