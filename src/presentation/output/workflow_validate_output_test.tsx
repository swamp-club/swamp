// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  renderWorkflowValidate,
  WorkflowValidateAllDisplay,
  type WorkflowValidateData,
  WorkflowValidateDisplay,
} from "./workflow_validate_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "WorkflowValidateDisplay shows workflow name",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <WorkflowValidateDisplay
        workflowId="550e8400-e29b-41d4-a716-446655440000"
        workflowName="my-workflow"
        validations={[{ name: "Schema", passed: true }]}
        passed
      />,
    );
    assertStringIncludes(lastFrame() ?? "", "my-workflow");
  },
});

Deno.test({
  name: "WorkflowValidateDisplay shows PASSED when all pass",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <WorkflowValidateDisplay
        workflowId="id"
        workflowName="workflow"
        validations={[
          { name: "Schema", passed: true },
          { name: "Dependencies", passed: true },
        ]}
        passed
      />,
    );
    assertStringIncludes(lastFrame() ?? "", "PASSED");
  },
});

Deno.test({
  name: "WorkflowValidateDisplay shows FAILED when any fail",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <WorkflowValidateDisplay
        workflowId="id"
        workflowName="workflow"
        validations={[
          { name: "Schema", passed: false, error: "Invalid" },
        ]}
        passed={false}
      />,
    );
    assertStringIncludes(lastFrame() ?? "", "FAILED");
  },
});

Deno.test({
  name: "WorkflowValidateDisplay shows error message",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <WorkflowValidateDisplay
        workflowId="id"
        workflowName="workflow"
        validations={[
          { name: "Schema", passed: false, error: "Missing required field" },
        ]}
        passed={false}
      />,
    );
    assertStringIncludes(lastFrame() ?? "", "Missing required field");
  },
});

Deno.test({
  name: "WorkflowValidateDisplay shows summary count",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <WorkflowValidateDisplay
        workflowId="id"
        workflowName="workflow"
        validations={[
          { name: "V1", passed: true },
          { name: "V2", passed: true },
          { name: "V3", passed: false },
        ]}
        passed={false}
      />,
    );
    assertStringIncludes(lastFrame() ?? "", "2/3");
  },
});

Deno.test({
  name: "WorkflowValidateAllDisplay shows all workflows",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <WorkflowValidateAllDisplay
        workflows={[
          {
            workflowId: "id1",
            workflowName: "workflow-1",
            validations: [{ name: "V1", passed: true }],
            passed: true,
          },
          {
            workflowId: "id2",
            workflowName: "workflow-2",
            validations: [{ name: "V1", passed: true }],
            passed: true,
          },
        ]}
        totalPassed={2}
        totalFailed={0}
        passed
      />,
    );
    const frame = lastFrame() ?? "";
    assertStringIncludes(frame, "workflow-1");
    assertStringIncludes(frame, "workflow-2");
  },
});

Deno.test({
  name: "WorkflowValidateAllDisplay shows overall PASSED",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <WorkflowValidateAllDisplay
        workflows={[]}
        totalPassed={2}
        totalFailed={0}
        passed
      />,
    );
    assertStringIncludes(lastFrame() ?? "", "Overall");
    assertStringIncludes(lastFrame() ?? "", "PASSED");
  },
});

Deno.test({
  name: "WorkflowValidateAllDisplay shows overall FAILED",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <WorkflowValidateAllDisplay
        workflows={[]}
        totalPassed={1}
        totalFailed={1}
        passed={false}
      />,
    );
    assertStringIncludes(lastFrame() ?? "", "FAILED");
  },
});

Deno.test("renderWorkflowValidate with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  const testData: WorkflowValidateData = {
    workflowId: "id",
    workflowName: "test",
    validations: [{ name: "Schema", passed: true }],
    passed: true,
  };

  try {
    renderWorkflowValidate(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.workflowName, "test");
    assertEquals(parsed.passed, true);
  } finally {
    console.log = originalLog;
  }
});
