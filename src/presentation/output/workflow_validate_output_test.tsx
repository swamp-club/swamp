// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  WorkflowValidateDisplay,
  WorkflowValidateAllDisplay,
} from "./workflow_validate_output.tsx";

Deno.test("WorkflowValidateDisplay shows workflow name", () => {
  const { lastFrame } = render(
    <WorkflowValidateDisplay
      workflowId="550e8400-e29b-41d4-a716-446655440000"
      workflowName="my-workflow"
      validations={[{ name: "Schema", passed: true }]}
      passed={true}
    />,
  );

  assertStringIncludes(lastFrame() ?? "", "my-workflow");
});

Deno.test("WorkflowValidateDisplay shows PASSED when all pass", () => {
  const { lastFrame } = render(
    <WorkflowValidateDisplay
      workflowId="id"
      workflowName="workflow"
      validations={[
        { name: "Schema", passed: true },
        { name: "Dependencies", passed: true },
      ]}
      passed={true}
    />,
  );

  assertStringIncludes(lastFrame() ?? "", "PASSED");
});

Deno.test("WorkflowValidateDisplay shows FAILED when any fail", () => {
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
});

Deno.test("WorkflowValidateDisplay shows error message", () => {
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
});

Deno.test("WorkflowValidateDisplay shows summary count", () => {
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
});

Deno.test("WorkflowValidateAllDisplay shows all workflows", () => {
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
      passed={true}
    />,
  );

  const frame = lastFrame() ?? "";
  assertStringIncludes(frame, "workflow-1");
  assertStringIncludes(frame, "workflow-2");
});

Deno.test("WorkflowValidateAllDisplay shows overall PASSED", () => {
  const { lastFrame } = render(
    <WorkflowValidateAllDisplay
      workflows={[]}
      totalPassed={2}
      totalFailed={0}
      passed={true}
    />,
  );

  assertStringIncludes(lastFrame() ?? "", "Overall");
  assertStringIncludes(lastFrame() ?? "", "PASSED");
});

Deno.test("WorkflowValidateAllDisplay shows overall FAILED", () => {
  const { lastFrame } = render(
    <WorkflowValidateAllDisplay
      workflows={[]}
      totalPassed={1}
      totalFailed={1}
      passed={false}
    />,
  );

  assertStringIncludes(lastFrame() ?? "", "FAILED");
});
