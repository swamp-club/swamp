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

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import {
  type HostedWorkspaceDeps,
  hostedWorkspaceErrorEvent,
  hostedWorkspaceNames,
  type HostedWorkspaceSummary,
  summarizeHostedWorkspace,
} from "./deps.ts";

export interface HostedWorkspaceListData {
  readonly workspaces: readonly HostedWorkspaceSummary[];
}

export type HostedWorkspaceListEvent =
  | { kind: "completed"; data: HostedWorkspaceListData }
  | { kind: "error"; error: SwampError };

/** a workspace created suspended is listed before its folder appears */
export async function* hostedWorkspaceList(
  ctx: LibSwampContext,
  deps: HostedWorkspaceDeps,
): AsyncIterable<HostedWorkspaceListEvent> {
  yield* withGeneratorSpan(
    "swamp.hosted_workspace.list",
    {},
    (async function* () {
      try {
        const { all } = await hostedWorkspaceNames(deps);
        const workspaces = await Promise.all(
          all.map((name) => summarizeHostedWorkspace(deps, name)),
        );
        yield { kind: "completed" as const, data: { workspaces } };
      } catch (error) {
        yield hostedWorkspaceErrorEvent(ctx, error);
      }
    })(),
  );
}
