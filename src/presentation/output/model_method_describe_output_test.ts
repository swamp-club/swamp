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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  type ModelMethodDescribeData,
  renderModelMethodDescribe,
} from "./model_method_describe_output.ts";

await initializeLogging({});

const testData: ModelMethodDescribeData = {
  modelName: "my-server",
  modelType: "swamp/echo",
  version: "2026.02.09.1",
  method: {
    name: "write",
    description:
      "Write the definition message to a data artifact with a timestamp",
    arguments: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to write" },
      },
      required: ["message"],
    },
  },
};

const testDataWithSpecs: ModelMethodDescribeData = {
  modelName: "my-vpc",
  modelType: "aws/ec2/vpc",
  version: "2026.01.15.1",
  method: {
    name: "create",
    description: "Create a new VPC",
    arguments: {
      type: "object",
      properties: {
        cidrBlock: { type: "string" },
      },
      required: ["cidrBlock"],
    },
    dataOutputSpecs: [
      {
        specName: "resource",
        kind: "resource" as const,
        description: "VPC resource state",
        contentType: "application/json",
        lifetime: "persistent",
      },
    ],
  },
};

Deno.test("renderModelMethodDescribe with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelMethodDescribe(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.modelName, "my-server");
    assertEquals(parsed.modelType, "swamp/echo");
    assertEquals(parsed.version, "2026.02.09.1");
    assertEquals(parsed.method.name, "write");
    assertEquals(
      parsed.method.description,
      "Write the definition message to a data artifact with a timestamp",
    );
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelMethodDescribe with log mode outputs plain text, not JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelMethodDescribe(testData, "log");
    const combined = stripAnsiCode(logs.join("\n"));
    assertStringIncludes(combined, "Model:");
    assertStringIncludes(combined, "my-server");
    assertStringIncludes(combined, "Type:");
    assertStringIncludes(combined, "swamp/echo");
    assertStringIncludes(combined, "Version:");
    assertStringIncludes(combined, "Method:");
    assertStringIncludes(combined, "write");
    assertStringIncludes(combined, "Arguments:");
    assertStringIncludes(combined, "message");
    assertThrows(() => JSON.parse(combined), SyntaxError);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelMethodDescribe with log mode does not throw", () => {
  renderModelMethodDescribe(testData, "log");
});

Deno.test("renderModelMethodDescribe log mode with data output specs", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelMethodDescribe(testDataWithSpecs, "log");
    const combined = stripAnsiCode(logs.join("\n"));
    assertStringIncludes(combined, "Data Outputs:");
    assertStringIncludes(combined, "resource");
    assertStringIncludes(combined, "VPC resource state");
  } finally {
    console.log = originalLog;
  }
});
