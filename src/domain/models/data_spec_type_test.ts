import { assertEquals, assertThrows } from "@std/assert";
import { DataSpecType, normalizeSpecType } from "./model.ts";

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

Deno.test("normalizeSpecType - converts string to DataSpecType", () => {
  const result = normalizeSpecType("data");
  assertEquals(result.value, "data");
});

Deno.test("normalizeSpecType - passes through existing DataSpecType", () => {
  const original = DataSpecType.create("resource");
  const result = normalizeSpecType(original);
  assertEquals(result, original);
});

Deno.test("normalizeSpecType - trims whitespace from string", () => {
  const result = normalizeSpecType("  data  ");
  assertEquals(result.value, "data");
});

Deno.test("normalizeSpecType - throws on empty string", () => {
  assertThrows(
    () => normalizeSpecType(""),
    Error,
    "Data spec type cannot be empty",
  );
});

Deno.test("normalizeSpecType - throws on whitespace-only string", () => {
  assertThrows(
    () => normalizeSpecType("   "),
    Error,
    "Data spec type cannot be empty",
  );
});
