import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderUpdateResult } from "./update_output.tsx";
import type { UpdateResult } from "../../domain/update/update_service.ts";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

// --- JSON output tests ---

Deno.test("renderUpdateResult json mode: up_to_date", () => {
  const result: UpdateResult = {
    status: "up_to_date",
    currentVersion: "20260207.123456.0-sha.abc12345",
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderUpdateResult(result, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.status, "up_to_date");
    assertEquals(parsed.currentVersion, "20260207.123456.0-sha.abc12345");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderUpdateResult json mode: update_available", () => {
  const result: UpdateResult = {
    status: "update_available",
    currentVersion: "20260207.123456.0-sha.abc12345",
    latestVersion: "20260208.000000.0-sha.def56789",
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderUpdateResult(result, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.status, "update_available");
    assertEquals(parsed.latestVersion, "20260208.000000.0-sha.def56789");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderUpdateResult json mode: updated", () => {
  const result: UpdateResult = {
    status: "updated",
    previousVersion: "20260207.123456.0-sha.abc12345",
    newVersion: "20260208.000000.0-sha.def56789",
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderUpdateResult(result, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.status, "updated");
    assertEquals(parsed.previousVersion, "20260207.123456.0-sha.abc12345");
    assertEquals(parsed.newVersion, "20260208.000000.0-sha.def56789");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderUpdateResult json mode: includes warning when present", () => {
  const result: UpdateResult = {
    status: "up_to_date",
    currentVersion: "20260206.200442.0-sha.",
    warning: "Replacing a development build with a release build.",
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderUpdateResult(result, "json");
    const parsed = JSON.parse(logs[0]);
    assertEquals(
      parsed.warning,
      "Replacing a development build with a release build.",
    );
  } finally {
    console.log = originalLog;
  }
});

// --- Interactive output tests ---

Deno.test({
  name: "renderUpdateResult interactive: up_to_date shows green message",
  ...inkTestOptions,
  fn: () => {
    const result: UpdateResult = {
      status: "up_to_date",
      currentVersion: "20260207.123456.0-sha.abc12345",
    };

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderUpdateResult(result, "interactive");
      assertEquals(logs.length, 1);
      assertStringIncludes(logs[0], "up to date");
      assertStringIncludes(logs[0], "20260207.123456.0-sha.abc12345");
    } finally {
      console.log = originalLog;
    }
  },
});

Deno.test({
  name: "renderUpdateResult interactive: update_available shows versions",
  ...inkTestOptions,
  fn: () => {
    const result: UpdateResult = {
      status: "update_available",
      currentVersion: "20260207.123456.0-sha.abc12345",
      latestVersion: "20260208.000000.0-sha.def56789",
    };

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderUpdateResult(result, "interactive");
      assertEquals(logs.length, 1);
      assertStringIncludes(logs[0], "Update available");
      assertStringIncludes(logs[0], "20260207.123456.0-sha.abc12345");
      assertStringIncludes(logs[0], "20260208.000000.0-sha.def56789");
      assertStringIncludes(logs[0], "swamp update");
    } finally {
      console.log = originalLog;
    }
  },
});

Deno.test({
  name: "renderUpdateResult interactive: updated shows success",
  ...inkTestOptions,
  fn: () => {
    const result: UpdateResult = {
      status: "updated",
      previousVersion: "20260207.123456.0-sha.abc12345",
      newVersion: "20260208.000000.0-sha.def56789",
    };

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderUpdateResult(result, "interactive");
      assertEquals(logs.length, 1);
      assertStringIncludes(logs[0], "updated successfully");
      assertStringIncludes(logs[0], "20260207.123456.0-sha.abc12345");
      assertStringIncludes(logs[0], "20260208.000000.0-sha.def56789");
    } finally {
      console.log = originalLog;
    }
  },
});

Deno.test({
  name: "renderUpdateResult interactive: warning is displayed",
  ...inkTestOptions,
  fn: () => {
    const result: UpdateResult = {
      status: "up_to_date",
      currentVersion: "20260206.200442.0-sha.",
      warning: "Replacing a development build with a release build.",
    };

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderUpdateResult(result, "interactive");
      assertEquals(logs.length, 1);
      assertStringIncludes(logs[0], "development build");
    } finally {
      console.log = originalLog;
    }
  },
});
