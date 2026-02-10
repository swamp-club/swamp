import { assertEquals } from "@std/assert";
import type { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("modelTypeCommand module loads", async () => {
  const { modelTypeCommand } = await import("./model_type.ts");
  assertEquals(modelTypeCommand.getName(), "type");
});

Deno.test("typeDescribeCommand is registered as subcommand of modelTypeCommand", async () => {
  const { modelTypeCommand } = await import("./model_type.ts");
  const commands = modelTypeCommand.getCommands();
  const describeCmd = commands.find((c: Command) => c.getName() === "describe");
  assertEquals(describeCmd !== undefined, true);
});

Deno.test("typeDescribeCommand has correct description", async () => {
  const { typeDescribeCommand } = await import("./type_describe.ts");
  assertEquals(
    typeDescribeCommand.getDescription(),
    "Describe a model type with schema details",
  );
});
