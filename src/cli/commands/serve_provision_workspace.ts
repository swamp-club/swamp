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
import {
  provisionHostedWorkspace,
  readProvisionSpec,
} from "../hosted_workspace_provision.ts";
import { renderServeProvisionWorkspace } from "../../presentation/renderers/serve_provision_workspace.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const serveProvisionWorkspaceCommand = new Command()
  .name("provision-workspace")
  .hidden()
  .description(
    "Set up a hosted workspace's repo in the current folder. Internal: the serve host runs it as a child process with " +
      "the workspace's access settings as JSON on stdin, so the calling process never loads the new repo.",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "serve",
      "provision-workspace",
    ]);
    const dir = Deno.cwd();
    await provisionHostedWorkspace(
      dir,
      await readProvisionSpec(Deno.stdin.readable),
    );
    renderServeProvisionWorkspace(ctx.outputMode, { dir });
  });
