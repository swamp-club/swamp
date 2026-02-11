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

import { assertEquals, assertRejects } from "@std/assert";
import {
  createDefinitionId,
  Definition,
} from "../../../definitions/definition.ts";
import {
  AWS_CLI_MODEL_TYPE,
  AwsCliDataAttributesSchema,
  AwsCliInputAttributesSchema,
  awsCliModel,
  parseCommand,
} from "./aws_cli_model.ts";
import type { MethodContext } from "../../model.ts";
import type { UnifiedDataRepository } from "../../../../infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionRepository } from "../../../definitions/repositories.ts";
import { generateDataId } from "../../../data/data_id.ts";
import { getLogger } from "@logtape/logtape";

/**
 * Creates a mock UnifiedDataRepository for testing.
 */
function createMockDataRepo(): UnifiedDataRepository {
  return {
    findAllGlobal: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    removeLatestSymlink: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: () =>
      Promise.resolve({ version: 1, contentPath: "/tmp/mock" }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
  };
}

/**
 * Creates a mock DefinitionRepository for testing.
 */
function createMockDefinitionRepo(): DefinitionRepository {
  return {
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findByNameGlobal: () => Promise.resolve(null),
    findAllGlobal: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => createDefinitionId(crypto.randomUUID()),
    getPath: () => "",
  };
}

/**
 * Creates a test MethodContext with mocked repositories.
 */
function createTestContext(): MethodContext {
  return {
    repoDir: "/tmp",
    modelType: AWS_CLI_MODEL_TYPE,
    modelId: crypto.randomUUID(),
    globalArgs: {},
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    methodName: "run",
    logger: getLogger(["test"]),
    dataRepository: createMockDataRepo(),
    definitionRepository: createMockDefinitionRepo(),
  };
}

Deno.test("AWS_CLI_MODEL_TYPE has correct normalized type", () => {
  assertEquals(AWS_CLI_MODEL_TYPE.normalized, "aws/cli");
});

Deno.test("awsCliModel has correct version", () => {
  assertEquals(awsCliModel.version, "2026.02.09.1");
});

Deno.test("awsCliModel.type equals AWS_CLI_MODEL_TYPE", () => {
  assertEquals(awsCliModel.type.equals(AWS_CLI_MODEL_TYPE), true);
});

Deno.test("AwsCliInputAttributesSchema validates command", () => {
  const result = AwsCliInputAttributesSchema.safeParse({
    command: "s3 ls",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.command, "s3 ls");
    assertEquals(result.data.timeout, 60000); // default
    assertEquals(result.data.parseJson, false); // default
  }
});

Deno.test("AwsCliInputAttributesSchema validates with all options", () => {
  const result = AwsCliInputAttributesSchema.safeParse({
    command: "ec2 describe-instances",
    region: "us-west-2",
    profile: "production",
    timeout: 30000,
    parseJson: true,
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.command, "ec2 describe-instances");
    assertEquals(result.data.region, "us-west-2");
    assertEquals(result.data.profile, "production");
    assertEquals(result.data.timeout, 30000);
    assertEquals(result.data.parseJson, true);
  }
});

Deno.test("AwsCliInputAttributesSchema rejects empty command", () => {
  const result = AwsCliInputAttributesSchema.safeParse({
    command: "",
  });
  assertEquals(result.success, false);
});

Deno.test("AwsCliInputAttributesSchema rejects missing command", () => {
  const result = AwsCliInputAttributesSchema.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("AwsCliInputAttributesSchema rejects negative timeout", () => {
  const result = AwsCliInputAttributesSchema.safeParse({
    command: "s3 ls",
    timeout: -1000,
  });
  assertEquals(result.success, false);
});

Deno.test("AwsCliInputAttributesSchema rejects zero timeout", () => {
  const result = AwsCliInputAttributesSchema.safeParse({
    command: "s3 ls",
    timeout: 0,
  });
  assertEquals(result.success, false);
});

Deno.test("AwsCliDataAttributesSchema validates correct data", () => {
  const result = AwsCliDataAttributesSchema.safeParse({
    output: "bucket-1\nbucket-2",
    exitCode: 0,
    executedAt: "2024-01-15T10:30:00.000Z",
    durationMs: 150,
  });
  assertEquals(result.success, true);
});

Deno.test("AwsCliDataAttributesSchema validates with json attribute", () => {
  const result = AwsCliDataAttributesSchema.safeParse({
    output: '{"Images": []}',
    json: { Images: [] },
    exitCode: 0,
    executedAt: "2024-01-15T10:30:00.000Z",
    durationMs: 150,
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.json, { Images: [] });
  }
});

Deno.test("AwsCliDataAttributesSchema rejects invalid timestamp", () => {
  const result = AwsCliDataAttributesSchema.safeParse({
    output: "test",
    exitCode: 0,
    executedAt: "not-a-date",
    durationMs: 150,
  });
  assertEquals(result.success, false);
});

Deno.test("awsCliModel has run method", () => {
  assertEquals("run" in awsCliModel.methods, true);
  assertEquals(
    awsCliModel.methods.run.description,
    "Run an AWS CLI command and capture output as data attributes",
  );
});

Deno.test("parseCommand handles simple commands", () => {
  assertEquals(parseCommand("s3 ls"), ["s3", "ls"]);
  assertEquals(parseCommand("ec2 describe-instances"), [
    "ec2",
    "describe-instances",
  ]);
});

Deno.test("parseCommand handles multiple spaces", () => {
  assertEquals(parseCommand("s3   ls"), ["s3", "ls"]);
  assertEquals(parseCommand("  s3 ls  "), ["s3", "ls"]);
});

Deno.test("parseCommand handles double-quoted arguments", () => {
  assertEquals(
    parseCommand('ec2 describe-images --filters "Name=state,Values=available"'),
    ["ec2", "describe-images", "--filters", "Name=state,Values=available"],
  );
});

Deno.test("parseCommand handles single-quoted arguments", () => {
  assertEquals(parseCommand("ec2 describe-images --filters 'Name=state'"), [
    "ec2",
    "describe-images",
    "--filters",
    "Name=state",
  ]);
});

Deno.test("parseCommand handles mixed quotes", () => {
  assertEquals(
    parseCommand("s3 cp 's3://bucket/file with spaces.txt' \"local file.txt\""),
    ["s3", "cp", "s3://bucket/file with spaces.txt", "local file.txt"],
  );
});

Deno.test("parseCommand handles escaped characters", () => {
  assertEquals(parseCommand("s3 ls s3://bucket/path\\ with\\ spaces"), [
    "s3",
    "ls",
    "s3://bucket/path with spaces",
  ]);
});

Deno.test("parseCommand handles complex AWS CLI command", () => {
  const command =
    `ec2 describe-images --owners 099720109477 --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-*" --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text`;
  const args = parseCommand(command);
  assertEquals(args, [
    "ec2",
    "describe-images",
    "--owners",
    "099720109477",
    "--filters",
    "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-*",
    "--query",
    "sort_by(Images,&CreationDate)[-1].ImageId",
    "--output",
    "text",
  ]);
});

Deno.test("awsCliModel.methods.run validates input attributes", async () => {
  const definition = Definition.create({
    name: "test-aws-cli",
    globalArguments: { notACommand: "value" },
  });

  const context = createTestContext();

  await assertRejects(
    async () => {
      await awsCliModel.methods.run.execute(
        definition.globalArguments,
        context,
      );
    },
    Error,
  );
});
