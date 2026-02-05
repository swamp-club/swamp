import { assertEquals } from "@std/assert";
import { createWorkflowId, createWorkflowRunId } from "./workflow_id.ts";

Deno.test("createWorkflowId creates branded type", () => {
  const id = createWorkflowId("550e8400-e29b-41d4-a716-446655440000");
  assertEquals(typeof id, "string");
  assertEquals(id, "550e8400-e29b-41d4-a716-446655440000");
});

Deno.test("createWorkflowRunId creates branded type", () => {
  const id = createWorkflowRunId("550e8400-e29b-41d4-a716-446655440001");
  assertEquals(typeof id, "string");
  assertEquals(id, "550e8400-e29b-41d4-a716-446655440001");
});
