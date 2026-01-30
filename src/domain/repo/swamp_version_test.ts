import { assertEquals, assertThrows } from "@std/assert";
import { SwampVersion } from "./swamp_version.ts";

Deno.test("SwampVersion.create parses valid version", () => {
  const version = SwampVersion.create("1.2.3");
  assertEquals(version.major, 1);
  assertEquals(version.minor, 2);
  assertEquals(version.patch, 3);
  assertEquals(version.toString(), "1.2.3");
});

Deno.test("SwampVersion.create parses zero version", () => {
  const version = SwampVersion.create("0.0.0");
  assertEquals(version.major, 0);
  assertEquals(version.minor, 0);
  assertEquals(version.patch, 0);
});

Deno.test("SwampVersion.create parses typical initial version", () => {
  const version = SwampVersion.create("0.1.0");
  assertEquals(version.toString(), "0.1.0");
});

Deno.test("SwampVersion.create trims whitespace", () => {
  const version = SwampVersion.create("  1.0.0  ");
  assertEquals(version.toString(), "1.0.0");
});

Deno.test("SwampVersion.create throws on empty string", () => {
  assertThrows(
    () => SwampVersion.create(""),
    Error,
    "Version cannot be empty",
  );
});

Deno.test("SwampVersion.create throws on invalid format - no dots", () => {
  assertThrows(
    () => SwampVersion.create("100"),
    Error,
    "Invalid version format",
  );
});

Deno.test("SwampVersion.create throws on invalid format - two parts", () => {
  assertThrows(
    () => SwampVersion.create("1.0"),
    Error,
    "Invalid version format",
  );
});

Deno.test("SwampVersion.create throws on invalid format - four parts", () => {
  assertThrows(
    () => SwampVersion.create("1.0.0.0"),
    Error,
    "Invalid version format",
  );
});

Deno.test("SwampVersion.create throws on invalid format - letters", () => {
  assertThrows(
    () => SwampVersion.create("1.0.0-beta"),
    Error,
    "Invalid version format",
  );
});

Deno.test("SwampVersion.equals returns true for same versions", () => {
  const v1 = SwampVersion.create("1.2.3");
  const v2 = SwampVersion.create("1.2.3");
  assertEquals(v1.equals(v2), true);
});

Deno.test("SwampVersion.equals returns false for different major", () => {
  const v1 = SwampVersion.create("1.2.3");
  const v2 = SwampVersion.create("2.2.3");
  assertEquals(v1.equals(v2), false);
});

Deno.test("SwampVersion.equals returns false for different minor", () => {
  const v1 = SwampVersion.create("1.2.3");
  const v2 = SwampVersion.create("1.3.3");
  assertEquals(v1.equals(v2), false);
});

Deno.test("SwampVersion.equals returns false for different patch", () => {
  const v1 = SwampVersion.create("1.2.3");
  const v2 = SwampVersion.create("1.2.4");
  assertEquals(v1.equals(v2), false);
});

Deno.test("SwampVersion.compareTo returns 0 for equal versions", () => {
  const v1 = SwampVersion.create("1.2.3");
  const v2 = SwampVersion.create("1.2.3");
  assertEquals(v1.compareTo(v2), 0);
});

Deno.test("SwampVersion.compareTo compares major first", () => {
  const v1 = SwampVersion.create("2.0.0");
  const v2 = SwampVersion.create("1.9.9");
  assertEquals(v1.compareTo(v2) > 0, true);
});

Deno.test("SwampVersion.compareTo compares minor second", () => {
  const v1 = SwampVersion.create("1.2.0");
  const v2 = SwampVersion.create("1.1.9");
  assertEquals(v1.compareTo(v2) > 0, true);
});

Deno.test("SwampVersion.compareTo compares patch third", () => {
  const v1 = SwampVersion.create("1.2.4");
  const v2 = SwampVersion.create("1.2.3");
  assertEquals(v1.compareTo(v2) > 0, true);
});

Deno.test("SwampVersion.isNewerThan returns true when newer", () => {
  const v1 = SwampVersion.create("1.1.0");
  const v2 = SwampVersion.create("1.0.0");
  assertEquals(v1.isNewerThan(v2), true);
});

Deno.test("SwampVersion.isNewerThan returns false when older", () => {
  const v1 = SwampVersion.create("1.0.0");
  const v2 = SwampVersion.create("1.1.0");
  assertEquals(v1.isNewerThan(v2), false);
});

Deno.test("SwampVersion.isNewerThan returns false when equal", () => {
  const v1 = SwampVersion.create("1.0.0");
  const v2 = SwampVersion.create("1.0.0");
  assertEquals(v1.isNewerThan(v2), false);
});

Deno.test("SwampVersion.isOlderThan returns true when older", () => {
  const v1 = SwampVersion.create("1.0.0");
  const v2 = SwampVersion.create("1.1.0");
  assertEquals(v1.isOlderThan(v2), true);
});

Deno.test("SwampVersion.isOlderThan returns false when newer", () => {
  const v1 = SwampVersion.create("1.1.0");
  const v2 = SwampVersion.create("1.0.0");
  assertEquals(v1.isOlderThan(v2), false);
});

Deno.test("SwampVersion.isOlderThan returns false when equal", () => {
  const v1 = SwampVersion.create("1.0.0");
  const v2 = SwampVersion.create("1.0.0");
  assertEquals(v1.isOlderThan(v2), false);
});
