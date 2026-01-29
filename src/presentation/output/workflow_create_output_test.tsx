// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  renderWorkflowCreate,
  type WorkflowCreateData,
  WorkflowCreateDisplay,
} from "./workflow_create_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testData: WorkflowCreateData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "my-workflow",
  path: "workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml",
};

Deno.test({
  name: "WorkflowCreateDisplay renders name",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowCreateDisplay {...testData} />);
    assertStringIncludes(lastFrame() ?? "", "my-workflow");
  },
});

Deno.test({
  name: "WorkflowCreateDisplay renders id",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowCreateDisplay {...testData} />);
    assertStringIncludes(
      lastFrame() ?? "",
      "550e8400-e29b-41d4-a716-446655440000",
    );
  },
});

Deno.test({
  name: "WorkflowCreateDisplay renders path",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowCreateDisplay {...testData} />);
    assertStringIncludes(lastFrame() ?? "", "workflows/workflow-550e8400");
  },
});

Deno.test({
  name: "WorkflowCreateDisplay shows Created message",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowCreateDisplay {...testData} />);
    assertStringIncludes(lastFrame() ?? "", "Created workflow");
  },
});

Deno.test("renderWorkflowCreate with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderWorkflowCreate(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.id, testData.id);
    assertEquals(parsed.name, testData.name);
    assertEquals(parsed.path, testData.path);
  } finally {
    console.log = originalLog;
  }
});
