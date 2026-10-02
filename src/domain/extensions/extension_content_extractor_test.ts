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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { extractContentMetadata } from "./extension_content_extractor.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";

Deno.test("extractContentMetadata returns empty for no inputs", async () => {
  const result = await extractContentMetadata([], "/tmp/models", []);
  assertEquals(result, {
    models: [],
    extensions: [],
    workflows: [],
    vaults: [],
    datastores: [],
    reports: [],
    webhooks: [],
    skills: [],
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

Deno.test("extractContentMetadata extracts version from model export, not earlier literals", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "card.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'const SCHEMA_TEMPLATE = { version: "1.0.0", fields: [] };',
        "",
        "export const model = {",
        '  type: "@test/card",',
        '  version: "2026.05.26.1",',
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
    assertEquals(result.models.length, 1);
    assertEquals(result.models[0].version, "2026.05.26.1");
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
    assertPathEquals(result.models[0].fileName, "aws/ec2/instance.ts");
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

Deno.test("extractContentMetadata extracts webhook type, name, and description", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const webhooksDir = join(tmpDir, "webhooks");
    await Deno.mkdir(webhooksDir, { recursive: true });

    const webhookFile = join(webhooksDir, "telegram.ts");
    await Deno.writeTextFile(
      webhookFile,
      [
        "export const webhook = {",
        '  type: "@myorg/telegram",',
        '  name: "Telegram",',
        '  description: "Telegram bot updates.",',
        "  createHandler(config: Record<string, unknown>) {",
        '    return { signatureHeader: "x", requiredHeaders: [], verify: () => true };',
        "  },",
        "};",
      ].join("\n"),
    );
    // Missing createHandler — not a webhook file.
    const notWebhook = join(webhooksDir, "other.ts");
    await Deno.writeTextFile(
      notWebhook,
      'export const webhook = { type: "@myorg/other" };',
    );

    const result = await extractContentMetadata(
      [],
      tmpDir,
      [],
      [],
      "",
      [],
      "",
      [],
      "",
      [webhookFile, notWebhook],
      webhooksDir,
    );
    assertEquals(result.webhooks, [{
      fileName: "telegram.ts",
      type: "@myorg/telegram",
      name: "Telegram",
      description: "Telegram bot updates.",
    }]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata extracts webhook with a type annotation", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const webhooksDir = join(tmpDir, "webhooks");
    await Deno.mkdir(webhooksDir, { recursive: true });

    const webhookFile = join(webhooksDir, "typed.ts");
    await Deno.writeTextFile(
      webhookFile,
      [
        'import type { WebhookExport } from "@swamp-club/swamp-testing";',
        "export const webhook: WebhookExport = {",
        '  type: "@otherorg/typed",',
        '  createHandler: () => ({ signatureHeader: "x", requiredHeaders: [], verify: () => true }),',
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
      [],
      "",
      [webhookFile],
      webhooksDir,
    );
    assertEquals(result.webhooks, [{
      fileName: "typed.ts",
      type: "@otherorg/typed",
      name: "",
      description: "",
    }]);
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

Deno.test("extractContentMetadata: extracts extension with inline methods array", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const extFile = join(modelsDir, "grafana_ext.ts");
    await Deno.writeTextFile(
      extFile,
      [
        'import { z } from "npm:zod@4";',
        "export const extension = {",
        '  type: "@keeb/grafana/instance",',
        "  methods: [",
        "    {",
        "      queryLogs: {",
        '        description: "Query Grafana Loki logs",',
        "        arguments: z.object({",
        '          query: z.string().describe("LogQL query"),',
        "        }),",
        "        execute: async () => ({ dataHandles: [] }),",
        "      },",
        "    },",
        "  ],",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([extFile], modelsDir, []);
    assertEquals(result.models.length, 0);
    assertEquals(result.extensions.length, 1);
    assertEquals(result.extensions[0].extendsType, "@keeb/grafana/instance");
    assertEquals(result.extensions[0].fileName, "grafana_ext.ts");
    assertEquals(result.extensions[0].methods.length, 1);
    assertEquals(result.extensions[0].methods[0].name, "queryLogs");
    assertEquals(
      result.extensions[0].methods[0].description,
      "Query Grafana Loki logs",
    );
    assertEquals(result.extensions[0].methods[0].arguments.length, 1);
    assertEquals(result.extensions[0].methods[0].arguments[0].name, "query");
    assertEquals(result.extensions[0].methods[0].arguments[0].type, "string");
    assertEquals(result.extensions[0].methods[0].arguments[0].required, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata: extracts extension with multiple methods", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const extFile = join(modelsDir, "multi_ext.ts");
    await Deno.writeTextFile(
      extFile,
      [
        'import { z } from "npm:zod@4";',
        "export const extension = {",
        '  type: "@other/service",',
        "  methods: [",
        "    {",
        "      methodA: {",
        '        description: "First method",',
        "        arguments: z.object({}),",
        "        execute: async () => ({ dataHandles: [] }),",
        "      },",
        "    },",
        "    {",
        "      methodB: {",
        '        description: "Second method",',
        "        arguments: z.object({}),",
        "        execute: async () => ({ dataHandles: [] }),",
        "      },",
        "    },",
        "  ],",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([extFile], modelsDir, []);
    assertEquals(result.extensions.length, 1);
    assertEquals(result.extensions[0].extendsType, "@other/service");
    assertEquals(result.extensions[0].methods.length, 2);
    assertEquals(result.extensions[0].methods[0].name, "methodA");
    assertEquals(result.extensions[0].methods[1].name, "methodB");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata: skips extension without type", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const extFile = join(modelsDir, "bad_ext.ts");
    await Deno.writeTextFile(
      extFile,
      [
        'import { z } from "npm:zod@4";',
        "export const extension = {",
        "  methods: [",
        "    {",
        "      run: {",
        '        description: "Run",',
        "        arguments: z.object({}),",
        "        execute: async () => ({ dataHandles: [] }),",
        "      },",
        "    },",
        "  ],",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata([extFile], modelsDir, []);
    assertEquals(result.extensions.length, 0);
    assertEquals(result.models.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata: extracts both models and extensions from same file list", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const modelFile = join(modelsDir, "instance.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        "export const model = {",
        '  type: "@test/instance",',
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

    const extFile = join(modelsDir, "ext.ts");
    await Deno.writeTextFile(
      extFile,
      [
        'import { z } from "npm:zod@4";',
        "export const extension = {",
        '  type: "@test/instance",',
        "  methods: [",
        "    {",
        "      extra: {",
        '        description: "Extra method",',
        "        arguments: z.object({}),",
        "        execute: async () => ({ dataHandles: [] }),",
        "      },",
        "    },",
        "  ],",
        "};",
      ].join("\n"),
    );

    const result = await extractContentMetadata(
      [modelFile, extFile],
      modelsDir,
      [],
    );
    assertEquals(result.models.length, 1);
    assertEquals(result.models[0].type, "@test/instance");
    assertEquals(result.extensions.length, 1);
    assertEquals(result.extensions[0].extendsType, "@test/instance");
    assertEquals(result.extensions[0].methods[0].name, "extra");
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

/** Writes one model source file and returns its extracted content metadata. */
async function extractFromSource(lines: string[]) {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const file = join(modelsDir, "model.ts");
    await Deno.writeTextFile(file, lines.join("\n"));
    return await extractContentMetadata([file], modelsDir, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

function methodNames(result: Awaited<ReturnType<typeof extractFromSource>>) {
  return result.models[0].methods.map((m) => m.name);
}

Deno.test("extractContentMetadata: lists methods with double- and single-quoted keys", async () => {
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    "export const model = {",
    '  type: "@test/quoted",',
    '  version: "2026.10.01.1",',
    "  methods: {",
    "    list: {",
    '      description: "List items",',
    "      arguments: z.object({}),",
    "      execute: () => Promise.resolve({ dataHandles: [] }),",
    "    },",
    '    "list-subscriptions": {',
    '      description: "List subscriptions",',
    "      arguments: z.object({",
    '        source: z.string().describe("Source id"),',
    "      }),",
    "      execute: () => Promise.resolve({ dataHandles: [] }),",
    "    },",
    "    'force-run': {",
    "      description: 'Force a run',",
    "      arguments: z.object({}),",
    "      execute: () => Promise.resolve({ dataHandles: [] }),",
    "    },",
    "  },",
    "};",
  ]);

  const methods = result.models[0].methods;
  assertEquals(methodNames(result), [
    "list",
    "list-subscriptions",
    "force-run",
  ]);
  assertEquals(methods[1].description, "List subscriptions");
  assertEquals(methods[1].arguments.map((a) => a.name), ["source"]);
  assertEquals(methods[2].description, "Force a run");
});

Deno.test("extractContentMetadata: does not list objects nested inside a method", async () => {
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    "export const model = {",
    '  type: "@test/nested",',
    '  version: "2026.10.01.1",',
    "  methods: {",
    "    create: {",
    "      checks: {",
    '        "duplicate-check": {',
    '          description: "Reject duplicates",',
    "          execute: () => Promise.resolve({ pass: true }),",
    "        },",
    "      },",
    '      description: "Create an audience",',
    "      arguments: z.object({}),",
    "      execute: () => {",
    "        const result = { inner: { description: 'not a method' } };",
    "        return Promise.resolve(result);",
    "      },",
    "    },",
    "    update: {",
    '      description: "Update an audience",',
    "      arguments: z.object({}),",
    "      execute: () => Promise.resolve({ dataHandles: [] }),",
    "    },",
    "  },",
    "};",
  ]);

  assertEquals(methodNames(result), ["create", "update"]);
  assertEquals(result.models[0].methods[0].description, "Create an audience");
});

Deno.test("extractContentMetadata: lists a method whose description is not a string literal", async () => {
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    'const DESCRIPTION = "Synced";',
    "export const model = {",
    '  type: "@test/nonliteral",',
    '  version: "2026.10.01.1",',
    "  methods: {",
    "    sync: {",
    "      description: DESCRIPTION,",
    "      arguments: z.object({}),",
    "      execute: () => Promise.resolve({ dataHandles: [] }),",
    "    },",
    "  },",
    "};",
  ]);

  assertEquals(methodNames(result), ["sync"]);
  assertEquals(result.models[0].methods[0].description, "");
});

Deno.test("extractContentMetadata: keeps the first literal of a concatenated description", async () => {
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    "export const model = {",
    '  type: "@test/concat",',
    '  version: "2026.10.01.1",',
    "  methods: {",
    "    login: {",
    "      description:",
    '        "Log into a registry. " +',
    '        "The password is never logged.",',
    "      arguments: z.object({}),",
    "      execute: () => Promise.resolve({ dataHandles: [] }),",
    "    },",
    "    push: {",
    "      description: `Push an image`,",
    "      arguments: z.object({}),",
    "      execute: () => Promise.resolve({ dataHandles: [] }),",
    "    },",
    "  },",
    "};",
  ]);

  const methods = result.models[0].methods;
  assertEquals(methods[0].description, "Log into a registry. ");
  assertEquals(methods[1].description, "Push an image");
});

Deno.test("extractContentMetadata: skips spreads, computed keys, shorthand, factory calls and comments", async () => {
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    'const KEY = "computed";',
    "const shared = {};",
    "const helper = {};",
    "export const model = {",
    '  type: "@test/skips",',
    '  version: "2026.10.01.1",',
    "  methods: {",
    "    ...shared,",
    "    [KEY]: {",
    '      description: "Computed",',
    "      execute: () => Promise.resolve({}),",
    "    },",
    "    helper,",
    "    made: makeMethod(spec, {",
    '      checks: { description: "inside a call" },',
    "    }),",
    '    // old: { description: "commented out" },',
    '    /* older: { description: "block comment" }, */',
    "    run: {",
    '      description: "Run it",',
    "      arguments: z.object({}),",
    "      execute: () => Promise.resolve({ dataHandles: [] }),",
    "    },",
    "  },",
    "};",
  ]);

  assertEquals(methodNames(result), ["run"]);
});

Deno.test("extractContentMetadata: regex literals and apostrophes in method bodies do not drop later methods", async () => {
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    "export const model = {",
    '  type: "@test/bodies",',
    '  version: "2026.10.01.1",',
    "  methods: {",
    "    quote: {",
    '      description: "Escape quotes",',
    "      arguments: z.object({}),",
    "      execute: (args: { s: string }) => {",
    "        // don't let an apostrophe confuse the walker",
    '        const escaped = args.s.replace(/[\'"`]/g, "\\\\$&");',
    "        return Promise.resolve({ escaped });",
    "      },",
    "    },",
    '    "after-quote": {',
    '      description: "Runs after",',
    "      arguments: z.object({}),",
    "      execute: () => Promise.resolve({ dataHandles: [] }),",
    "    },",
    "  },",
    "};",
  ]);

  assertEquals(methodNames(result), ["quote", "after-quote"]);
});

Deno.test("extractContentMetadata: a method named as a suffix of another gets its own arguments", async () => {
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    "export const model = {",
    '  type: "@test/suffix",',
    '  version: "2026.10.01.1",',
    "  methods: {",
    "    direct_predict: {",
    '      description: "direct predict",',
    "      arguments: z.object({",
    "        inputs: z.any().optional(),",
    "      }),",
    "      execute: () => Promise.resolve({ dataHandles: [] }),",
    "    },",
    "    predict: {",
    '      description: "predict",',
    "      arguments: z.object({",
    "        instances: z.any().optional(),",
    "      }),",
    "      execute: () => Promise.resolve({ dataHandles: [] }),",
    "    },",
    "  },",
    "};",
  ]);

  const methods = result.models[0].methods;
  assertEquals(methods[0].arguments.map((a) => a.name), ["inputs"]);
  assertEquals(methods[1].arguments.map((a) => a.name), ["instances"]);
});

Deno.test("extractContentMetadata: lists quoted keys in a variable-referenced methods object", async () => {
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    "const segmentMethods = {",
    '  "list-rules": {',
    '    description: "List rules",',
    "    arguments: z.object({}),",
    "    execute: () => Promise.resolve({ dataHandles: [] }),",
    "  },",
    "  get: {",
    '    description: "Get one",',
    "    arguments: z.object({}),",
    "    execute: () => Promise.resolve({ dataHandles: [] }),",
    "  },",
    "};",
    "export const model = {",
    '  type: "@test/varref",',
    '  version: "2026.10.01.1",',
    "  methods: segmentMethods,",
    "};",
  ]);

  assertEquals(methodNames(result), ["list-rules", "get"]);
});

Deno.test("extractContentMetadata: extension methods array lists quoted keys and skips nested objects", async () => {
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    "export const extension = {",
    '  type: "@test/target",',
    "  methods: [",
    "    {",
    '      "query-logs": {',
    '        description: "Query logs",',
    "        arguments: z.object({}),",
    "        checks: {",
    '          "rate-limit": { description: "Rate limit check" },',
    "        },",
    "        execute: () => Promise.resolve({ dataHandles: [] }),",
    "      },",
    "    },",
    "    {",
    "      tail: {",
    '        description: "Tail logs",',
    "        arguments: z.object({}),",
    "        execute: () => Promise.resolve({ dataHandles: [] }),",
    "      },",
    "    },",
    "  ],",
    "};",
  ]);

  assertEquals(
    result.extensions[0].methods.map((m) => m.name),
    ["query-logs", "tail"],
  );
  assertEquals(result.extensions[0].methods[0].description, "Query logs");
});

Deno.test("extractContentMetadata: extracts quoted argument and globalArgument keys", async () => {
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    "export const model = {",
    '  type: "@test/quotedargs",',
    '  version: "2026.10.01.1",',
    "  globalArguments: z.object({",
    "    'api-url': z.string().describe(\"API URL\"),",
    "  }),",
    "  methods: {",
    "    run: {",
    '      description: "Run",',
    "      arguments: z.object({",
    '        "dry-run": z.boolean().optional(),',
    "        target: z.string(),",
    "      }),",
    "      execute: () => Promise.resolve({ dataHandles: [] }),",
    "    },",
    "  },",
    "};",
  ]);

  const model = result.models[0];
  assertEquals(model.globalArguments.map((a) => a.name), ["api-url"]);
  assertEquals(model.methods[0].arguments, [
    { name: "dry-run", type: "boolean", description: "", required: false },
    { name: "target", type: "string", description: "", required: true },
  ]);
});

