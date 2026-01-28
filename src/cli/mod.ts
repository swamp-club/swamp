import { Command } from "@cliffy/command";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { VERSION, versionCommand } from "./commands/version.ts";
import type { GlobalOptions } from "./context.ts";

export async function runCli(args: string[]): Promise<void> {
  const cli = new Command()
    .name("swamp")
    .version(VERSION)
    .description("AI Native Automation CLI")
    .globalOption("--debug-logs", "Enable debug logging to dev-logs directory")
    .globalOption("--json", "Output in JSON format (non-interactive)")
    .globalOption("-q, --quiet", "Suppress non-essential output")
    .globalOption("-v, --verbose", "Show detailed output")
    .globalAction(async function (options: GlobalOptions) {
      await initializeLogging({
        debugLogs: options.debugLogs ?? false,
      });
    })
    .action(function () {
      this.showHelp();
    })
    .command("version", versionCommand);

  await cli.parse(args);
}
