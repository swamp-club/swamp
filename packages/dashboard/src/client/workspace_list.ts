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

export interface LocalWorkspace {
  name: string;
  path: string;
}

export interface WorkspaceList {
  workspaces: LocalWorkspace[];
  switchable: boolean;
}

/**
 * Reads `/api/local/workspaces`. A hub serving one fixed repo
 * (`swamp dashboard` in a folder) says it is not switchable; an answer
 * without the field comes from a hub that always was.
 */
export function parseWorkspaceList(body: unknown): WorkspaceList {
  const { workspaces, switchable } = (body ?? {}) as Record<string, unknown>;
  return {
    workspaces: Array.isArray(workspaces)
      ? workspaces.filter((w): w is LocalWorkspace =>
        typeof w?.name === "string" && typeof w?.path === "string"
      )
      : [],
    switchable: switchable !== false,
  };
}
