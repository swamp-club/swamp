import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("workflowSchemaCommand module loads", async () => {
  const { workflowSchemaCommand } = await import("./workflow_schema.ts");
  assertEquals(workflowSchemaCommand.getName(), "schema");
});

Deno.test("workflowSchemaGetCommand is registered as subcommand", async () => {
  const { workflowSchemaCommand } = await import("./workflow_schema.ts");
  const commands = workflowSchemaCommand.getCommands();
  const getCmd = commands.find((c) => c.getName() === "get");
  assertEquals(getCmd !== undefined, true);
});

Deno.test("workflowSchemaGetCommand has correct description", async () => {
  const { workflowSchemaGetCommand } = await import("./workflow_schema.ts");
  assertEquals(
    workflowSchemaGetCommand.getDescription(),
    "Get the schema for workflow files",
  );
});
