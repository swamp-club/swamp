import { assertEquals } from "@std/assert";
import { isUuid } from "./model_lookup.ts";

Deno.test("isUuid returns true for valid UUID v4", () => {
  assertEquals(isUuid("550e8400-e29b-41d4-a716-446655440000"), true);
  assertEquals(isUuid("6ba7b810-9dad-41d4-80b4-00c04fd430c8"), true);
  assertEquals(isUuid("f47ac10b-58cc-4372-a567-0e02b2c3d479"), true);
});

Deno.test("isUuid is case insensitive", () => {
  assertEquals(isUuid("550E8400-E29B-41D4-A716-446655440000"), true);
  assertEquals(isUuid("550e8400-E29B-41d4-a716-446655440000"), true);
});

Deno.test("isUuid returns false for invalid UUIDs", () => {
  // Not a UUID at all
  assertEquals(isUuid("hello"), false);
  assertEquals(isUuid("my-model-name"), false);

  // Wrong length
  assertEquals(isUuid("550e8400-e29b-41d4-a716-44665544000"), false);
  assertEquals(isUuid("550e8400-e29b-41d4-a716-4466554400000"), false);

  // Wrong format (missing dashes)
  assertEquals(isUuid("550e8400e29b41d4a716446655440000"), false);

  // Not a v4 UUID (version digit is not 4)
  assertEquals(isUuid("550e8400-e29b-11d4-a716-446655440000"), false);
  assertEquals(isUuid("550e8400-e29b-51d4-a716-446655440000"), false);

  // Invalid variant (4th group must start with 8, 9, a, or b)
  assertEquals(isUuid("550e8400-e29b-41d4-0716-446655440000"), false);
  assertEquals(isUuid("550e8400-e29b-41d4-c716-446655440000"), false);
});

Deno.test("isUuid returns false for empty string", () => {
  assertEquals(isUuid(""), false);
});
