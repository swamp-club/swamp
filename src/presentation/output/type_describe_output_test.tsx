// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  renderTypeDescribe,
  type TypeDescribeData,
  TypeDescribeDisplay,
} from "./type_describe_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testData: TypeDescribeData = {
  type: {
    raw: "swamp/echo",
    normalized: "swamp/echo",
  },
  version: 1,
  inputAttributesSchema: {
    type: "object",
    properties: {
      message: { type: "string", minLength: 1 },
    },
    required: ["message"],
  },
  resourceAttributesSchema: {
    type: "object",
    properties: {
      message: { type: "string" },
      timestamp: { type: "string", format: "date-time" },
    },
    required: ["message", "timestamp"],
  },
  methods: [
    {
      name: "write",
      description: "Write the input message to a resource with a timestamp",
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

Deno.test({
  name: "TypeDescribeDisplay renders type name",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<TypeDescribeDisplay data={testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "swamp/echo");
  },
});

Deno.test({
  name: "TypeDescribeDisplay renders version",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<TypeDescribeDisplay data={testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Version:");
    assertStringIncludes(output, "1");
  },
});

Deno.test({
  name: "TypeDescribeDisplay renders schema sections",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<TypeDescribeDisplay data={testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Input Attributes Schema");
    assertStringIncludes(output, "Resource Attributes Schema");
  },
});

Deno.test({
  name: "TypeDescribeDisplay renders methods",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<TypeDescribeDisplay data={testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Methods");
    assertStringIncludes(output, "write");
    assertStringIncludes(
      output,
      "Write the input message to a resource with a timestamp",
    );
  },
});

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
