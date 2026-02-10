import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("model list is registered as a hidden subcommand", async () => {
  const { modelCommand } = await import("./model_create.ts");

  // getCommand with second arg true includes hidden commands
  const listCmd = modelCommand.getCommand("list", true);
  assertEquals(
    listCmd !== undefined,
    true,
    "list command should be registered",
  );

  // Verify it's hidden: not in getCommands() (which excludes hidden)
  const visibleCommands = modelCommand.getCommands();
  const visibleList = visibleCommands.find((c) => c.getName() === "list");
  assertEquals(
    visibleList,
    undefined,
    "list should not appear in visible commands",
  );
});

Deno.test("workflow history list is registered as a hidden subcommand", async () => {
  const { workflowHistoryCommand } = await import("./workflow_history.ts");

  // getCommand with second arg true includes hidden commands
  const listCmd = workflowHistoryCommand.getCommand("list", true);
  assertEquals(
    listCmd !== undefined,
    true,
    "list command should be registered",
  );

  // Verify it's hidden: not in getCommands() (which excludes hidden)
  const visibleCommands = workflowHistoryCommand.getCommands();
  const visibleList = visibleCommands.find((c) => c.getName() === "list");
  assertEquals(
    visibleList,
    undefined,
    "list should not appear in visible commands",
  );
});
