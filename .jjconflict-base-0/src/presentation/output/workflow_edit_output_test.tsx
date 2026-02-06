// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  renderWorkflowEdit,
  type WorkflowEditData,
  WorkflowEditDisplay,
} from "./workflow_edit_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testData: WorkflowEditData = {
  path: "workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml",
  editor: "VS Code",
  status: "opened",
  name: "test-workflow",
  id: "550e8400-e29b-41d4-a716-446655440000",
};

Deno.test({
  name: "WorkflowEditDisplay renders all fields",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowEditDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "test-workflow");
    assertStringIncludes(output, "550e8400-e29b-41d4-a716-446655440000");
    assertStringIncludes(output, "VS Code");
    assertStringIncludes(
      output,
      "workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml",
    );
  },
});

Deno.test({
  name: "WorkflowEditDisplay shows 'Opening workflow' message",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowEditDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Opening workflow");
  },
});

Deno.test("renderWorkflowEdit with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderWorkflowEdit(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.path, testData.path);
    assertEquals(parsed.editor, testData.editor);
    assertEquals(parsed.status, testData.status);
    assertEquals(parsed.name, testData.name);
    assertEquals(parsed.id, testData.id);
  } finally {
    console.log = originalLog;
  }
});

Deno.test({
  name:
    "WorkflowEditDisplay shows 'Updated workflow' message for updated status",
  ...inkTestOptions,
  fn: () => {
    const updatedData: WorkflowEditData = {
      path: "workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml",
      status: "updated",
      name: "test-workflow",
      id: "550e8400-e29b-41d4-a716-446655440000",
    };
    const { lastFrame } = render(<WorkflowEditDisplay {...updatedData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Updated workflow from stdin");
  },
});

Deno.test(
  "renderWorkflowEdit with json mode outputs valid JSON for updated status",
  () => {
    const updatedData: WorkflowEditData = {
      path: "workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml",
      status: "updated",
      name: "test-workflow",
      id: "550e8400-e29b-41d4-a716-446655440000",
    };
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderWorkflowEdit(updatedData, "json");
      assertEquals(logs.length, 1);
      const parsed = JSON.parse(logs[0]);
      assertEquals(parsed.path, updatedData.path);
      assertEquals(parsed.status, "updated");
      assertEquals(parsed.name, updatedData.name);
      assertEquals(parsed.id, updatedData.id);
      assertEquals(parsed.editor, undefined);
    } finally {
      console.log = originalLog;
    }
  },
);
