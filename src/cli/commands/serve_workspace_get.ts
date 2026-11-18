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
import { withRemoteOptions } from "../remote_run.ts";
import {
  defaultWorkspaceRequestDeps,
  namedWorkspaceRequest,
  sendWorkspaceRequest,
  type WorkspaceRequestDeps,
  type WorkspaceRequestOptions,
} from "../serve_workspace_request.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import { renderWorkspaceGet } from "../../presentation/output/serve_workspace_output.ts";
import type { WorkspaceGetResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export async function runServeWorkspaceGet(
  options: WorkspaceRequestOptions,
  name: string,
  mode: OutputMode,
  deps: WorkspaceRequestDeps = defaultWorkspaceRequestDeps,
): Promise<void> {
  const response = await sendWorkspaceRequest<WorkspaceGetResponse>(
    options,
    namedWorkspaceRequest("workspace.get", name),
    deps,
  );
  renderWorkspaceGet(response.data, mode);
}

export const serveWorkspaceGetCommand = withRemoteOptions(
  new Command()
    .name("get")
    .description(
      "Show one hosted workspace: its state, its restart count, and why it is not ready when it is not",
    )
    .example(
      "Show a workspace",
      "swamp serve workspace get edge-dns --server https://host.example",
    )
    .arguments("<name:string>"),
).action(async function (options: AnyOptions, name: string) {
  const ctx = createContext(options as GlobalOptions, [
    "serve",
    "workspace",
    "get",
  ]);
  await runServeWorkspaceGet(options, name, ctx.outputMode);
});