Deno.test("extractContentMetadata: lists every method of a container-image shaped model", async () => {
  const body = Array.from(
    { length: 40 },
    (_, i) => `        const step${i} = { stage: ${i}, flags: ["--x"] };`,
  );
  const method = (key: string, description: string) => [
    `    ${key}: {`,
    `      description: "${description}",`,
    "      arguments: z.object({}),",
    "      execute: () => {",
    ...body,
    "        return Promise.resolve({ dataHandles: [] });",
    "      },",
    "    },",
  ];
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    "export const model = {",
    '  type: "@test/container-image",',
    '  version: "2026.10.01.1",',
    "  methods: {",
    ...method("validate", "Validate"),
    ...method("build", "Build"),
    ...method("run", "Run"),
    ...method("login", "Login"),
    ...method("push", "Push"),
    ...method('"multi-platform-build"', "Multi-platform build"),
    "  },",
    "};",
  ]);

  assertEquals(methodNames(result), [
    "validate",
    "build",
    "run",
    "login",
    "push",
    "multi-platform-build",
  ]);
});

/** A three-method model whose first method's execute body is `body`. */
function modelWithFirstMethodBody(body: string): string[] {
  return [
    'import { z } from "npm:zod@4";',
    "export const model = {",
    '  type: "@test/braces",',
    '  version: "2026.10.02.1",',
    "  methods: {",
    "    first: {",
    '      description: "First",',
    "      arguments: z.object({ a: z.string() }),",
    "      execute: async (args) => {",
    `        ${body}`,
    "      },",
    "    },",
    "    second: {",
    '      description: "Second",',
    "      arguments: z.object({ b: z.string() }),",
    "    },",
    '    third: { description: "Third" },',
    "  },",
    "  resources: {",
    '    out: { description: "Output", lifetime: "persistent" },',
    "  },",
    "};",
  ];
}

