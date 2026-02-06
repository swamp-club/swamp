// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  renderWorkflowSchema,
  type WorkflowSchemaData,
  WorkflowSchemaDisplay,
} from "./workflow_schema_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testData: WorkflowSchemaData = {
  workflow: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string", minLength: 1 },
    },
    required: ["id", "name"],
  },
  job: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      steps: { type: "array" },
    },
    required: ["name", "steps"],
  },
  jobDependency: {
    type: "object",
    properties: {
      job: { type: "string" },
      condition: { type: "object" },
    },
    required: ["job", "condition"],
  },
  step: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      task: { type: "object" },
    },
    required: ["name", "task"],
  },
  stepDependency: {
    type: "object",
    properties: {
      step: { type: "string" },
      condition: { type: "object" },
    },
    required: ["step", "condition"],
  },
  stepTask: {
    oneOf: [
      { type: "object", properties: { type: { const: "shell" } } },
      { type: "object", properties: { type: { const: "model_method" } } },
    ],
  },
  triggerCondition: {
    oneOf: [
      { type: "object", properties: { type: { const: "always" } } },
      { type: "object", properties: { type: { const: "succeeded" } } },
    ],
  },
};

Deno.test({
  name: "WorkflowSchemaDisplay renders header",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowSchemaDisplay data={testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Workflow Schema");
  },
});

Deno.test({
  name: "WorkflowSchemaDisplay renders workflow section",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowSchemaDisplay data={testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "## Workflow");
    assertStringIncludes(output, "Top-level workflow structure");
  },
});

Deno.test({
  name: "WorkflowSchemaDisplay renders job section",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowSchemaDisplay data={testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "## Job");
    assertStringIncludes(output, "Job definition");
  },
});

Deno.test({
  name: "WorkflowSchemaDisplay renders step section",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowSchemaDisplay data={testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "## Step");
    assertStringIncludes(output, "Step definition");
  },
});

Deno.test({
  name: "WorkflowSchemaDisplay renders stepTask section",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowSchemaDisplay data={testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "## Step Task");
    assertStringIncludes(output, "Discriminated union");
  },
});

Deno.test({
  name: "WorkflowSchemaDisplay renders triggerCondition section",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<WorkflowSchemaDisplay data={testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "## Trigger Condition");
  },
});

Deno.test("renderWorkflowSchema with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderWorkflowSchema(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(typeof parsed.workflow, "object");
    assertEquals(typeof parsed.job, "object");
    assertEquals(typeof parsed.step, "object");
    assertEquals(typeof parsed.stepTask, "object");
    assertEquals(typeof parsed.triggerCondition, "object");
  } finally {
    console.log = originalLog;
  }
});
