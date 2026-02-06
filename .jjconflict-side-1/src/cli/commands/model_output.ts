import { Command } from "@cliffy/command";
import { modelOutputGetCommand } from "./model_output_get.ts";
import { modelOutputSearchCommand } from "./model_output_search.ts";
import { modelOutputLogsCommand } from "./model_output_logs.ts";
import { modelOutputDataCommand } from "./model_output_data.ts";

export const modelOutputCommand = new Command()
  .name("output")
  .description("Manage model outputs")
  .action(function () {
    this.showHelp();
  })
  .command("get", modelOutputGetCommand)
  .command("search", modelOutputSearchCommand)
  .command("logs", modelOutputLogsCommand)
  .command("data", modelOutputDataCommand);
