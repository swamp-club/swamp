import { assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { renderError } from "./error_output.ts";
import { UserError } from "../../domain/errors.ts";

await initializeLogging({});

Deno.test("renderError logs UserError message without stack trace", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    const error = new UserError("Model not found");
    renderError(error);

    assertEquals(logs.length, 1);
    assertStringIncludes(logs[0], "Model not found");
    // Should not contain stack trace lines
    assertEquals(logs[0].includes("    at "), false);
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError logs non-UserError with error object", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    const error = new Error("Something broke");
    renderError(error);

    assertEquals(logs.length, 1);
    assertStringIncludes(logs[0], "Something broke");
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError wraps non-Error values in Error", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    renderError("plain string error");

    assertEquals(logs.length, 1);
    assertStringIncludes(logs[0], "plain string error");
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError uses fatal level for all errors", () => {
  const logs: string[] = [];
  const originalError = console.error;
  // LogTape's console sink uses console.error for fatal level
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    renderError(new UserError("user error"));
    renderError(new Error("system error"));

    // Both should have logged (fatal goes to console.error)
    assertEquals(logs.length, 2);
  } finally {
    console.error = originalError;
  }
});
