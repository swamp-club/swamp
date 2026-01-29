import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Initialize logging for tests
await initializeLogging({ debugLogs: false });

Deno.test("repoWebappCommand module loads", async () => {
  const { repoWebappCommand } = await import("./repo_webapp.ts");
  // Command has description and options, meaning it loaded correctly
  assertEquals(
    repoWebappCommand.getDescription(),
    "Start the swamp webapp server",
  );
});

Deno.test("repoWebappCommand is registered as subcommand of repo", async () => {
  const { repoCommand } = await import("./repo_init.ts");
  const commands = repoCommand.getCommands();
  const webappCmd = commands.find((c) => c.getName() === "webapp");
  assertEquals(webappCmd !== undefined, true);
});

Deno.test("repoWebappCommand has port option", async () => {
  const { repoWebappCommand } = await import("./repo_webapp.ts");
  const options = repoWebappCommand.getOptions();

  const portOption = options.find((o) => o.name === "port");
  assertEquals(portOption !== undefined, true);
});

Deno.test("repoWebappCommand has host option", async () => {
  const { repoWebappCommand } = await import("./repo_webapp.ts");
  const options = repoWebappCommand.getOptions();

  const hostOption = options.find((o) => o.name === "host");
  assertEquals(hostOption !== undefined, true);
});
