import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({ debugLogs: false });

Deno.test("workflowEditCommand module loads", async () => {
  const { workflowEditCommand } = await import("./workflow_edit.ts");
  assertEquals(workflowEditCommand.getName(), "edit");
});

Deno.test("workflowEditCommand has correct description", async () => {
  const { workflowEditCommand } = await import("./workflow_edit.ts");
  assertEquals(
    workflowEditCommand.getDescription(),
    "Edit a workflow file",
  );
});

Deno.test("workflowEditCommand is registered as subcommand of workflowCommand", async () => {
  const { workflowCommand } = await import("./workflow.ts");
  const commands = workflowCommand.getCommands();
  const editCmd = commands.find((c) => c.getName() === "edit");
  assertEquals(editCmd !== undefined, true);
});
