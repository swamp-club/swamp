import { assertEquals } from "@std/assert";
import { getVersionData, VERSION } from "./version.ts";

Deno.test("getVersionData returns correct version", () => {
  const data = getVersionData();
  assertEquals(data.version, VERSION);
});

Deno.test("VERSION is a string", () => {
  assertEquals(typeof VERSION, "string");
});
