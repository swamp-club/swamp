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
import { commandTargetOf, withRemoteOptions } from "../remote_run.ts";
import {
  defaultWorkspaceRequestDeps,
  namedWorkspaceRequest,
  sendWorkspaceRequest,
  type WorkspaceRequestDeps,
  type WorkspaceRequestOptions,
} from "../serve_workspace_request.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import { renderWorkspaceChange } from "../../presentation/output/serve_workspace_output.ts";
import type { WorkspaceChangeResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export async function runServeWorkspaceResume(
  options: WorkspaceRequestOptions,
  name: string,
  mode: OutputMode,
  deps: WorkspaceRequestDeps = defaultWorkspaceRequestDeps,
): Promise<void> {
  const response = await sendWorkspaceRequest<WorkspaceChangeResponse>(
    options,
    namedWorkspaceRequest("workspace.resume", name),
    deps,
  );
  renderWorkspaceChange(
    "resume",
    response.data,
    mode,
    commandTargetOf(options),
  );
}

export const serveWorkspaceResumeCommand = withRemoteOptions(
  new Command()
    .name("resume")
    .description(
      "Start a hosted workspace's serve: how a new workspace is started, and how a suspended one comes back",
    )
    .example(
      "Start a workspace",
      "swamp serve workspace resume edge-dns --server https://host.example",
    )
    .arguments("<name:string>"),
).action(async function (options: AnyOptions, name: string) {
  const ctx = createContext(options as GlobalOptions, [
    "serve",
    "workspace",
    "resume",
  ]);
  await runServeWorkspaceResume(options, name, ctx.outputMode);
});
