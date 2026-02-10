import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("dataListCommand module loads", async () => {
  const { dataListCommand } = await import("./data_list.ts");
  assertEquals(dataListCommand.getName(), "list");
});

Deno.test("dataListCommand has correct description", async () => {
  const { dataListCommand } = await import("./data_list.ts");
  assertEquals(
    dataListCommand.getDescription(),
    "List all data for a model, grouped by type",
  );
});

Deno.test("dataListCommand is registered as subcommand of dataCommand", async () => {
  const { dataCommand } = await import("./data.ts");
  const commands = dataCommand.getCommands();
  const listCmd = commands.find((c) => c.getName() === "list");
  assertEquals(listCmd !== undefined, true);
});
