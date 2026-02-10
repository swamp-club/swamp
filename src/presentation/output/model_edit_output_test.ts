import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { type ModelEditData, renderModelEdit } from "./model_edit_output.ts";

await initializeLogging({});

const testInputData: ModelEditData = {
  path: "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
  editor: "VS Code",
  status: "opened",
  name: "test-echo",
  type: "swamp/echo",
  editType: "input",
};

Deno.test("renderModelEdit with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelEdit(testInputData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.path, testInputData.path);
    assertEquals(parsed.editor, testInputData.editor);
    assertEquals(parsed.status, testInputData.status);
    assertEquals(parsed.name, testInputData.name);
    assertEquals(parsed.type, testInputData.type);
    assertEquals(parsed.editType, testInputData.editType);
  } finally {
    console.log = originalLog;
  }
});

Deno.test(
  "renderModelEdit with json mode outputs valid JSON for updated status",
  () => {
    const updatedData: ModelEditData = {
      path: "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
      status: "updated",
      name: "test-echo",
      type: "swamp/echo",
      editType: "definition",
    };
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderModelEdit(updatedData, "json");
      assertEquals(logs.length, 1);
      const parsed = JSON.parse(logs[0]);
      assertEquals(parsed.path, updatedData.path);
      assertEquals(parsed.status, "updated");
      assertEquals(parsed.name, updatedData.name);
      assertEquals(parsed.type, updatedData.type);
      assertEquals(parsed.editType, updatedData.editType);
      assertEquals(parsed.editor, undefined);
    } finally {
      console.log = originalLog;
    }
  },
);

Deno.test("renderModelEdit with log mode does not throw", () => {
  renderModelEdit(testInputData, "log");
});
