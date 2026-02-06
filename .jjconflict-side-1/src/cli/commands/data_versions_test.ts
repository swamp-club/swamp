import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({ debugLogs: false });

Deno.test("dataVersionsCommand module loads", async () => {
  const { dataVersionsCommand } = await import("./data_versions.ts");
  assertEquals(dataVersionsCommand.getName(), "versions");
});

Deno.test("dataVersionsCommand has correct description", async () => {
  const { dataVersionsCommand } = await import("./data_versions.ts");
  assertEquals(
    dataVersionsCommand.getDescription(),
    "List all versions of specific data",
  );
});

Deno.test("dataVersionsCommand is registered as subcommand of dataCommand", async () => {
  const { dataCommand } = await import("./data.ts");
  const commands = dataCommand.getCommands();
  const versionsCmd = commands.find((c) => c.getName() === "versions");
  assertEquals(versionsCmd !== undefined, true);
});
