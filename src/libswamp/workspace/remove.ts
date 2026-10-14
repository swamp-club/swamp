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
import type { WorkspaceEntry } from "../../domain/workspace/workspace_registry.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  type WorkspaceDeps,
  workspaceErrorEvent,
  workspaceNotFound,
} from "./deps.ts";
import {
  loadWorkspaceRegistry,
  parseWorkspaceNameWithCode,
} from "./workspace_store.ts";

/** A workspace taken off the registry. Its folder is left as it is. */
export interface WorkspaceRemoveData {
  readonly name: string;
  /** The folder, which is kept: importing it brings the workspace back. */
  readonly path: string;
  /** True when a `swamp start` still had the workspace open. */
  readonly openInStart: boolean;
}

export type WorkspaceRemoveEvent =
  | { kind: "completed"; data: WorkspaceRemoveData }
  | { kind: "error"; error: SwampError };

/**
 * Removes a workspace from the registry, and with it the trust confirmed
 * for its folder. Never touches the folder.
 */
export async function* workspaceRemove(
  ctx: LibSwampContext,
  deps: WorkspaceDeps,
  input: { name: string },
): AsyncIterable<WorkspaceRemoveEvent> {
  yield* withGeneratorSpan(
    "swamp.workspace.remove",
    {},
    (async function* () {
      try {
        const name = parseWorkspaceNameWithCode(input.name);
        ctx.logger.debug`Removing workspace ${name}`;
        // Adopt first, so the registry file exists and a later first read
        // never adopts the removed folder back.
        await loadWorkspaceRegistry(deps);
        const removed = await deps.registry.update(
          (registry): WorkspaceEntry => {
            const entry = registry.get(name);
            if (!entry) throw workspaceNotFound(name);
            registry.remove(name);
            return entry;
          },
        );
        yield {
          kind: "completed" as const,
          data: {
            name,
            path: removed.path,
            openInStart: await deps.isOpenInStart(removed.path).catch(() =>
              false
            ),
          },
        };
      } catch (error) {
        yield workspaceErrorEvent(error);
      }
    })(),
  );
}