const UNPAIRED_BRACE_BODIES: Record<string, string> = {
  "an open brace in a double-quoted string": 'log("{");',
  "a close brace in a single-quoted string": "log('}');",
  "a brace in a template literal": "log(`}${args.a}{`);",
  "a nested template in a template expression": "log(`a${`}`}b`);",
  "an object inside a template expression":
    "log(`${JSON.stringify({ x: 1 })}}`);",
  "a brace in a line comment": "// closes the block }",
  "a brace in a block comment": "/* { */",
  "a brace in a regex literal": "const re = /\\{/;",
  "a brace in a regex character class": "args.a.replace(/[{]/g, '');",
  "a quote in a regex literal": "args.a.replace(/'/g, '');",
  "a regex after return": "if (args.a) return /\\{/.test(args.a);",
  "a regex after typeof and case":
    "switch (typeof args.a) { case /\\}/.source: break; }",
  "a regex after an if header": "if (args.a) /\\{/.test(args.a);",
  "a regex after a for await header":
    "for await (const x of args.a) /\\{/.test(x);",
  "division after a call":
    "const r = Math.max(args.a.length, 1) / 2; const o = { r };",
  "division after an if-like call":
    "const r = notif(args.a) / 2 / 4; const o = { r };",
  "division by a property named like a keyword":
    "const r = args.return / 2; const o = { r };",
  "division beside braces":
    "const half = (args.a.length) / 2; const o = { half };",
  "an unterminated quote": 'const s = "oops\n;',
};

