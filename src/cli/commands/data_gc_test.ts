import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("dataGcCommand - has correct name", async () => {
  const { dataGcCommand } = await import("./data_gc.ts");
  assertEquals(dataGcCommand.getName(), "gc");
});

Deno.test("dataGcCommand - has description", async () => {
  const { dataGcCommand } = await import("./data_gc.ts");
  const description = dataGcCommand.getDescription();
  assertEquals(
    description,
    "Run garbage collection on data (lifecycle and versions)",
  );
});

Deno.test("dataGcCommand - has repo-dir option", async () => {
  const { dataGcCommand } = await import("./data_gc.ts");
  const options = dataGcCommand.getOptions();
  const repoDir = options.find((opt) => opt.name === "repo-dir");
  assertEquals(repoDir !== undefined, true);
});

Deno.test("dataGcCommand - has dry-run option", async () => {
  const { dataGcCommand } = await import("./data_gc.ts");
  const options = dataGcCommand.getOptions();
  const dryRun = options.find((opt) => opt.name === "dry-run");
  assertEquals(dryRun !== undefined, true);
});

Deno.test("dataGcCommand - has force option", async () => {
  const { dataGcCommand } = await import("./data_gc.ts");
  const options = dataGcCommand.getOptions();
  const force = options.find((opt) => opt.name === "force");
  assertEquals(force !== undefined, true);
});
