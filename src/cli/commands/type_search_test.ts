import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({ debugLogs: false });

// Initialize model registry
import "../../domain/models/registry_init.ts";

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

Deno.test("typeSearchCommand is registered as subcommand of typeCommand", async () => {
  const { typeCommand } = await import("./type_describe.ts");
  const commands = typeCommand.getCommands();
  const searchCmd = commands.find((c) => c.getName() === "search");
  assertEquals(searchCmd !== undefined, true);
});