for (const [label, body] of Object.entries(UNPAIRED_BRACE_BODIES)) {
  Deno.test(`extractContentMetadata: lists every method despite ${label}`, async () => {
    const result = await extractFromSource(modelWithFirstMethodBody(body));

    assertEquals(
      result.models[0].methods.map((m) => [
        m.name,
        m.arguments.map((a) => a.name),
      ]),
      [["first", ["a"]], ["second", ["b"]], ["third", []]],
    );
    assertEquals(result.models[0].resources.map((r) => r.key), ["out"]);
  });
}

Deno.test("extractContentMetadata: a brace in an expression-bodied entry value does not swallow later entries", async () => {
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    "export const model = {",
    '  type: "@test/arrows",',
    '  version: "2026.10.02.1",',
    "  methods: {",
    '    helper: makeMethod(/[{]/, "}"),',
    "    clean: {",
    '      execute: (a: string) => a.replace(/[{]/g, ""),',
    '      description: "Clean",',
    "      arguments: z.object({}),",
    "    },",
    "    after: {",
    '      description: "After",',
    "      arguments: z.object({}),",
    "    },",
    "  },",
    "};",
  ]);

  assertEquals(
    result.models[0].methods.map((m) => [m.name, m.description]),
    [["clean", "Clean"], ["after", "After"]],
  );
});

