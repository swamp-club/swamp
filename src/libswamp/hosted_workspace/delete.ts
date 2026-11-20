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

import type { HostedWorkspaceWanted } from "../../domain/serve/hosted_workspace.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import {
  changeHostedWorkspace,
  type HostedWorkspaceDeps,
  hostedWorkspaceErrorEvent,
  operatorWorkspaceFolderClaimed,
  operatorWorkspaceUndeletable,
  registryUnreadableUndeletable,
} from "./deps.ts";

export interface HostedWorkspaceDeleteData {
  readonly name: string;
  readonly wanted: HostedWorkspaceWanted;
  readonly changedAt: string | null;
}

export type HostedWorkspaceDeleteEvent =
  | { kind: "completed"; data: HostedWorkspaceDeleteData }
  | { kind: "error"; error: SwampError };

/** the host stops its serve and removes its folder and both files */
export async function* hostedWorkspaceDelete(
  ctx: LibSwampContext,
  deps: HostedWorkspaceDeps,
  input: { name: string },
): AsyncIterable<HostedWorkspaceDeleteEvent> {
  yield* withGeneratorSpan(
    "swamp.hosted_workspace.delete",
    {},
    (async function* () {
      try {
        const workspace = await changeHostedWorkspace(ctx, deps, input.name, {
          apply: (current, at) => current.markDeleted(at),
          // without the registry no clash can be seen, so nothing is deleted
          refuse: (name, whose) =>
            !whose.registryRead
              ? registryUnreadableUndeletable(name)
              : whose.owner === "operator"
              ? operatorWorkspaceUndeletable(name)
              : null,
          refuseClaimed: operatorWorkspaceFolderClaimed,
        });
        yield {
          kind: "completed" as const,
          data: {
            name: workspace.name,
            wanted: workspace.wanted,
            changedAt: workspace.changedAt,
          },
        };
      } catch (error) {
        yield hostedWorkspaceErrorEvent(ctx, error);
      }
    })(),
  );
}
