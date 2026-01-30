import { assertEquals, assertStringIncludes } from "@std/assert";
import { FROG_HAIKU, getVersionData, VERSION } from "./version.ts";

Deno.test("getVersionData returns correct version", () => {
  const data = getVersionData();
  assertEquals(data.version, VERSION);
});

Deno.test("getVersionData returns haiku", () => {
  const data = getVersionData();
  assertEquals(data.haiku, FROG_HAIKU);
});

Deno.test("VERSION is 0.1.0", () => {
  assertEquals(VERSION, "0.1.0");
});

Deno.test("FROG_HAIKU contains frog reference", () => {
  assertStringIncludes(FROG_HAIKU, "frog");
});

Deno.test("FROG_HAIKU has three lines (haiku structure)", () => {
  const lines = FROG_HAIKU.split("\n");
  assertEquals(lines.length, 3);
});
