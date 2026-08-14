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

import { Command } from "@cliffy/command";
import { groupCommandAction } from "../group_action.ts";
import { workflowTriggerSetCommand } from "./workflow_trigger_set.ts";
import { workflowTriggerGetCommand } from "./workflow_trigger_get.ts";
import { workflowTriggerRemoveCommand } from "./workflow_trigger_remove.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

export const workflowTriggerCommand = new Command()
  .name("trigger")
  .description("Manage workflow trigger overrides in serve.yaml")
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("set", workflowTriggerSetCommand)
  .command("get", workflowTriggerGetCommand)
  .command("remove", workflowTriggerRemoveCommand);
