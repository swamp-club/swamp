import { Command } from "@cliffy/command";
import { workflowHistoryGetCommand } from "./workflow_history_get.ts";
import { workflowHistorySearchCommand } from "./workflow_history_search.ts";

export const workflowHistoryCommand = new Command()
  .name("history")
  .description("Workflow run history commands")
  .action(function () {
    this.showHelp();
  })
  .command("get", workflowHistoryGetCommand)
  .command("search", workflowHistorySearchCommand);
