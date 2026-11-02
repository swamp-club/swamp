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

import { basename } from "@std/path";
import { markErrorPaths, UserError } from "../../domain/errors.ts";

export interface FixedRepoDeps {
  realPath(path: string): Promise<string>;
  isRepo(path: string): Promise<boolean>;
  registered(): Promise<readonly { name: string; path: string }[]>;
}

export async function resolveFixedRepo(
  deps: FixedRepoDeps,
  repoDir: string,
): Promise<{ name: string; path: string }> {
  let path: string;
  try {
    path = await deps.realPath(repoDir);
  } catch {
    path = repoDir;
  }
  if (!await deps.isRepo(path)) {
    throw markErrorPaths(
      new UserError(
        `${repoDir} is not a swamp repo. Run \`swamp dashboard\` inside a swamp repo, point --repo-dir at one, or run \`swamp repo init\` there first.`,
        "not_a_repo",
      ),
      [repoDir],
    );
  }
  for (const entry of await deps.registered()) {
    let entryPath = entry.path;
    try {
      entryPath = await deps.realPath(entry.path);
    } catch {
      // A registered folder that is gone matches nothing.
    }
    if (entryPath === path) return { name: entry.name, path };
  }
  // A repo at the filesystem root has no folder name to show.
  const name = basename(path);
  return { name: name === "" || name === "/" ? "root" : name, path };
}
