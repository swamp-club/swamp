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
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";
import {
  type CommandSyntax,
  recordDefiningModule,
  subcommandSyntax,
  withPreferredExample,
} from "./command_syntax.ts";
import { surfaceMethodNoun } from "../../presentation/command_surface.ts";
import {
  createModelMethodHistoryGetCommand,
  modelMethodHistoryGetAction,
  modelMethodHistoryGetCommand,
} from "./model_method_history_get.ts";
import {
  createModelMethodHistorySearchCommand,
  modelMethodHistorySearchCommand,
} from "./model_method_history_search.ts";
import {
  createModelMethodHistoryLogsCommand,
  modelMethodHistoryLogsCommand,
} from "./model_method_history_logs.ts";

/** The subcommands of `model method history`, in registration order. */
export interface ModelMethodHistoryChildren {
  readonly get: ReturnType<typeof createModelMethodHistoryGetCommand>;
  readonly search: ReturnType<typeof createModelMethodHistorySearchCommand>;
  readonly logs: ReturnType<typeof createModelMethodHistoryLogsCommand>;
}

/** The preferred spelling: `swamp behavior history`. */
export const BEHAVIOR_HISTORY_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior history",
  surface: "behavior",
};

/** The legacy spelling: `swamp model method history`. */
export const MODEL_METHOD_HISTORY_SYNTAX: CommandSyntax = {
  invocation: "swamp model method history",
  surface: "model",
  preferred: `${BEHAVIOR_HISTORY_SYNTAX.invocation} my-server`,
};

/**
 * Builds the `history` group for one CLI surface. Children not passed are
 * built fresh from `syntax`; Cliffy reparents a command attached under a
 * second parent, so two surfaces must never share an instance.
 */
export function createModelMethodHistoryCommand(
  syntax: CommandSyntax,
  children: Partial<ModelMethodHistoryChildren> = {},
) {
  const methodNoun = surfaceMethodNoun(syntax.surface);
  const command = withPreferredExample(
    new Command()
      .name("history")
      .description(
        `${methodNoun[0].toUpperCase()}${
          methodNoun.slice(1)
        } run history commands`,
      )
      .error(unknownCommandErrorHandler)
      .example(
        "Show latest run (shorthand)",
        `${syntax.invocation} my-server`,
      ),
    syntax,
  )
    .arguments("<output_id_or_model_name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .action(modelMethodHistoryGetAction)
    .command(
      "get",
      children.get ??
        createModelMethodHistoryGetCommand(subcommandSyntax(syntax, "get")),
    )
    .command(
      "search",
      children.search ??
        createModelMethodHistorySearchCommand(
          subcommandSyntax(syntax, "search"),
        ),
    )
    .command(
      "logs",
      children.logs ??
        createModelMethodHistoryLogsCommand(subcommandSyntax(syntax, "logs")),
    );
  return recordDefiningModule(command, import.meta.url);
}

export const modelMethodHistoryCommand = createModelMethodHistoryCommand(
  MODEL_METHOD_HISTORY_SYNTAX,
  {
    get: modelMethodHistoryGetCommand,
    search: modelMethodHistorySearchCommand,
    logs: modelMethodHistoryLogsCommand,
  },
);
