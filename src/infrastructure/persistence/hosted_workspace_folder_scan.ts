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

import { join } from "@std/path";
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

export function isDeletingFolderName(entry: string): boolean {
  return deletingFolderOwner(entry) !== null;
}

export interface SkippedEntry {
  readonly name: string;
  readonly reason: string;
}

export interface WorkspaceScan {
  /** sorted */
  readonly workspaces: readonly string[];
  readonly skipped: readonly SkippedEntry[];
  /** the workspaces with a wanted file, with or without a folder; sorted */
  readonly wantedFiles: readonly string[];
  /** folders an interrupted removal left under their hidden name */
  readonly leftovers: readonly string[];
  /** performance.now() before the folder was listed */
  readonly startedAt: number;
}

/**
 * a missing folder holds no workspaces; hidden entries are passed over
 * silently. With repos false the folder is a state folder: only its wanted
 * files are read, and no entry in it is a workspace, skipped or a leftover.
 */
export async function scanWorkspaces(
  dir: string,
  options: { readonly repos?: boolean } = {},
): Promise<WorkspaceScan> {
  const repos = options.repos ?? true;
  const startedAt = performance.now();
  const workspaces: string[] = [];
  const skipped: SkippedEntry[] = [];
  const wantedFiles: string[] = [];
  const leftovers: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { workspaces, skipped, wantedFiles, leftovers, startedAt };
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      // a removal renames whatever is there, a link or a file included
      if (repos && isDeletingFolderName(entry.name)) {
        leftovers.push(entry.name);
      }
      continue;
    }
    const file = hostedWorkspaceFileOf(entry.name);
    if (file !== null) {
      if (file.kind === "wanted") wantedFiles.push(file.name);
      continue;
    }
    if (!repos) continue;
    const reason = await skipReason(dir, entry.name);
    if (reason === null) workspaces.push(entry.name);
    else skipped.push({ name: entry.name, reason });
  }
  workspaces.sort();
  wantedFiles.sort();
  leftovers.sort();
  return { workspaces, skipped, wantedFiles, leftovers, startedAt };
}

async function skipReason(dir: string, name: string): Promise<string | null> {
  try {
    parseWorkspaceName(name);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const path = join(dir, name);
  if (!(await isDirectory(path))) return "it is not a folder";
  if (!(await isFile(join(path, REPO_MARKER_FILE)))) {
    return `it has no ${REPO_MARKER_FILE}, so it is not a swamp repo yet`;
  }
  return null;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}
