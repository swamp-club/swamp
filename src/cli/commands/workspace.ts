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
import { createContext, type GlobalOptions } from "../context.ts";
import { groupCommandAction } from "../group_action.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createWorkspaceDeps } from "../../libswamp/workspace/deps.ts";
import { workspaceCreate } from "../../libswamp/workspace/create.ts";
import { workspaceGet } from "../../libswamp/workspace/get.ts";
import { workspaceImport } from "../../libswamp/workspace/import.ts";
import { workspaceList } from "../../libswamp/workspace/list.ts";
import { workspaceRemove } from "../../libswamp/workspace/remove.ts";
import {
  createWorkspaceCreateHandlers,
  createWorkspaceGetHandlers,
  createWorkspaceImportHandlers,
  createWorkspaceListHandlers,
  createWorkspaceRemoveHandlers,
} from "../../presentation/renderers/workspace.ts";
import { VERSION } from "./version.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

function setup(options: AnyOptions, path: string[]) {
  const cliCtx = createContext(options as GlobalOptions, path);
  return {
    cliCtx,
    ctx: createLibSwampContext({ logger: cliCtx.logger }),
    deps: createWorkspaceDeps({ version: VERSION }),
  };
}

const workspaceCreateCommand = new Command()
  .name("create")
  .description(
    "Create a workspace: a new swamp repo under the swamp data dir, with no agent set up",
  )
  .arguments("<name:string>")
  .example("Create a workspace", "swamp workspace create prod")
  .action(async function (options: AnyOptions, name: string) {
    const { cliCtx, ctx, deps } = setup(options, ["workspace", "create"]);
    await consumeStream(
      workspaceCreate(ctx, deps, { name }),
      createWorkspaceCreateHandlers(cliCtx.outputMode),
    );
  });

const workspaceImportCommand = new Command()
  .name("import")
  .description(
    "Register an existing swamp repo as a workspace, where it is. Nothing is moved or copied",
  )
  .arguments("<path:string>")
  .option(
    "--name <name:string>",
    "Workspace name (default: made from the folder's name)",
  )
  .example("Import a repo", "swamp workspace import ~/code/infra")
  .example(
    "Import under another name",
    "swamp workspace import ~/code/infra --name infra-prod",
  )
  .action(async function (options: AnyOptions, path: string) {
    const { cliCtx, ctx, deps } = setup(options, ["workspace", "import"]);
    await consumeStream(
      workspaceImport(ctx, deps, {
        path,
        ...(options.name !== undefined ? { name: options.name } : {}),
      }),
      createWorkspaceImportHandlers(cliCtx.outputMode),
    );
  });

const workspaceListCommand = new Command()
  .name("list")
  .description("List registered workspaces")
  .example("List workspaces", "swamp workspace list")
  .action(async function (options: AnyOptions) {
    const { cliCtx, ctx, deps } = setup(options, ["workspace", "list"]);
    await consumeStream(
      workspaceList(ctx, deps),
      createWorkspaceListHandlers(cliCtx.outputMode),
    );
  });

const workspaceGetCommand = new Command()
  .name("get")
  .description("Show one workspace")
  .arguments("<name:string>")
  .example("Show a workspace", "swamp workspace get prod")
  .action(async function (options: AnyOptions, name: string) {
    const { cliCtx, ctx, deps } = setup(options, ["workspace", "get"]);
    await consumeStream(
      workspaceGet(ctx, deps, { name }),
      createWorkspaceGetHandlers(cliCtx.outputMode),
    );
  });

const workspaceRemoveCommand = new Command()
  .name("remove")
  .description(
    "Remove a workspace from the list. Its folder is kept; import it to bring it back",
  )
  .arguments("<name:string>")
  .example("Remove a workspace", "swamp workspace remove prod")
  .action(async function (options: AnyOptions, name: string) {
    const { cliCtx, ctx, deps } = setup(options, ["workspace", "remove"]);
    await consumeStream(
      workspaceRemove(ctx, deps, { name }),
      createWorkspaceRemoveHandlers(cliCtx.outputMode),
    );
  });

export const workspaceCommand = new Command()
  .name("workspace")
  .description(
    "Manage workspaces: swamp repos Swamp keeps track of, wherever they are",
  )
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("create", workspaceCreateCommand)
  .command("import", workspaceImportCommand)
  .command("list", workspaceListCommand)
  .command("get", workspaceGetCommand)
  .command("remove", workspaceRemoveCommand);
