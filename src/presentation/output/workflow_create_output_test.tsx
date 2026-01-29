// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import { WorkflowCreateDisplay } from "./workflow_create_output.tsx";

Deno.test("WorkflowCreateDisplay renders name", () => {
  const { lastFrame } = render(
    <WorkflowCreateDisplay
      id="550e8400-e29b-41d4-a716-446655440000"
      name="my-workflow"
      path="workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml"
    />,
  );

  assertStringIncludes(lastFrame() ?? "", "my-workflow");
});

Deno.test("WorkflowCreateDisplay renders id", () => {
  const { lastFrame } = render(
    <WorkflowCreateDisplay
      id="550e8400-e29b-41d4-a716-446655440000"
      name="my-workflow"
      path="workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml"
    />,
  );

  assertStringIncludes(lastFrame() ?? "", "550e8400-e29b-41d4-a716-446655440000");
});

Deno.test("WorkflowCreateDisplay renders path", () => {
  const { lastFrame } = render(
    <WorkflowCreateDisplay
      id="550e8400-e29b-41d4-a716-446655440000"
      name="my-workflow"
      path="workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml"
    />,
  );

  assertStringIncludes(lastFrame() ?? "", "workflows/workflow-550e8400");
});

Deno.test("WorkflowCreateDisplay shows Created message", () => {
  const { lastFrame } = render(
    <WorkflowCreateDisplay
      id="550e8400-e29b-41d4-a716-446655440000"
      name="my-workflow"
      path="workflows/workflow.yaml"
    />,
  );

  assertStringIncludes(lastFrame() ?? "", "Created workflow");
});
