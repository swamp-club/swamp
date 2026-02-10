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
    "List all data for a model or workflow, grouped by type",
  );
});

Deno.test("dataListCommand is registered as subcommand of dataCommand", async () => {
  const { dataCommand } = await import("./data.ts");
  const commands = dataCommand.getCommands();
  const listCmd = commands.find((c) => c.getName() === "list");
  assertEquals(listCmd !== undefined, true);
});

Deno.test("dataListCommand has --workflow option", async () => {
  const { dataListCommand } = await import("./data_list.ts");
  const options = dataListCommand.getOptions();
  const workflowOpt = options.find((o) => o.name === "workflow");
  assertEquals(workflowOpt !== undefined, true);
});

Deno.test("dataListCommand has --run option", async () => {
  const { dataListCommand } = await import("./data_list.ts");
  const options = dataListCommand.getOptions();
  const runOpt = options.find((o) => o.name === "run");
  assertEquals(runOpt !== undefined, true);
});

Deno.test("dataListCommand accepts optional model argument", async () => {
  const { dataListCommand } = await import("./data_list.ts");
  const args = dataListCommand.getArguments();
  assertEquals(args.length > 0, true);
});
