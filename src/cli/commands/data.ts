import { Command } from "@cliffy/command";
import { dataGetCommand } from "./data_get.ts";
import { dataListCommand } from "./data_list.ts";
import { dataSearchCommand } from "./data_search.ts";
import { dataVersionsCommand } from "./data_versions.ts";
import { dataGcCommand } from "./data_gc.ts";

export const dataCommand = new Command()
  .name("data")
  .description("Manage model data")
  .action(function () {
    this.showHelp();
  })
  .command("get", dataGetCommand)
  .command("list", dataListCommand)
  .command("search", dataSearchCommand)
  .command("versions", dataVersionsCommand)
  .command("gc", dataGcCommand);
