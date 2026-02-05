import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({ debugLogs: false });

Deno.test("dataGetCommand module loads", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  assertEquals(dataGetCommand.getName(), "get");
});

Deno.test("dataGetCommand has correct description", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  assertEquals(
    dataGetCommand.getDescription(),
    "Get data by model and name",
  );
});

Deno.test("dataGetCommand is registered as subcommand of dataCommand", async () => {
  const { dataCommand } = await import("./data.ts");
  const commands = dataCommand.getCommands();
  const getCmd = commands.find((c) => c.getName() === "get");
  assertEquals(getCmd !== undefined, true);
});
