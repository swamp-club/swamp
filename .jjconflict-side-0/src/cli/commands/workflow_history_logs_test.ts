import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({ debugLogs: false });

// Note: Full CLI integration tests are in integration/
// These tests verify the command module loads correctly

Deno.test("workflowHistoryLogsCommand module loads", async () => {
  const { workflowHistoryLogsCommand } = await import(
    "./workflow_history_logs.ts"
  );
  assertEquals(workflowHistoryLogsCommand.getName(), "logs");
});

Deno.test("workflowHistoryLogsCommand has correct description", async () => {
  const { workflowHistoryLogsCommand } = await import(
    "./workflow_history_logs.ts"
  );
  assertEquals(
    workflowHistoryLogsCommand.getDescription(),
    "Show logs/output for a workflow run",
  );
});
