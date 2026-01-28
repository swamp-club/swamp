import { assertEquals } from "@std/assert";
import { VERSION } from "./src/cli/commands/version.ts";

Deno.test("swamp version is defined", () => {
  assertEquals(typeof VERSION, "string");
  assertEquals(VERSION, "0.1.0");
});
