import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { type ModelGetData, renderModelGet } from "./model_get_output.ts";

await initializeLogging({});

const testDataWithoutResource: ModelGetData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "test-echo",
  type: "swamp/echo",
  version: 1,
  tags: { env: "test", project: "demo" },
  attributes: { message: "Hello World" },
};

const testDataWithResource: ModelGetData = {
  ...testDataWithoutResource,
  resource: {
    id: "660e8400-e29b-41d4-a716-446655440001",
    createdAt: "2024-01-15T10:30:00.000Z",
    attributes: { result: "processed", timestamp: "2024-01-15T10:30:00.000Z" },
  },
};

Deno.test("renderModelGet with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelGet(testDataWithoutResource, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.id, testDataWithoutResource.id);
    assertEquals(parsed.name, testDataWithoutResource.name);
    assertEquals(parsed.type, testDataWithoutResource.type);
    assertEquals(parsed.version, testDataWithoutResource.version);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelGet JSON includes resource when present", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelGet(testDataWithResource, "json");
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.resource.id, "660e8400-e29b-41d4-a716-446655440001");
    assertEquals(parsed.resource.createdAt, "2024-01-15T10:30:00.000Z");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelGet JSON includes tags and attributes", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelGet(testDataWithoutResource, "json");
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.tags.env, "test");
    assertEquals(parsed.tags.project, "demo");
    assertEquals(parsed.attributes.message, "Hello World");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelGet with log mode does not throw", () => {
  renderModelGet(testDataWithoutResource, "log");
});
