import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({ debugLogs: false });

// Note: Full CLI integration tests are in integration/
// These tests verify the command module loads correctly

Deno.test("modelOutputDataCommand module loads", async () => {
  const { modelOutputDataCommand } = await import("./model_output_data.ts");
  assertEquals(modelOutputDataCommand.getName(), "data");
});

Deno.test("modelOutputDataCommand has correct description", async () => {
  const { modelOutputDataCommand } = await import("./model_output_data.ts");
  assertEquals(
    modelOutputDataCommand.getDescription(),
    "Show data artifact content for a model output",
  );
});
