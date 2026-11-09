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
import { markErrorPaths, UserError } from "../errors.ts";
import { isSafeRelativePath } from "./extension_manifest.ts";

// hardcoded to avoid a domain-to-infrastructure import of SWAMP_DATA_DIR;
// anchored at start or a forward slash, the caller having normalized
// backslashes
const PULLED_MARKER = /(^|\/)\.swamp\/(config\/)?pulled-extensions\//;

export function resolveExtensionFile(
  root: string | undefined,
  relPath: string,
): string {
  if (root === undefined) {
    throw new UserError(
      "ctx.extensionFile() is only available for behaviors and reports " +
        "shipped via an extension manifest. This behavior does not have an " +
        "associated manifest.yaml.",
    );
  }
  if (!isSafeRelativePath(relPath)) {
    throw markErrorPaths(
      new UserError(
        `Unsafe relative path passed to ctx.extensionFile(): "${relPath}". ` +
          `Paths must be relative, must not start with "/", and must not ` +
          `contain ".." segments.`,
      ),
      [relPath],
    );
  }
  const absPath = join(root, relPath);
  try {
    Deno.lstatSync(absPath);
  } catch {
    // Normalize backslashes so the marker check matches on Windows too.
    const isPulled = PULLED_MARKER.test(root.replaceAll("\\", "/"));
    if (isPulled) {
      throw markErrorPaths(
        new UserError(
          `Extension file not found: "${relPath}". This can happen when ` +
            `the installed archive was packaged before directory ` +
            `preservation landed; re-publish the extension and re-pull to ` +
            `pick up the nested layout.`,
        ),
        [relPath],
      );
    }
    throw markErrorPaths(
      new UserError(
        `Extension file not found: ${absPath}. Check that the file exists ` +
          `on disk and matches the manifest's additionalFiles or binaries entry.`,
      ),
      [absPath],
    );
  }
  return absPath;
}
