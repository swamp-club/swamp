import { Command } from "@cliffy/command";
import { typeDescribeCommand } from "./type_describe.ts";
import { typeSearchCommand } from "./type_search.ts";

/**
 * Parent command for model type operations.
 */
export const modelTypeCommand = new Command()
  .name("type")
  .description("Inspect model types")
  .action(function () {
    this.showHelp();
  })
  .command("describe", typeDescribeCommand)
  .command("search", typeSearchCommand);
