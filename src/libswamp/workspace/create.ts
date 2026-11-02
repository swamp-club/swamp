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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { type WorkspaceDeps, workspaceErrorEvent } from "./deps.ts";
import { createNewWorkspace, newWorkspaceLocation } from "./workspace_store.ts";

export interface WorkspaceCreateData {
  readonly name: string;
  readonly path: string;
}

export type WorkspaceCreateEvent =
  | { kind: "completed"; data: WorkspaceCreateData }
  | { kind: "error"; error: SwampError };

/**
 * a new repo with no tools, registered at <parent>/<name>; with no parent it
 * goes in workspaces.dir, else under <data dir>/workspaces; refuses a
 * registered name and a folder left by workspace remove
 */
export async function* workspaceCreate(
  ctx: LibSwampContext,
  deps: WorkspaceDeps,
  input: { name: string; parent?: string; relativeTo?: string },
): AsyncIterable<WorkspaceCreateEvent> {
  yield* withGeneratorSpan(
    "swamp.workspace.create",
    {},
    (async function* () {
      try {
        const location = await newWorkspaceLocation(deps, input);
        const { name, path } = location;
        ctx.logger.debug`Creating workspace ${name} at ${path}`;
        await deps.withCreateLock(
          name,
          () => createNewWorkspace(deps, location),
        );
        yield { kind: "completed" as const, data: { name, path } };
      } catch (error) {
        yield workspaceErrorEvent(error);
      }
    })(),
  );
}
