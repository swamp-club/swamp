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
  typeDescribeCommand,
} from "./type_describe.ts";
import { createTypeSearchCommand, typeSearchCommand } from "./type_search.ts";

/** The subcommands of `model type`, in registration order. */
export interface ModelTypeChildren {
  readonly describe: ReturnType<typeof createTypeDescribeCommand>;
  readonly search: ReturnType<typeof createTypeSearchCommand>;
}

/** The legacy spelling: `swamp model type`. */
export const MODEL_TYPE_SYNTAX: CommandSyntax = {
  invocation: "swamp model type",
  surface: "model",
};

/** The preferred spelling: `swamp behavior type`. */
export const BEHAVIOR_TYPE_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior type",
  surface: "behavior",
};

/**
 * Builds the parent command for model type operations for one CLI surface.
 * Children not passed are built fresh from `syntax`; Cliffy reparents a
 * command attached under a second parent, so two surfaces must never share
 * an instance.
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

/**
 * Parent command for model type operations. Its subcommands keep their
 * legacy example text (`swamp type …`), so they are passed in.
 */
export const modelTypeCommand = createModelTypeCommand(MODEL_TYPE_SYNTAX, {
  describe: typeDescribeCommand,
  search: typeSearchCommand,
});
