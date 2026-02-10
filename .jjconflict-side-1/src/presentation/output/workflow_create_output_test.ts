import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  renderWorkflowCreate,
  type WorkflowCreateData,
} from "./workflow_create_output.ts";

await initializeLogging({});

const testData: WorkflowCreateData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "my-workflow",
  path: "workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml",
};

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

Deno.test("renderWorkflowCreate with log mode does not throw", () => {
  renderWorkflowCreate(testData, "log");
});
