import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { ensureModelRegistryInitialized } from "../../domain/models/registry_init.ts";

// Initialize logging and model registry for tests
await initializeLogging({ debugLogs: false });
await ensureModelRegistryInitialized();

Deno.test("typeCommand module loads", async () => {
  const { typeCommand } = await import("./type_describe.ts");
  assertEquals(typeCommand.getName(), "type");
});

Deno.test("typeDescribeCommand is registered as subcommand", async () => {
  const { typeCommand } = await import("./type_describe.ts");
  const commands = typeCommand.getCommands();
  const describeCmd = commands.find((c) => c.getName() === "describe");
  assertEquals(describeCmd !== undefined, true);
});

Deno.test("typeDescribeCommand has correct description", async () => {
  const { typeDescribeCommand } = await import("./type_describe.ts");
  assertEquals(
    typeDescribeCommand.getDescription(),
    "Describe a model type with schema details",
  );
});
