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
import { hostedWorkspaceFileOf } from "./hosted_workspace_file_repository.ts";

export const REPO_MARKER_FILE = ".swamp.yaml";

// hidden, so a scan passes over a folder while it is being removed
const DELETING_FOLDER_PATTERN =
  /^\.([a-z0-9][a-z0-9-]{0,62})\.deleting-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function deletingFolderName(name: string): string {
  return `.${parseWorkspaceName(name)}.deleting-${crypto.randomUUID()}`;
}

/** the workspace a hidden removal folder belonged to, or null for any other entry */
export function deletingFolderOwner(entry: string): string | null {
  const owner = DELETING_FOLDER_PATTERN.exec(entry)?.[1];
  if (owner === undefined) return null;
  // the name rule decides, so a removal never drifts from it
  try {
    return parseWorkspaceName(owner);
  } catch {
    return null;
  }
}

// hidden, so nothing lists a workspace before its rename into place
const CREATING_FOLDER_PATTERN =
  /^\.([a-z0-9][a-z0-9-]{0,62})\.creating-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function creatingFolderName(name: string): string {
  return `.${parseWorkspaceName(name)}.creating-${crypto.randomUUID()}`;
}

/** the workspace a hidden set-up folder belongs to, or null for any other entry */
export function creatingFolderOwner(entry: string): string | null {
  const owner = CREATING_FOLDER_PATTERN.exec(entry)?.[1];
  if (owner === undefined) return null;
  try {
    return parseWorkspaceName(owner);
  } catch {
    return null;
  }
}

export interface WorkspaceScan {
  /** the workspaces with a wanted file; sorted */
  readonly wantedFiles: readonly string[];
  /** performance.now() before the folder was listed */
  readonly startedAt: number;
}

/** the host's state folder holds no workspace: only its wanted files are read; a missing folder has none */
export async function scanWorkspaces(dir: string): Promise<WorkspaceScan> {
  const startedAt = performance.now();
  const wantedFiles: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { wantedFiles, startedAt };
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const file = hostedWorkspaceFileOf(entry.name);
    if (file?.kind === "wanted") wantedFiles.push(file.name);
  }
  wantedFiles.sort();
  return { wantedFiles, startedAt };
}
