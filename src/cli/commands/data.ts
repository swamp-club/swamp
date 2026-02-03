import { Command } from "@cliffy/command";
import { dataGetCommand } from "./data_get.ts";
import { dataListCommand } from "./data_list.ts";
import { dataVersionsCommand } from "./data_versions.ts";

export const dataCommand = new Command()
  .name("data")
  .description("Manage model data")
  .action(function () {
    this.showHelp();
  })
  .command("get", dataGetCommand)
  .command("list", dataListCommand)
  .command("versions", dataVersionsCommand);
