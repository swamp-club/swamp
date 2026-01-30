import { Command } from "@cliffy/command";
import { modelOutputGetCommand } from "./model_output_get.ts";
import { modelOutputSearchCommand } from "./model_output_search.ts";

export const modelOutputCommand = new Command()
  .name("output")
  .description("Manage model outputs")
  .action(function () {
    this.showHelp();
  })
  .command("get", modelOutputGetCommand)
  .command("search", modelOutputSearchCommand);
