import { assertEquals, assertThrows } from "@std/assert";
import { DataSpecType } from "./model.ts";

Deno.test("DataSpecType - create - trims whitespace", () => {
  const specType = DataSpecType.create("  message  ");
  assertEquals(specType.value, "message");
});

Deno.test("DataSpecType - create - rejects empty string", () => {
  assertThrows(
    () => DataSpecType.create(""),
    Error,
    "Data spec type cannot be empty",
  );
});

Deno.test("DataSpecType - create - rejects whitespace-only string", () => {
  assertThrows(
    () => DataSpecType.create("   "),
    Error,
    "Data spec type cannot be empty",
  );
});

Deno.test("DataSpecType - equals - returns true for same value", () => {
  const spec1 = DataSpecType.create("message");
  const spec2 = DataSpecType.create("message");
  assertEquals(spec1.equals(spec2), true);
});

Deno.test("DataSpecType - equals - returns false for different value", () => {
  const spec1 = DataSpecType.create("message");
  const spec2 = DataSpecType.create("log");
  assertEquals(spec1.equals(spec2), false);
});

Deno.test("DataSpecType - toString - returns value", () => {
  const specType = DataSpecType.create("message");
  assertEquals(specType.toString(), "message");
});
