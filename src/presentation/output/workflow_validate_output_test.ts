import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  renderWorkflowValidate,
  type WorkflowValidateData,
} from "./workflow_validate_output.ts";

await initializeLogging({});

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

Deno.test("renderWorkflowValidate with log mode does not throw", () => {
  const testData: WorkflowValidateData = {
    workflowId: "id",
    workflowName: "test",
    validations: [{ name: "Schema", passed: true }],
    passed: true,
  };

  renderWorkflowValidate(testData, "log");
});
