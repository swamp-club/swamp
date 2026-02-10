import { assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  type ModelCreateData,
  renderModelCreate,
} from "./model_create_output.ts";

await initializeLogging({});

const testData: ModelCreateData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  type: "swamp/echo",
  name: "test-echo",
  path: "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
};

const testDataWithTypeInfo: ModelCreateData = {
  ...testData,
  version: "2026.02.09.1",
  inputAttributesSchema: {
    type: "object",
    properties: {
      message: { type: "string" },
    },
    required: ["message"],
  },
  methods: [
    {
      name: "write",
      description: "Write a message",
      inputAttributesSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      dataOutputSpecs: [
        {
          specType: "message",
          description: "Echo output",
          contentType: "application/json",
          lifetime: "ephemeral",
        },
      ],
    },
  ],
};

Deno.test("renderModelCreate with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelCreate(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.id, testData.id);
    assertEquals(parsed.type, testData.type);
    assertEquals(parsed.name, testData.name);
    assertEquals(parsed.path, testData.path);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelCreate with log mode does not throw", () => {
  renderModelCreate(testData, "log");
});

Deno.test("renderModelCreate with log mode shows type info when provided", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelCreate(testDataWithTypeInfo, "log");
    const combined = stripAnsiCode(logs.join("\n"));
    assertStringIncludes(combined, "Version:");
    assertStringIncludes(combined, "Input Attributes:");
    assertStringIncludes(combined, "message");
    assertStringIncludes(combined, "Methods:");
    assertStringIncludes(combined, "write");
    assertStringIncludes(combined, "Data Outputs:");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelCreate json mode includes type info fields", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelCreate(testDataWithTypeInfo, "json");
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.version, "2026.02.09.1");
    assertEquals(parsed.methods.length, 1);
    assertEquals(parsed.methods[0].name, "write");
  } finally {
    console.log = originalLog;
  }
});
