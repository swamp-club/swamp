import { Command } from "@cliffy/command";
import { modelMethodHistoryGetCommand } from "./model_method_history_get.ts";
import { modelMethodHistorySearchCommand } from "./model_method_history_search.ts";
import { modelMethodHistoryLogsCommand } from "./model_method_history_logs.ts";

export const modelMethodHistoryCommand = new Command()
  .name("history")
  .description("Model method run history commands")
  .action(function () {
    this.showHelp();
  })
  .command("get", modelMethodHistoryGetCommand)
  .command("search", modelMethodHistorySearchCommand)
  .command("logs", modelMethodHistoryLogsCommand);
