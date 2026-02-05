import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({ debugLogs: false });

Deno.test("modelEditCommand module loads", async () => {
  const { modelEditCommand } = await import("./model_edit.ts");
  assertEquals(modelEditCommand.getName(), "edit");
});

Deno.test("modelEditCommand has correct description", async () => {
  const { modelEditCommand } = await import("./model_edit.ts");
  assertEquals(
    modelEditCommand.getDescription(),
    "Edit a model definition file",
  );
});

Deno.test("modelEditCommand is registered as subcommand of modelCommand", async () => {
  const { modelCommand } = await import("./model_create.ts");
  const commands = modelCommand.getCommands();
  const editCmd = commands.find((c) => c.getName() === "edit");
  assertEquals(editCmd !== undefined, true);
});
