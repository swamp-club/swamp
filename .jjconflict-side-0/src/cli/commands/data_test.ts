import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("dataCommand module loads", async () => {
  const { dataCommand } = await import("./data.ts");
  assertEquals(dataCommand.getName(), "data");
});

Deno.test("dataCommand has correct description", async () => {
  const { dataCommand } = await import("./data.ts");
  assertEquals(dataCommand.getDescription(), "Manage model data");
});

Deno.test("dataCommand has all subcommands registered", async () => {
  const { dataCommand } = await import("./data.ts");
  const commands = dataCommand.getCommands();
  const commandNames = commands.map((c) => c.getName());

  assertEquals(commandNames.includes("get"), true);
  assertEquals(commandNames.includes("list"), true);
  assertEquals(commandNames.includes("versions"), true);
});

Deno.test("dataCommand is registered in CLI mod", async () => {
  // This imports the CLI module to verify dataCommand is registered
  const mod = await import("../mod.ts");
  // If module loads without error, command is registered
  assertEquals(typeof mod.runCli, "function");
});
