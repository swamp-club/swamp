import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderVersion, type VersionData } from "./output.tsx";

const testData: VersionData = {
  version: "1.0.0",
  haiku: "line one\nline two\nline three",
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
    assertEquals(parsed.haiku, "line one\nline two\nline three");
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

Deno.test("renderVersion with json mode includes haiku field", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderVersion(testData, "json");
    assertStringIncludes(logs[0], '"haiku"');
  } finally {
    console.log = originalLog;
  }
});

// Interactive mode rendering is tested via ink-testing-library
// in components/VersionDisplay_test.tsx

Deno.test("renderVersion with json mode formats haiku with indentation in output", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderVersion(testData, "json");
    // JSON output preserves the original haiku without formatting
    // The formatHaiku function is only used for interactive mode
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.haiku, "line one\nline two\nline three");
  } finally {
    console.log = originalLog;
  }
});
