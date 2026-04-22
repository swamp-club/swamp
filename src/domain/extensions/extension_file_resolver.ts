// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { UserError } from "../errors.ts";
import { isSafeRelativePath } from "./extension_manifest.ts";

// Hardcoded on purpose: importing SWAMP_DATA_DIR from infrastructure would
// introduce a new domain→infrastructure dependency (see
// integration/ddd_layer_rules_test.ts ratchet). The underlying constant is
// stable (`.swamp`) and the pulled-extensions layout is a swamp-wide
// convention, not an infrastructure detail.
const PULLED_MARKER = "/.swamp/pulled-extensions/";

/**
 * Resolve a relative `additionalFiles` path against an extension's files
 * root. Mirrors the `extensionFile()` helper exposed on `MethodContext` and
 * `MethodReportContext`. Shared here so both contexts produce identical
 * validation, mode detection, and error messages without depending on each
 * other.
 *
 * Throws `UserError` when:
 *   - `root` is undefined (model is not part of an extension manifest)
 *   - `relPath` is unsafe (absolute, contains `..`, or starts with `/`)
 *   - the resolved file does not exist on disk
 */
export function resolveExtensionFile(
  root: string | undefined,
  relPath: string,
): string {
  if (root === undefined) {
    throw new UserError(
      "ctx.extensionFile() is only available for models and reports " +
        "shipped via an extension manifest. This model does not have an " +
        "associated manifest.yaml.",
    );
  }
  if (!isSafeRelativePath(relPath)) {
    throw new UserError(
      `Unsafe relative path passed to ctx.extensionFile(): "${relPath}". ` +
        `Paths must be relative, must not start with "/", and must not ` +
        `contain ".." segments.`,
    );
  }
  const absPath = join(root, relPath);
  try {
    Deno.lstatSync(absPath);
  } catch {
    const isPulled = root.includes(PULLED_MARKER);
    if (isPulled) {
      throw new UserError(
        `Extension file not found: "${relPath}". This can happen when ` +
          `the installed archive was packaged before directory ` +
          `preservation landed; re-publish the extension and re-pull to ` +
          `pick up the nested layout.`,
      );
    }
    throw new UserError(
      `Extension file not found: ${absPath}. Check that the file exists ` +
        `on disk and matches the manifest's additionalFiles entry.`,
    );
  }
  return absPath;
}
