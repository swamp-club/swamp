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
import {
  type CommandSyntax,
  recordDefiningModule,
  subcommandSyntax,
} from "./command_syntax.ts";
import {
  createTypeDescribeCommand,
  MODEL_TYPE_DESCRIBE_SYNTAX,
} from "./type_describe.ts";
import {
  createTypeSearchCommand,
  MODEL_TYPE_SEARCH_SYNTAX,
} from "./type_search.ts";

export interface ModelTypeChildren {
  readonly describe: ReturnType<typeof createTypeDescribeCommand>;
  readonly search: ReturnType<typeof createTypeSearchCommand>;
}

export const MODEL_TYPE_SYNTAX: CommandSyntax = {
  invocation: "swamp model type",
  surface: "model",
};

export const BEHAVIOR_TYPE_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior type",
  surface: "behavior",
};

/**
 * Cliffy reparents a command attached under a second parent, so two surfaces
 * must never share an instance.
 */
export function createModelTypeCommand(
  syntax: CommandSyntax,
  children: Partial<ModelTypeChildren> = {},
) {
  const command = new Command()
    .name("type")
    .description(`Inspect ${syntax.surface} types`)
    .action(groupCommandAction)
    .command(
      "describe",
      children.describe ??
        createTypeDescribeCommand(subcommandSyntax(syntax, "describe")),
    )
    .command(
      "search",
      children.search ??
        createTypeSearchCommand(subcommandSyntax(syntax, "search")),
    );
  return recordDefiningModule(command, import.meta.url);
}

/** each leaf carries its legacy constant's preferred spelling, which subcommandSyntax cannot derive */
export function createLegacyModelTypeCommand() {
  return createModelTypeCommand(MODEL_TYPE_SYNTAX, {
    describe: createTypeDescribeCommand(MODEL_TYPE_DESCRIBE_SYNTAX),
    search: createTypeSearchCommand(MODEL_TYPE_SEARCH_SYNTAX),
  });
}