Deno.test("extractContentMetadata: lists every global argument when regex strings contain an escaped dollar-brace", async () => {
  // Shape of swamp-extensions model/aws/wellarchitected agent_goal.ts.
  const pattern = 'new RegExp("^(?:(?!\\\\$\\\\{[a-zA-Z]+:)[\\\\P{C}])+$")';
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    "const GlobalArgsSchema = z.object({",
    `  name: z.string().regex(${pattern}).describe("Name"),`,
    `  goal: z.string().regex(${pattern}).optional().describe("Goal"),`,
    '  region: z.string().describe("Region"),',
    "});",
    "export const model = {",
    '  type: "@test/agent-goal",',
    '  version: "2026.10.02.1",',
    "  globalArguments: GlobalArgsSchema,",
    "  methods: {},",
    "};",
  ]);

  assertEquals(
    result.models[0].globalArguments.map((a) => [a.name, a.required]),
    [["name", true], ["goal", false], ["region", true]],
  );
});

Deno.test("extractContentMetadata: lists every global argument when a description has an extra closing brace", async () => {
  // Shape of swamp-extensions model/gcp/apigee apiproducts_rateplans.ts.
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    "export const model = {",
    '  type: "@test/rateplans",',
    '  version: "2026.10.02.1",',
    "  globalArguments: z.object({",
    "    ranges: z.string().describe(",
    '      \'Ranges: ` { "start": 1, "end": 100 }, } ` then fees apply\',',
    "    ),",
    '    currency: z.string().describe("Currency"),',
    '    fee: z.number().optional().describe("Fee"),',
    "  }),",
    "  methods: {},",
    "};",
  ]);

  assertEquals(
    result.models[0].globalArguments.map((a) => a.name),
    ["ranges", "currency", "fee"],
  );
});

