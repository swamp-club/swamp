import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("modelDeleteCommand module loads", async () => {
  const { modelDeleteCommand } = await import("./model_delete.ts");
  assertEquals(modelDeleteCommand.getName(), "delete");
});

Deno.test("modelDeleteCommand has correct description", async () => {
  const { modelDeleteCommand } = await import("./model_delete.ts");
  assertEquals(
    modelDeleteCommand.getDescription(),
    "Delete a model and all related artifacts",
  );
});

Deno.test("modelDeleteCommand is registered as subcommand of modelCommand", async () => {
  const { modelCommand } = await import("./model_create.ts");
  const commands = modelCommand.getCommands();
  const deleteCmd = commands.find((c) => c.getName() === "delete");
  assertEquals(deleteCmd !== undefined, true);
});
