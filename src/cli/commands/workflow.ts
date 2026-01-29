import { Command } from "@cliffy/command";
import { workflowCreateCommand } from "./workflow_create.ts";
import { workflowGetCommand } from "./workflow_get.ts";
import { workflowHistoryCommand } from "./workflow_history.ts";
import { workflowValidateCommand } from "./workflow_validate.ts";
import { workflowSearchCommand } from "./workflow_search.ts";
import { workflowRunCommand } from "./workflow_run.ts";
import { workflowSchemaCommand } from "./workflow_schema.ts";

export const workflowCommand = new Command()
  .name("workflow")
  .description("Manage workflows")
  .action(function () {
    this.showHelp();
  })
  .command("create", workflowCreateCommand)
  .command("get", workflowGetCommand)
  .command("history", workflowHistoryCommand)
  .command("validate", workflowValidateCommand)
  .command("search", workflowSearchCommand)
  .command("run", workflowRunCommand)
  .command("schema", workflowSchemaCommand);
