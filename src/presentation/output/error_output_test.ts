import { assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { renderError } from "./error_output.ts";
import { UserError } from "../../domain/errors.ts";

await initializeLogging({ debugLogs: false });

Deno.test("renderError with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => logs.push(msg);

  try {
    const error = new Error("Test error message");
    error.stack = "Error: Test error message\n    at test (file.ts:1:1)";
    renderError(error, "json");

    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.error, "Test error message");
    assertStringIncludes(parsed.stack, "at test");
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError extracts only stack lines", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => logs.push(msg);

  try {
    const error = new Error("Test error");
    // Simulate a real stack with error message line
    error.stack = `Error: Test error
    at functionOne (file:///path/to/file.ts:10:5)
    at functionTwo (file:///path/to/other.ts:20:10)`;

    renderError(error, "json");

    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.error, "Test error");
    // Stack should only contain "at" lines, not the error message
    assertEquals(parsed.stack.includes("Error: Test error"), false);
    assertStringIncludes(parsed.stack, "at functionOne");
    assertStringIncludes(parsed.stack, "at functionTwo");
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError handles non-Error objects", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => logs.push(msg);

  try {
    renderError("plain string error", "json");

    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.error, "plain string error");
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError omits stack for UserError in json mode", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => logs.push(msg);

  try {
    const error = new UserError("Model has an associated resource");
    renderError(error, "json");

    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.error, "Model has an associated resource");
    assertEquals(parsed.stack, undefined);
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError omits stack for UserError in log mode", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => logs.push(msg);

  try {
    const error = new UserError("Use --force to delete");
    renderError(error, "log");

    assertEquals(logs.length, 1);
    assertStringIncludes(logs[0], "Error: Use --force to delete");
    // Should not contain any "at " stack lines
    assertEquals(logs[0].includes("at "), false);
  } finally {
    console.error = originalError;
  }
});
