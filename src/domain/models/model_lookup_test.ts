import { assertEquals } from "@std/assert";
import { isPartialId, isUuid, matchByPartialId } from "./model_lookup.ts";

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

// isPartialId tests

Deno.test("isPartialId returns true for valid partial IDs (3+ hex chars)", () => {
  assertEquals(isPartialId("abc"), true);
  assertEquals(isPartialId("5ec"), true);
  assertEquals(isPartialId("5ece291"), true);
  assertEquals(isPartialId("5ece291a-46c0"), true);
});

Deno.test("isPartialId returns true for full UUIDs", () => {
  assertEquals(isPartialId("550e8400-e29b-41d4-a716-446655440000"), true);
});

Deno.test("isPartialId returns false for too short strings", () => {
  assertEquals(isPartialId("ab"), false);
  assertEquals(isPartialId("5"), false);
  assertEquals(isPartialId(""), false);
});

Deno.test("isPartialId returns false for non-hex characters", () => {
  assertEquals(isPartialId("xyz"), false);
  assertEquals(isPartialId("model-name"), false);
  assertEquals(isPartialId("5ec_test"), false);
});

Deno.test("isPartialId is case insensitive", () => {
  assertEquals(isPartialId("ABC"), true);
  assertEquals(isPartialId("5EC"), true);
  assertEquals(isPartialId("AbC"), true);
});

// matchByPartialId tests

Deno.test("matchByPartialId returns found for single match", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
    { id: "7abc123d-1234-5678-9abc-def012345678", item: "item2" },
  ];

  const result = matchByPartialId(items, "5ec");
  assertEquals(result.status, "found");
  if (result.status === "found") {
    assertEquals(result.match, "item1");
  }
});

Deno.test("matchByPartialId returns not_found when no match", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
    { id: "7abc123d-1234-5678-9abc-def012345678", item: "item2" },
  ];

  const result = matchByPartialId(items, "999");
  assertEquals(result.status, "not_found");
});

Deno.test("matchByPartialId returns ambiguous when multiple matches", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
    { id: "5ecf8b2c-1234-5678-9abc-def012345678", item: "item2" },
    { id: "7abc123d-1234-5678-9abc-def012345678", item: "item3" },
  ];

  const result = matchByPartialId(items, "5ec");
  assertEquals(result.status, "ambiguous");
  if (result.status === "ambiguous") {
    assertEquals(result.matches.length, 2);
    assertEquals(result.matches[0].id, "5ece291a-46c0-4fe2-8a1b-123456789abc");
    assertEquals(result.matches[1].id, "5ecf8b2c-1234-5678-9abc-def012345678");
  }
});

Deno.test("matchByPartialId is case insensitive", () => {
  const items = [
    { id: "5ECE291A-46C0-4FE2-8A1B-123456789ABC", item: "item1" },
  ];

  const result = matchByPartialId(items, "5ece");
  assertEquals(result.status, "found");
});

Deno.test("matchByPartialId ignores dashes in partial ID", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
  ];

  // Partial ID with dashes should still match
  const result = matchByPartialId(items, "5ece-291a");
  assertEquals(result.status, "found");
});

Deno.test("matchByPartialId matches full UUID", () => {
  const items = [
    { id: "5ece291a-46c0-4fe2-8a1b-123456789abc", item: "item1" },
    { id: "5ecf8b2c-1234-5678-9abc-def012345678", item: "item2" },
  ];

  const result = matchByPartialId(
    items,
    "5ece291a-46c0-4fe2-8a1b-123456789abc",
  );
  assertEquals(result.status, "found");
  if (result.status === "found") {
    assertEquals(result.match, "item1");
  }
});
