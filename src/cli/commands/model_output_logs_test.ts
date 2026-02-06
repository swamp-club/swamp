import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({});

// Note: Full CLI integration tests are in integration/
// These tests verify the command module loads correctly

Deno.test("modelOutputLogsCommand module loads", async () => {
  const { modelOutputLogsCommand } = await import("./model_output_logs.ts");
  assertEquals(modelOutputLogsCommand.getName(), "logs");
});

Deno.test("modelOutputLogsCommand has correct description", async () => {
  const { modelOutputLogsCommand } = await import("./model_output_logs.ts");
  assertEquals(
    modelOutputLogsCommand.getDescription(),
    "Show log artifact content for a model output",
  );
});
