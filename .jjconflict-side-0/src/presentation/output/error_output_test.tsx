// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import { ErrorDisplay, renderError } from "./error_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "ErrorDisplay renders error message in red",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ErrorDisplay message="Something went wrong" />,
    );
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "Error: Something went wrong");
  },
});

Deno.test({
  name: "ErrorDisplay renders stack trace when provided",
  ...inkTestOptions,
  fn: () => {
    const stack = "    at foo (file.ts:10:5)\n    at bar (file.ts:20:3)";
    const { lastFrame } = render(
      <ErrorDisplay message="Test error" stack={stack} />,
    );
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "at foo");
    assertStringIncludes(output, "at bar");
  },
});

Deno.test({
  name: "ErrorDisplay omits stack section when not provided",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ErrorDisplay message="Test error" />);
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "Error: Test error");
    // Should not have extra content
    assertEquals(output.includes("at "), false);
  },
});

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
