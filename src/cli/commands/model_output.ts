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
  outputArgument,
  recordDefiningModule,
  subcommandSyntax,
  withPreferredExample,
} from "./command_syntax.ts";
import {
  createModelOutputGetCommand,
  MODEL_OUTPUT_GET_SYNTAX,
  modelOutputGetAction,
} from "./model_output_get.ts";
import {
  createModelOutputSearchCommand,
  MODEL_OUTPUT_SEARCH_SYNTAX,
} from "./model_output_search.ts";
import {
  createModelOutputLogsCommand,
  MODEL_OUTPUT_LOGS_SYNTAX,
} from "./model_output_logs.ts";
import {
  createModelOutputDataCommand,
  MODEL_OUTPUT_DATA_SYNTAX,
} from "./model_output_data.ts";

export interface ModelOutputChildren {
  readonly get: ReturnType<typeof createModelOutputGetCommand>;
  readonly search: ReturnType<typeof createModelOutputSearchCommand>;
  readonly logs: ReturnType<typeof createModelOutputLogsCommand>;
  readonly data: ReturnType<typeof createModelOutputDataCommand>;
}

export const BEHAVIOR_OUTPUT_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior output",
  surface: "behavior",
};

export const MODEL_OUTPUT_SYNTAX: CommandSyntax = {
  invocation: "swamp model output",
  surface: "model",
  preferred: `${BEHAVIOR_OUTPUT_SYNTAX.invocation} my-server`,
};

/**
 * Cliffy reparents a command attached under a second parent, so two surfaces
 * must never share an instance.
 */
export function createModelOutputCommand(
  syntax: CommandSyntax,
  children: Partial<ModelOutputChildren> = {},
) {
  const command = withPreferredExample(
    new Command()
      .name("output")
      .description(`Manage ${syntax.surface} outputs`)
      .error(unknownCommandErrorHandler)
      .example(
        "Show latest output (shorthand)",
        `${syntax.invocation} my-server`,
      ),
    syntax,
  )
    .arguments(`<${outputArgument(syntax.surface)}:string>`)
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .action(modelOutputGetAction)
    .command(
      "get",
      children.get ??
        createModelOutputGetCommand(subcommandSyntax(syntax, "get")),
    )
    .command(
      "search",
      children.search ??
        createModelOutputSearchCommand(subcommandSyntax(syntax, "search")),
    )
    .command(
      "logs",
      children.logs ??
        createModelOutputLogsCommand(subcommandSyntax(syntax, "logs")),
    )
    .command(
      "data",
      children.data ??
        createModelOutputDataCommand(subcommandSyntax(syntax, "data")),
    );
  return recordDefiningModule(command, import.meta.url);
}

/** each leaf carries its legacy constant's preferred spelling, which subcommandSyntax cannot derive */
export function createLegacyModelOutputCommand() {
  return createModelOutputCommand(MODEL_OUTPUT_SYNTAX, {
    get: createModelOutputGetCommand(MODEL_OUTPUT_GET_SYNTAX),
    search: createModelOutputSearchCommand(MODEL_OUTPUT_SEARCH_SYNTAX),
    logs: createModelOutputLogsCommand(MODEL_OUTPUT_LOGS_SYNTAX),
    data: createModelOutputDataCommand(MODEL_OUTPUT_DATA_SYNTAX),
  });
}
