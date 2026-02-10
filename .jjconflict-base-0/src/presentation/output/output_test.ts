import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderVersion, type VersionData } from "./output.ts";

const testData: VersionData = {
  version: "1.0.0",
};

Deno.test("renderVersion with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderVersion(testData, "json");
    assertEquals(logs.length, 1);

    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.version, "1.0.0");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderVersion with json mode includes version field", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderVersion(testData, "json");
    assertStringIncludes(logs[0], '"version"');
    assertStringIncludes(logs[0], '"1.0.0"');
  } finally {
    console.log = originalLog;
  }
});
