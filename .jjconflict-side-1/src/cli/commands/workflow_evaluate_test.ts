import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({});

// Note: Full CLI integration tests are in integration/workflow_inputs_test.ts
// These tests verify the command module loads correctly

Deno.test("workflowEvaluateCommand module loads", async () => {
  const { workflowEvaluateCommand } = await import("./workflow_evaluate.ts");
  assertEquals(workflowEvaluateCommand.getName(), "evaluate");
});

Deno.test("workflowEvaluateCommand has correct options", async () => {
  const { workflowEvaluateCommand } = await import("./workflow_evaluate.ts");
  const options = workflowEvaluateCommand.getOptions();
  const optionNames = options.map((o) => o.name);

  assertEquals(optionNames.includes("repo-dir"), true);
  assertEquals(optionNames.includes("all"), true);
  assertEquals(optionNames.includes("input"), true);
  assertEquals(optionNames.includes("input-file"), true);
});

Deno.test("workflowEvaluateCommand is registered in workflow command", async () => {
  const { workflowCommand } = await import("./workflow.ts");
  const commands = workflowCommand.getCommands();
  const evaluateCmd = commands.find((c) => c.getName() === "evaluate");
  assertEquals(evaluateCmd !== undefined, true);
});
