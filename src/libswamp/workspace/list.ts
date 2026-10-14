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
import {
  summarizeWorkspace,
  type WorkspaceDeps,
  workspaceErrorEvent,
  type WorkspaceSummary,
} from "./deps.ts";
import { loadWorkspaceRegistry } from "./workspace_store.ts";

/** Every registered workspace, by name. */
export interface WorkspaceListData {
  readonly workspaces: readonly WorkspaceSummary[];
}

export type WorkspaceListEvent =
  | { kind: "completed"; data: WorkspaceListData }
  | { kind: "error"; error: SwampError };

/**
 * Lists every registered workspace, sorted by name, including those whose
 * folder is gone. Writes nothing: before the registry exists it reports
 * the folders `swamp start` created as if they were adopted.
 */
export async function* workspaceList(
  ctx: LibSwampContext,
  deps: WorkspaceDeps,
): AsyncIterable<WorkspaceListEvent> {
  yield* withGeneratorSpan(
    "swamp.workspace.list",
    {},
    (async function* () {
      try {
        ctx.logger.debug`Listing workspaces`;
        const registry = await loadWorkspaceRegistry(deps, { readOnly: true });
        const entries = registry.list().sort((a, b) =>
          a.name.localeCompare(b.name)
        );
        const workspaces = await Promise.all(
          entries.map((entry) => summarizeWorkspace(deps, entry)),
        );
        yield { kind: "completed" as const, data: { workspaces } };
      } catch (error) {
        yield workspaceErrorEvent(error);
      }
    })(),
  );
}
