import { assertEquals } from "@std/assert";
import type { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("typeSearchCommand module loads", async () => {
  const { typeSearchCommand } = await import("./type_search.ts");
  assertEquals(typeSearchCommand.getName(), "search");
});

Deno.test("typeSearchCommand has correct description", async () => {
  const { typeSearchCommand } = await import("./type_search.ts");
  assertEquals(
    typeSearchCommand.getDescription(),
    "Search for model types",
  );
});

Deno.test("typeSearchCommand is registered as subcommand of modelTypeCommand", async () => {
  const { modelTypeCommand } = await import("./model_type.ts");
  const commands = modelTypeCommand.getCommands();
  const searchCmd = commands.find((c: Command) => c.getName() === "search");
  assertEquals(searchCmd !== undefined, true);
});
