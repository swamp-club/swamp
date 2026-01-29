import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({ debugLogs: false });

// Initialize model registry
import "../../domain/models/registry_init.ts";

Deno.test("modelListCommand module loads", async () => {
  const { modelListCommand } = await import("./model_list.ts");
  assertEquals(modelListCommand.getName(), "list");
});

Deno.test("modelListCommand has correct description", async () => {
  const { modelListCommand } = await import("./model_list.ts");
  assertEquals(
    modelListCommand.getDescription(),
    "List and search model inputs",
  );
});

Deno.test("modelListCommand is registered as subcommand of modelCommand", async () => {
  const { modelCommand } = await import("./model_create.ts");
  const commands = modelCommand.getCommands();
  const listCmd = commands.find((c) => c.getName() === "list");
  assertEquals(listCmd !== undefined, true);
});
