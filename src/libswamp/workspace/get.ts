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
  workspaceNotFound,
  type WorkspaceSummary,
} from "./deps.ts";
import {
  loadWorkspaceRegistry,
  parseWorkspaceNameWithCode,
} from "./workspace_store.ts";

/** One workspace in detail. */
export interface WorkspaceGetData extends WorkspaceSummary {
  /** True when the user confirmed that agents may work in the folder. */
  readonly trusted: boolean;
  /** Tools the workspace is set up for; empty when its folder is gone. */
  readonly enrolledTools: readonly string[];
  /** True when a `swamp start` has the workspace open. */
  readonly openInStart: boolean;
}

export type WorkspaceGetEvent =
  | { kind: "completed"; data: WorkspaceGetData }
  | { kind: "error"; error: SwampError };

/** Shows one registered workspace. Writes nothing. */
export async function* workspaceGet(
  ctx: LibSwampContext,
  deps: WorkspaceDeps,
  input: { name: string },
): AsyncIterable<WorkspaceGetEvent> {
  yield* withGeneratorSpan(
    "swamp.workspace.get",
    {},
    (async function* () {
      try {
        const name = parseWorkspaceNameWithCode(input.name);
        ctx.logger.debug`Getting workspace ${name}`;
        const registry = await loadWorkspaceRegistry(deps, { readOnly: true });
        const entry = registry.get(name);
        if (!entry) throw workspaceNotFound(name);
        const summary = await summarizeWorkspace(deps, entry);
        const present = summary.folder === "ok";
        yield {
          kind: "completed" as const,
          data: {
            ...summary,
            trusted: registry.isTrusted(entry.path),
            enrolledTools: present ? await deps.enrolledTools(entry.path) : [],
            openInStart: present ? await deps.isOpenInStart(entry.path) : false,
          },
        };
      } catch (error) {
        yield workspaceErrorEvent(error);
      }
    })(),
  );
}
