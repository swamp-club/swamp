// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  type ModelCreateData,
  ModelCreateDisplay,
  renderModelCreate,
} from "./model_create_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testData: ModelCreateData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  type: "swamp/echo",
  name: "test-echo",
  path: "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
};

Deno.test({
  name: "ModelCreateDisplay renders all fields",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelCreateDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "swamp/echo");
    assertStringIncludes(output, "test-echo");
    assertStringIncludes(output, "550e8400-e29b-41d4-a716-446655440000");
  },
});

Deno.test({
  name: "ModelCreateDisplay shows 'Created model input' message",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelCreateDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Created model input");
  },
});

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
