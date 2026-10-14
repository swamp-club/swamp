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
import { importWorkspace } from "./workspace_store.ts";

/** A workspace registered from an existing repo. */
export interface WorkspaceImportData {
  readonly name: string;
  readonly path: string;
  /** True when the folder was registered already; nothing changed. */
  readonly alreadyRegistered: boolean;
}

export type WorkspaceImportEvent =
  | { kind: "completed"; data: WorkspaceImportData }
  | { kind: "error"; error: SwampError };

/**
 * Registers an existing swamp repo as a workspace where it is, the way the
 * `swamp start` page imports one. Nothing is moved or copied.
 */
export async function* workspaceImport(
  ctx: LibSwampContext,
  deps: WorkspaceDeps,
  input: { path: string; name?: string },
): AsyncIterable<WorkspaceImportEvent> {
  yield* withGeneratorSpan(
    "swamp.workspace.import",
    {},
    (async function* () {
      try {
        ctx.logger.debug`Importing workspace from ${input.path}`;
        yield {
          kind: "completed" as const,
          data: await importWorkspace(deps, input),
        };
      } catch (error) {
        yield workspaceErrorEvent(error);
      }
    })(),
  );
}
