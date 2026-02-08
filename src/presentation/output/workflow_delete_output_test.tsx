// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  renderWorkflowDelete,
  renderWorkflowDeleteCancelled,
  type WorkflowDeleteData,
  WorkflowDeleteDisplay,
} from "./workflow_delete_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testData: WorkflowDeleteData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "test-workflow",
  workflowPath:
    ".swamp/workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml",
  runsDeleted: 0,
};

const testDataWithRuns: WorkflowDeleteData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "test-workflow",
  workflowPath:
    ".swamp/workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml",
  runsDeleted: 5,
};

Deno.test({
  name: "WorkflowDeleteDisplay renders all fields",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowDeleteDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "test-workflow");
    assertStringIncludes(output, "550e8400-e29b-41d4-a716-446655440000");
  },
});

Deno.test({
  name: "WorkflowDeleteDisplay shows 'Deleted workflow' message",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowDeleteDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Deleted workflow");
  },
});

Deno.test({
  name: "WorkflowDeleteDisplay shows runs deleted count when > 0",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <WorkflowDeleteDisplay {...testDataWithRuns} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Runs deleted");
    assertStringIncludes(output, "5");
  },
});

Deno.test({
  name: "WorkflowDeleteDisplay does not show runs deleted when count is 0",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowDeleteDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertEquals(output.includes("Runs deleted"), false);
  },
});

Deno.test("renderWorkflowDelete with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderWorkflowDelete(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.deleted.id, testData.id);
    assertEquals(parsed.deleted.name, testData.name);
    assertEquals(parsed.deleted.workflowPath, testData.workflowPath);
    assertEquals(parsed.runsDeleted, 0);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderWorkflowDelete with json mode includes runsDeleted count", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderWorkflowDelete(testDataWithRuns, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.runsDeleted, 5);
  } finally {
    console.log = originalLog;
  }
});

Deno.test({
  name:
    "renderWorkflowDeleteCancelled shows cancellation message in interactive mode",
  ...inkTestOptions,
  fn: () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderWorkflowDeleteCancelled("interactive");
      assertEquals(logs.length, 1);
      assertStringIncludes(logs[0], "Deletion cancelled");
    } finally {
      console.log = originalLog;
    }
  },
});

Deno.test("renderWorkflowDeleteCancelled outputs JSON in json mode", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderWorkflowDeleteCancelled("json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.cancelled, true);
  } finally {
    console.log = originalLog;
  }
});
