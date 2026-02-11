import { Command } from "@cliffy/command";
import { workflowHistoryGetCommand } from "./workflow_history_get.ts";
import {
  workflowHistorySearchAction,
  workflowHistorySearchCommand,
} from "./workflow_history_search.ts";
import { workflowHistoryLogsCommand } from "./workflow_history_logs.ts";

export const workflowHistoryCommand = new Command()
  .name("history")
  .description("Workflow run history commands")
  .action(function () {
    this.showHelp();
  })
  .command("get", workflowHistoryGetCommand)
  .command("search", workflowHistorySearchCommand)
  .command("logs", workflowHistoryLogsCommand)
  .command(
    "list",
    new Command()
      .description("Alias for workflow history search")
      .hidden()
      .arguments("[query:string]")
      .option("--repo-dir <dir:string>", "Repository directory", {
        default: ".",
      })
      .action(workflowHistorySearchAction),
  );
