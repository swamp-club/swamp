import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({});

// Note: Full CLI integration tests are in integration/echo_model_test.ts
// These tests verify the command module loads correctly

Deno.test("modelMethodRunCommand module loads", async () => {
  const { modelMethodRunCommand } = await import("./model_method_run.ts");
  assertEquals(modelMethodRunCommand.getName(), "run");
});

Deno.test("modelMethodRunCommand has correct description", async () => {
  const { modelMethodRunCommand } = await import("./model_method_run.ts");
  assertEquals(
    modelMethodRunCommand.getDescription(),
    "Execute a method on a model",
  );
});

Deno.test("modelMethodCommand module loads", async () => {
  const { modelMethodCommand } = await import("./model_method_run.ts");
  assertEquals(modelMethodCommand.getName(), "method");
});

Deno.test("modelMethodCommand has correct description", async () => {
  const { modelMethodCommand } = await import("./model_method_run.ts");
  assertEquals(
    modelMethodCommand.getDescription(),
    "Execute model methods",
  );
});

Deno.test("modelMethodCommand has run as subcommand", async () => {
  const { modelMethodCommand } = await import("./model_method_run.ts");
  const commands = modelMethodCommand.getCommands();
  const runCommand = commands.find((cmd) => cmd.getName() === "run");
  assertEquals(runCommand !== undefined, true);
});
