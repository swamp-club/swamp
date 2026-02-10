import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  renderTypeDescribe,
  type TypeDescribeData,
} from "./type_describe_output.ts";

await initializeLogging({});

const testData: TypeDescribeData = {
  type: {
    raw: "swamp/echo",
    normalized: "swamp/echo",
  },
  version: "2026.02.09.1",
  inputAttributesSchema: {
    type: "object",
    properties: {
      message: { type: "string", minLength: 1 },
    },
    required: ["message"],
  },
  methods: [
    {
      name: "write",
      description:
        "Write the definition message to a data artifact with a timestamp",
      inputAttributesSchema: {
        type: "object",
        properties: {
          message: { type: "string", minLength: 1 },
        },
        required: ["message"],
      },
    },
  ],
};

const testDataWithSpecs: TypeDescribeData = {
  type: {
    raw: "AWS::EC2::VPC",
    normalized: "aws/ec2/vpc",
  },
  version: "2026.01.15.1",
  inputAttributesSchema: {
    type: "object",
    properties: {
      cidrBlock: { type: "string" },
      enableDnsSupport: { type: "boolean" },
    },
    required: ["cidrBlock"],
  },
  methods: [
    {
      name: "create",
      description: "Create a new VPC",
      inputAttributesSchema: {
        type: "object",
        properties: {
          cidrBlock: { type: "string" },
        },
        required: ["cidrBlock"],
      },
      dataOutputSpecs: [
        {
          specType: "vpc",
          description: "VPC resource state",
          contentType: "application/json",
          lifetime: "persistent",
        },
      ],
    },
  ],
};

Deno.test("renderTypeDescribe with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderTypeDescribe(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.type.raw, testData.type.raw);
    assertEquals(parsed.type.normalized, testData.type.normalized);
    assertEquals(parsed.version, testData.version);
    assertEquals(parsed.methods.length, 1);
    assertEquals(parsed.methods[0].name, "write");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderTypeDescribe with log mode outputs plain text, not JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderTypeDescribe(testData, "log");
    const combined = stripAnsiCode(logs.join("\n"));
    assertStringIncludes(combined, "Type:");
    assertStringIncludes(combined, "swamp/echo");
    assertStringIncludes(combined, "Version:");
    assertStringIncludes(combined, "Methods:");
    assertStringIncludes(combined, "write");
    assertThrows(() => JSON.parse(combined), SyntaxError);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderTypeDescribe with log mode does not throw", () => {
  renderTypeDescribe(testData, "log");
});

Deno.test("renderTypeDescribe log mode with different raw and normalized names", () => {
  renderTypeDescribe(testDataWithSpecs, "log");
});

Deno.test("renderTypeDescribe log mode with data output specs", () => {
  renderTypeDescribe(testDataWithSpecs, "log");
});
