import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("dataGetCommand module loads", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  assertEquals(dataGetCommand.getName(), "get");
});

Deno.test("dataGetCommand has correct description", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  assertEquals(
    dataGetCommand.getDescription(),
    "Get data by model and name, or by workflow",
  );
});

Deno.test("dataGetCommand is registered as subcommand of dataCommand", async () => {
  const { dataCommand } = await import("./data.ts");
  const commands = dataCommand.getCommands();
  const getCmd = commands.find((c) => c.getName() === "get");
  assertEquals(getCmd !== undefined, true);
});

Deno.test("dataGetCommand has --workflow option", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const options = dataGetCommand.getOptions();
  const workflowOpt = options.find((o) => o.name === "workflow");
  assertEquals(workflowOpt !== undefined, true);
});

Deno.test("dataGetCommand has --run option", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const options = dataGetCommand.getOptions();
  const runOpt = options.find((o) => o.name === "run");
  assertEquals(runOpt !== undefined, true);
});

Deno.test("dataGetCommand accepts optional model argument", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const args = dataGetCommand.getArguments();
  assertEquals(args.length > 0, true);
});

Deno.test("dataGetCommand has --no-content option", async () => {
  const { dataGetCommand } = await import("./data_get.ts");
  const options = dataGetCommand.getOptions();
  const contentOpt = options.find((o) => o.name === "no-content");
  assertEquals(contentOpt !== undefined, true);
});
