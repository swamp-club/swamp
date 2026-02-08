// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  type ModelDeleteData,
  ModelDeleteDisplay,
  renderModelDelete,
  renderModelDeleteCancelled,
} from "./model_delete_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testData: ModelDeleteData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "test-echo",
  type: "swamp/echo",
  inputPath: "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
  resourceDeleted: false,
  outputsDeleted: 0,
  evaluatedInputDeleted: false,
  dataDeleted: false,
};

const testDataWithResource: ModelDeleteData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "test-echo",
  type: "swamp/echo",
  inputPath: "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
  resourcePath: "resources/swamp/echo/resource-id.yaml",
  resourceDeleted: true,
  outputsDeleted: 0,
  evaluatedInputDeleted: false,
  dataDeleted: false,
};

const testDataWithAllArtifacts: ModelDeleteData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "test-echo",
  type: "swamp/echo",
  inputPath: "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
  resourcePath: "resources/swamp/echo/resource-id.yaml",
  resourceDeleted: true,
  outputsDeleted: 5,
  evaluatedInputDeleted: true,
  dataDeleted: true,
};

Deno.test({
  name: "ModelDeleteDisplay renders all fields",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelDeleteDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "swamp/echo");
    assertStringIncludes(output, "test-echo");
    assertStringIncludes(output, "550e8400-e29b-41d4-a716-446655440000");
  },
});

Deno.test({
  name: "ModelDeleteDisplay shows 'Deleted model' message",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelDeleteDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Deleted model");
  },
});

Deno.test({
  name:
    "ModelDeleteDisplay shows resource deleted when resourceDeleted is true",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelDeleteDisplay {...testDataWithResource} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Resource deleted");
    assertStringIncludes(output, "resources/swamp/echo/resource-id.yaml");
  },
});

Deno.test({
  name:
    "ModelDeleteDisplay does not show resource when resourceDeleted is false",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelDeleteDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertEquals(output.includes("Resource deleted"), false);
  },
});

Deno.test({
  name: "ModelDeleteDisplay shows outputs deleted count when > 0",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelDeleteDisplay {...testDataWithAllArtifacts} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Outputs deleted");
    assertStringIncludes(output, "5");
  },
});

Deno.test({
  name: "ModelDeleteDisplay does not show outputs when count is 0",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelDeleteDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertEquals(output.includes("Outputs deleted"), false);
  },
});

Deno.test({
  name: "ModelDeleteDisplay shows evaluated input deleted when true",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelDeleteDisplay {...testDataWithAllArtifacts} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Evaluated input deleted");
  },
});

Deno.test({
  name: "ModelDeleteDisplay shows data artifact deleted when true",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelDeleteDisplay {...testDataWithAllArtifacts} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Data artifact deleted");
  },
});

Deno.test("renderModelDelete with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelDelete(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.deleted.id, testData.id);
    assertEquals(parsed.deleted.type, testData.type);
    assertEquals(parsed.deleted.name, testData.name);
    assertEquals(parsed.deleted.inputPath, testData.inputPath);
    assertEquals(parsed.resourceDeleted, false);
    assertEquals(parsed.outputsDeleted, 0);
    assertEquals(parsed.evaluatedInputDeleted, false);
    assertEquals(parsed.dataDeleted, false);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelDelete with json mode includes resourcePath when resource deleted", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelDelete(testDataWithResource, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(
      parsed.deleted.resourcePath,
      testDataWithResource.resourcePath,
    );
    assertEquals(parsed.resourceDeleted, true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelDelete with json mode includes all artifact counts", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelDelete(testDataWithAllArtifacts, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.outputsDeleted, 5);
    assertEquals(parsed.evaluatedInputDeleted, true);
    assertEquals(parsed.dataDeleted, true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test({
  name:
    "renderModelDeleteCancelled shows cancellation message in interactive mode",
  ...inkTestOptions,
  fn: () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderModelDeleteCancelled("interactive");
      assertEquals(logs.length, 1);
      assertStringIncludes(logs[0], "Deletion cancelled");
    } finally {
      console.log = originalLog;
    }
  },
});

Deno.test("renderModelDeleteCancelled outputs JSON in json mode", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelDeleteCancelled("json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.cancelled, true);
  } finally {
    console.log = originalLog;
  }
});
