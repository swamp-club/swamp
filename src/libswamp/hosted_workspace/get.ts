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

import { parseWorkspaceName } from "../../domain/workspace/workspace_name.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import {
  type HostedWorkspaceDeps,
  hostedWorkspaceErrorEvent,
  hostedWorkspaceNames,
  hostedWorkspaceNotFound,
  type HostedWorkspaceSummary,
  summarizeHostedWorkspace,
} from "./deps.ts";

export type HostedWorkspaceGetData = HostedWorkspaceSummary;

export type HostedWorkspaceGetEvent =
  | { kind: "completed"; data: HostedWorkspaceGetData }
  | { kind: "error"; error: SwampError };

export async function* hostedWorkspaceGet(
  ctx: LibSwampContext,
  deps: HostedWorkspaceDeps,
  input: { name: string },
): AsyncIterable<HostedWorkspaceGetEvent> {
  yield* withGeneratorSpan(
    "swamp.hosted_workspace.get",
    {},
    (async function* () {
      try {
        const name = parseWorkspaceName(input.name);
        const { all } = await hostedWorkspaceNames(deps.workspacesDir);
        if (!all.includes(name)) throw hostedWorkspaceNotFound(name);
        yield {
          kind: "completed" as const,
          data: await summarizeHostedWorkspace(deps, name),
        };
      } catch (error) {
        yield hostedWorkspaceErrorEvent(ctx, error);
      }
    })(),
  );
}
