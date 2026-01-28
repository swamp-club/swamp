import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({ debugLogs: false });

// Note: Full CLI integration tests are in integration/echo_model_test.ts
// These tests verify the command module loads correctly

Deno.test("modelCommand module loads", async () => {
  const { modelCommand } = await import("./model_create.ts");
  assertEquals(modelCommand.getName(), "model");
});

Deno.test("modelCreateCommand is registered as subcommand", async () => {
  const { modelCommand } = await import("./model_create.ts");
  const commands = modelCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create");
  assertEquals(createCmd !== undefined, true);
});
