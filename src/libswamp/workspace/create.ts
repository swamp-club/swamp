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
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { type WorkspaceDeps, workspaceErrorEvent } from "./deps.ts";
import {
  defaultWorkspacePath,
  ensureWorkspace,
  folderState,
  loadWorkspaceRegistry,
  parseWorkspaceNameWithCode,
  realPathOrSelf,
} from "./workspace_store.ts";

/** A workspace `swamp workspace create` made. */
export interface WorkspaceCreateData {
  readonly name: string;
  readonly path: string;
}

export type WorkspaceCreateEvent =
  | { kind: "completed"; data: WorkspaceCreateData }
  | { kind: "error"; error: SwampError };

/**
 * Creates a workspace: a new repo with no tools under
 * `<data dir>/workspaces/<name>`, registered in the workspace registry.
 * Refuses a name that is registered, and a folder left behind by
 * `workspace remove` (importing it brings that workspace back).
 */
export async function* workspaceCreate(
  ctx: LibSwampContext,
  deps: WorkspaceDeps,
  input: { name: string },
): AsyncIterable<WorkspaceCreateEvent> {
  yield* withGeneratorSpan(
    "swamp.workspace.create",
    {},
    (async function* () {
      try {
        const name = parseWorkspaceNameWithCode(input.name);
        const path = defaultWorkspacePath(deps.dataDir, name);
        ctx.logger.debug`Creating workspace ${name} at ${path}`;
        await deps.withCreateLock(name, async () => {
          const registry = await loadWorkspaceRegistry(deps);
          const registered = registry.get(name);
          if (registered) {
            throw markErrorPaths(
              new UserError(
                `A workspace named "${name}" already exists at ${registered.path}. Choose another name.`,
                "name_taken",
              ),
              [registered.path],
            );
          }
          // Imports are registered by their real path (/tmp vs /private/tmp).
          const real = await realPathOrSelf(path);
          let sameFolder;
          for (const entry of registry.list()) {
            if (await realPathOrSelf(entry.path) === real) sameFolder = entry;
          }
          if (sameFolder) {
            throw markErrorPaths(
              new UserError(
                `${path} is already registered as the workspace "${sameFolder.name}".`,
                "folder_exists",
              ),
              [path],
            );
          }
          if (await deps.repo.isRepo(path)) {
            throw markErrorPaths(
              new UserError(
                `A workspace folder is already at ${path}, but it isn't registered. Bring it back with: swamp workspace import "${path}". Or delete the folder first.`,
                "folder_exists",
              ),
              [path],
            );
          }
          if (await folderState(path) === "not_empty") {
            throw markErrorPaths(
              new UserError(
                `${path} exists but isn't a Swamp workspace. Move it aside, or choose another name.`,
                "not_a_workspace",
              ),
              [path],
            );
          }
          const created = await ensureWorkspace(deps, name, path);
          // Strict: a name or folder registered meanwhile (an import does
          // not take the create lock) fails rather than being reported as
          // created.
          try {
            await deps.registry.update((registry) => {
              registry.register({
                name,
                path,
                createdAt: deps.now().toISOString(),
              });
            });
          } catch (error) {
            // Don't leave the repo just made behind, unregistered. The
            // folder was missing or empty before, so nothing else is lost.
            if (created) {
              await Deno.remove(path, { recursive: true }).catch(() => {});
            }
            throw error;
          }
        });
        yield { kind: "completed" as const, data: { name, path } };
      } catch (error) {
        yield workspaceErrorEvent(error);
      }
    })(),
  );
}
