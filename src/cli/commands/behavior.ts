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
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";
import {
  BEHAVIOR_RUN_SYNTAX,
  createModelMethodRunCommand,
} from "./model_method_run.ts";

/**
 * `swamp behavior run <model> <method>` — the preferred way to invoke a model
 * method (swamp-club#3265).
 *
 * `behavior` is an agent-facing name for a model method invocation, not a new
 * primitive: this leaf is built by the same factory as `swamp model method
 * run` and delegates to the same application path, so the serve protocol,
 * the audit action `model.method.run`, locks, run tracking and data ownership
 * are untouched. The British spelling `behaviour` is an alias of the group.
 */
export const behaviorRunCommand = createModelMethodRunCommand(
  BEHAVIOR_RUN_SYNTAX,
);

export const behaviorCommand = new Command()
  .name("behavior")
  .alias("behaviour")
  .description("Run a model method (preferred over 'model method run')")
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("run", behaviorRunCommand);
