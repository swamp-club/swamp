import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  type ModelCreateData,
  renderModelCreate,
} from "./model_create_output.ts";

await initializeLogging({});

const testData: ModelCreateData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  type: "swamp/echo",
  name: "test-echo",
  path: "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
};

Deno.test("renderModelCreate with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelCreate(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.id, testData.id);
    assertEquals(parsed.type, testData.type);
    assertEquals(parsed.name, testData.name);
    assertEquals(parsed.path, testData.path);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelCreate with log mode does not throw", () => {
  renderModelCreate(testData, "log");
});
