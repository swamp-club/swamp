// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import type { CommandRoute } from "../command_routes.ts";

// each load is a literal import(): deno compile embeds only literal specifiers,
// and the order is the group help's listing order
export const WORKFLOW_ROUTES: readonly CommandRoute[] = [
  {
    name: "create",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_create.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_create.ts")).workflowCreateCommand,
  },
  {
    name: "delete",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_delete.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_delete.ts")).workflowDeleteCommand,
  },
  {
    name: "edit",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_edit.ts",
    needsFullTree: false,
    load: async () => (await import("./workflow_edit.ts")).workflowEditCommand,
  },
  {
    name: "evaluate",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_evaluate.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_evaluate.ts")).workflowEvaluateCommand,
  },
  {
    name: "get",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_get.ts",
    needsFullTree: false,
    load: async () => (await import("./workflow_get.ts")).workflowGetCommand,
  },
  {
    name: "history",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_history.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_history.ts")).workflowHistoryCommand,
  },
  {
    name: "validate",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_validate.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_validate.ts")).workflowValidateCommand,
  },
  {
    name: "search",
    aliases: ["list"],
    hidden: false,
    module: "src/cli/commands/workflow_search.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_search.ts")).workflowSearchCommand,
  },
  {
    name: "run",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_run.ts",
    needsFullTree: false,
    load: async () => (await import("./workflow_run.ts")).workflowRunCommand,
  },
  {
    name: "approve",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_approve.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_approve.ts")).workflowApproveCommand,
  },
  {
    name: "cancel",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_cancel.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_cancel.ts")).workflowCancelCommand,
  },
  {
    name: "reject",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_reject.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_reject.ts")).workflowRejectCommand,
  },
  {
    name: "recover",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_recover.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_recover.ts")).workflowRecoverCommand,
  },
  {
    name: "resume",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_resume.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_resume.ts")).workflowResumeCommand,
  },
  {
    name: "approvals",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_approvals.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_approvals.ts")).workflowApprovalsCommand,
  },
  {
    name: "signal",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_signal.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_signal.ts")).workflowSignalCommand,
  },
  {
    name: "waits",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_waits.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_waits.ts")).workflowWaitsCommand,
  },
  {
    name: "schema",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_schema.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_schema.ts")).workflowSchemaCommand,
  },
  {
    name: "trigger",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_trigger.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_trigger.ts")).workflowTriggerCommand,
  },
  {
    name: "schedule",
    aliases: [],
    hidden: false,
    module: "src/cli/commands/workflow_schedule.ts",
    needsFullTree: false,
    load: async () =>
      (await import("./workflow_schedule.ts")).workflowScheduleCommand,
  },
];
