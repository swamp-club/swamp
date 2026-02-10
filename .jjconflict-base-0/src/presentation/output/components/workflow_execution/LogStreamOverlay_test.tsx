// deno-lint-ignore-file verbatim-module-syntax
import React from "react";
import { assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import { LogStreamOverlay } from "./LogStreamOverlay.tsx";
import { LogStreamService, type LogStreamTarget } from "./LogStreamService.ts";

// Mock LogStreamService for testing
class MockLogStreamService extends LogStreamService {
  private mockLogs: Array<{ message: string; timestamp: Date }> = [];

  constructor(logs: Array<{ message: string; timestamp?: Date }> = []) {
    super(".");
    this.mockLogs = logs.map((log) => ({
      message: log.message,
      timestamp: log.timestamp || new Date(),
    }));
  }

  override async *streamLogs(_target: LogStreamTarget) {
    for (const log of this.mockLogs) {
      yield log;
    }
  }
}

// Ink testing library creates signal listeners that Deno detects as leaks
const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "LogStreamOverlay renders log stream target info",
  ...inkTestOptions,
  fn: async () => {
    const mockService = new MockLogStreamService([
      { message: "Test log message 1" },
      { message: "Test log message 2" },
    ]);

    const target: LogStreamTarget = {
      type: "step",
      jobName: "test-job",
      stepName: "test-step",
      workflowRunId: "test-run",
    };

    const { lastFrame } = render(
      <LogStreamOverlay
        target={target}
        logService={mockService}
        onClose={() => {}}
        isActive
      />,
    );

    // Give time for async streaming to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const output = lastFrame() ?? "";
    assertStringIncludes(output, "test-job/test-step");
  },
});

Deno.test({
  name: "LogStreamOverlay displays log messages",
  ...inkTestOptions,
  fn: async () => {
    const mockService = new MockLogStreamService([
      { message: "Starting step execution" },
      { message: "Step completed successfully" },
    ]);

    const target: LogStreamTarget = {
      type: "step",
      jobName: "build-job",
      stepName: "compile-step",
      workflowRunId: "run-123",
    };

    const { lastFrame } = render(
      <LogStreamOverlay
        target={target}
        logService={mockService}
        onClose={() => {}}
        isActive
      />,
    );

    // Give time for async streaming to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const output = lastFrame() ?? "";
    assertStringIncludes(output, "Starting step execution");
    assertStringIncludes(output, "Step completed successfully");
  },
});

Deno.test({
  name: "LogStreamOverlay shows hotkey hints",
  ...inkTestOptions,
  fn: () => {
    const mockService = new MockLogStreamService();

    const target: LogStreamTarget = {
      type: "step",
      jobName: "test-job",
      stepName: "test-step",
      workflowRunId: "test-run",
    };

    const { lastFrame } = render(
      <LogStreamOverlay
        target={target}
        logService={mockService}
        onClose={() => {}}
        isActive
      />,
    );

    const output = lastFrame() ?? "";
    assertStringIncludes(output, "↑/↓: Scroll");
    assertStringIncludes(output, "q/Esc: Close");
  },
});

Deno.test({
  name: "LogStreamOverlay handles empty log stream",
  ...inkTestOptions,
  fn: async () => {
    const mockService = new MockLogStreamService([]); // No logs

    const target: LogStreamTarget = {
      type: "step",
      jobName: "empty-job",
      stepName: "empty-step",
      workflowRunId: "run-456",
    };

    const { lastFrame } = render(
      <LogStreamOverlay
        target={target}
        logService={mockService}
        onClose={() => {}}
        isActive
      />,
    );

    // Give time for async streaming to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const output = lastFrame() ?? "";
    // Should still show the header and hotkey hints even with no logs
    assertStringIncludes(output, "empty-job/empty-step");
    assertStringIncludes(output, "q/Esc: Close");
  },
});

Deno.test({
  name: "LogStreamOverlay shows auto-scroll indicator",
  ...inkTestOptions,
  fn: async () => {
    const mockService = new MockLogStreamService([
      { message: "Log entry 1" },
      { message: "Log entry 2" },
      { message: "Log entry 3" },
    ]);

    const target: LogStreamTarget = {
      type: "step",
      jobName: "scroll-job",
      stepName: "scroll-step",
      workflowRunId: "scroll-run",
    };

    const { lastFrame } = render(
      <LogStreamOverlay
        target={target}
        logService={mockService}
        onClose={() => {}}
        isActive
      />,
    );

    // Give time for async streaming to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const output = lastFrame() ?? "";
    // Should show AUTO indicator for auto-scroll
    assertStringIncludes(output, "[AUTO]");
  },
});
