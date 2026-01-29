import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { ensureModelRegistryInitialized } from "../../domain/models/registry_init.ts";

// Initialize logging and model registry for tests
await initializeLogging({ debugLogs: false });
await ensureModelRegistryInitialized();

Deno.test("modelGetCommand module loads", async () => {
  const { modelGetCommand } = await import("./model_get.ts");
  assertEquals(modelGetCommand.getName(), "get");
});

Deno.test("modelGetCommand has correct description", async () => {
  const { modelGetCommand } = await import("./model_get.ts");
  assertEquals(
    modelGetCommand.getDescription(),
    "Show details of a model input",
  );
});

Deno.test("modelGetCommand is registered as subcommand of modelCommand", async () => {
  const { modelCommand } = await import("./model_create.ts");
  const commands = modelCommand.getCommands();
  const getCmd = commands.find((c) => c.getName() === "get");
  assertEquals(getCmd !== undefined, true);
});
