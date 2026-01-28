import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({ debugLogs: false });

Deno.test("repoCommand module loads", async () => {
  const { repoCommand } = await import("./repo_init.ts");
  assertEquals(repoCommand.getName(), "repo");
});

Deno.test("repoInitCommand is registered as subcommand", async () => {
  const { repoCommand } = await import("./repo_init.ts");
  const commands = repoCommand.getCommands();
  const initCmd = commands.find((c) => c.getName() === "init");
  assertEquals(initCmd !== undefined, true);
});

Deno.test("repoUpgradeCommand is registered as subcommand", async () => {
  const { repoCommand } = await import("./repo_init.ts");
  const commands = repoCommand.getCommands();
  const upgradeCmd = commands.find((c) => c.getName() === "upgrade");
  assertEquals(upgradeCmd !== undefined, true);
});
