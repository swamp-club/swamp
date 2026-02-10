import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { renderUpdateResult } from "./update_output.ts";
import type { UpdateResult } from "../../domain/update/update_service.ts";

await initializeLogging({});

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

// --- Log mode tests ---

Deno.test("renderUpdateResult log mode: up_to_date does not throw", () => {
  const result: UpdateResult = {
    status: "up_to_date",
    currentVersion: "20260207.123456.0-sha.abc12345",
  };
  renderUpdateResult(result, "log");
});

Deno.test("renderUpdateResult log mode: update_available does not throw", () => {
  const result: UpdateResult = {
    status: "update_available",
    currentVersion: "20260207.123456.0-sha.abc12345",
    latestVersion: "20260208.000000.0-sha.def56789",
  };
  renderUpdateResult(result, "log");
});

Deno.test("renderUpdateResult log mode: updated does not throw", () => {
  const result: UpdateResult = {
    status: "updated",
    previousVersion: "20260207.123456.0-sha.abc12345",
    newVersion: "20260208.000000.0-sha.def56789",
  };
  renderUpdateResult(result, "log");
});

Deno.test("renderUpdateResult log mode: warning does not throw", () => {
  const result: UpdateResult = {
    status: "up_to_date",
    currentVersion: "20260206.200442.0-sha.",
    warning: "Replacing a development build with a release build.",
  };
  renderUpdateResult(result, "log");
});
