import { assertEquals } from "@std/assert";
import { listTypes } from "./types_handler.ts";

Deno.test("listTypes returns JSON response with types array", async () => {
  const request = new Request("http://localhost/api/v1/types");
  const response = listTypes({ request, params: {} });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Content-Type"), "application/json");

  const body = await response.json();
  assertEquals(Array.isArray(body.types), true);

  // Each type should have raw and normalized properties
  if (body.types.length > 0) {
    const firstType = body.types[0];
    assertEquals(typeof firstType.raw, "string");
    assertEquals(typeof firstType.normalized, "string");
  }
});
