import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  renderWorkflowEdit,
  type WorkflowEditData,
} from "./workflow_edit_output.ts";

await initializeLogging({});

const testData: WorkflowEditData = {
  path: "workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml",
  editor: "VS Code",
  status: "opened",
  name: "test-workflow",
  id: "550e8400-e29b-41d4-a716-446655440000",
};

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

Deno.test("renderWorkflowEdit with log mode does not throw", () => {
  renderWorkflowEdit(testData, "log");
});
