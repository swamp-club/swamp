// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { Command } from "@cliffy/command";
import { workflowCreateCommand } from "./workflow_create.ts";
import { workflowDeleteCommand } from "./workflow_delete.ts";
import { workflowEditCommand } from "./workflow_edit.ts";
import { workflowEvaluateCommand } from "./workflow_evaluate.ts";
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
  .command("delete", workflowDeleteCommand)
  .command("edit", workflowEditCommand)
  .command("evaluate", workflowEvaluateCommand)
  .command("get", workflowGetCommand)
  .command("history", workflowHistoryCommand)
  .command("validate", workflowValidateCommand)
  .command("search", workflowSearchCommand)
  .command("run", workflowRunCommand)
  .command("schema", workflowSchemaCommand);
