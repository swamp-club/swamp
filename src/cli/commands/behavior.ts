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
import type { CommandSyntax } from "./command_syntax.ts";
import {
  BEHAVIOR_RUN_SYNTAX,
  createModelMethodRunCommand,
} from "./model_method_run.ts";
import {
  BEHAVIOR_CREATE_SYNTAX,
  createModelCreateCommand,
} from "./model_create.ts";
import { BEHAVIOR_GET_SYNTAX, createModelGetCommand } from "./model_get.ts";
import { BEHAVIOR_EDIT_SYNTAX, createModelEditCommand } from "./model_edit.ts";
import {
  BEHAVIOR_DELETE_SYNTAX,
  createModelDeleteCommand,
} from "./model_delete.ts";
import {
  BEHAVIOR_VALIDATE_SYNTAX,
  createModelValidateCommand,
} from "./model_validate.ts";
import {
  BEHAVIOR_EVALUATE_SYNTAX,
  createModelEvaluateCommand,
} from "./model_evaluate.ts";
import {
  BEHAVIOR_SEARCH_SYNTAX,
  createModelSearchCommand,
} from "./model_search.ts";
import {
  BEHAVIOR_CANCEL_SYNTAX,
  createModelCancelCommand,
} from "./model_cancel.ts";
import {
  BEHAVIOR_DESCRIBE_SYNTAX,
  createModelMethodDescribeCommand,
} from "./model_method_describe.ts";
import {
  BEHAVIOR_HISTORY_SYNTAX,
  createModelMethodHistoryCommand,
} from "./model_method_history.ts";
import {
  BEHAVIOR_OUTPUT_SYNTAX,
  createModelOutputCommand,
} from "./model_output.ts";
import { BEHAVIOR_TYPE_SYNTAX, createModelTypeCommand } from "./model_type.ts";

/** The preferred spelling of the group: `swamp behavior`. */
export const BEHAVIOR_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior",
  surface: "behavior",
};

/**
 * `swamp behavior run <model> <method>` — the preferred way to invoke a model
 * method (swamp-club#3265).
 *
 * `behavior` is the product term for a model (design/primitives/behaviors.md),
 * not a new primitive: this leaf is built by the same factory as `swamp model
 * method run` and delegates to the same application path, so the serve
 * protocol, the audit action `model.method.run`, locks, run tracking and data
 * ownership are untouched.
 */
export const behaviorRunCommand = createModelMethodRunCommand(
  BEHAVIOR_RUN_SYNTAX,
);

/**
 * `swamp behavior …` — the preferred spelling of every `swamp model …`
 * command (swamp-club#3331). Each subcommand is a fresh instance from the
 * same factory as its legacy twin, built from a behavior syntax: the
 * arguments, options and action are the twin's, and only the help text and
 * the log-mode wording say behavior. JSON output, errors and the serve
 * protocol are identical. There is no `method` level: `run`, `describe` and
 * `history` sit directly under the group. The British spelling `behaviour`
 * is an alias of the group.
 */
export const behaviorCommand = new Command()
  .name("behavior")
  .alias("behaviour")
  .description("Manage and run behaviors (preferred over 'model')")
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("run", behaviorRunCommand)
  .command("create", createModelCreateCommand(BEHAVIOR_CREATE_SYNTAX))
  .command("get", createModelGetCommand(BEHAVIOR_GET_SYNTAX))
  .command("edit", createModelEditCommand(BEHAVIOR_EDIT_SYNTAX))
  .command("delete", createModelDeleteCommand(BEHAVIOR_DELETE_SYNTAX))
  .command("validate", createModelValidateCommand(BEHAVIOR_VALIDATE_SYNTAX))
  .command("evaluate", createModelEvaluateCommand(BEHAVIOR_EVALUATE_SYNTAX))
  .command("search", createModelSearchCommand(BEHAVIOR_SEARCH_SYNTAX))
  .command("cancel", createModelCancelCommand(BEHAVIOR_CANCEL_SYNTAX))
  .command(
    "describe",
    createModelMethodDescribeCommand(BEHAVIOR_DESCRIBE_SYNTAX),
  )
  .command("history", createModelMethodHistoryCommand(BEHAVIOR_HISTORY_SYNTAX))
  .command("output", createModelOutputCommand(BEHAVIOR_OUTPUT_SYNTAX))
  .command("type", createModelTypeCommand(BEHAVIOR_TYPE_SYNTAX));