Deno.test("extractContentMetadata: extension methods array survives a brace in a string", async () => {
  const result = await extractFromSource([
    'import { z } from "npm:zod@4";',
    "export const extension = {",
    '  type: "@test/target",',
    "  methods: [",
    "    {",
    "      first: {",
    '        description: "First",',
    "        arguments: z.object({}),",
    '        execute: () => { log("}"); return Promise.resolve({ dataHandles: [] }); },',
    "      },",
    "    },",
    "    {",
    "      second: {",
    '        description: "Second",',
    "        arguments: z.object({}),",
    "        execute: () => Promise.resolve({ dataHandles: [] }),",
    "      },",
    "    },",
    "  ],",
    "};",
  ]);

  assertEquals(
    result.extensions[0].methods.map((m) => m.name),
    ["first", "second"],
  );
});

Deno.test("extractContentMetadata: vault configSchema survives a brace in a description", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const vaultsDir = join(tmpDir, "vaults");
    await Deno.mkdir(vaultsDir, { recursive: true });
    const vaultFile = join(vaultsDir, "braces.ts");
    await Deno.writeTextFile(
      vaultFile,
      [
        'import { z } from "npm:zod";',
        "export const vault = {",
        '  type: "@myorg/braces",',
        '  name: "Braces Vault",',
        '  description: "A vault with braces in its docs.",',
        "  configSchema: z.object({",
        '    path: z.string().describe("Secret path, opens with {"),',
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
    assertEquals(
      result.vaults[0].configFields.map((f) => f.name),
      ["path", "token_env"],
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extractContentMetadata: unclosed regex-like slashes on one long line finish without a model", async () => {
  const result = await extractFromSource([
    'export const model = { type: "@test/slashes", version: "2026.10.02.1", methods: { a: { b: (' +
    "/[".repeat(500_000) + "}}",
  ]);

  assertEquals(result.models, []);
});

Deno.test("extractContentMetadata: deeply nested template expressions read as unterminated", async () => {
  const result = await extractFromSource([
    "export const model = {",
    '  type: "@test/deep",',
    '  version: "2026.10.02.1",',
    "  methods: { a: { x: " + "`${".repeat(200_000) + " } },",
    "};",
  ]);

  assertEquals(result.models, []);
});
