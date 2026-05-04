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

import { join, resolve } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import { readInstalledExtensionDigest } from "../../infrastructure/persistence/installed_extension_digest_reader.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";

/**
 * Tri-state outcome of the local-edits check.
 *
 * - `match` — on-disk digest equals the stored filesChecksum anchor;
 *   safe to overwrite.
 * - `mismatch` — on-disk digest diverges from the anchor; user has edited
 *   something since install and the caller must refuse silent overwrite.
 * - `no-anchor` — no stored anchor (pre-filesChecksum lockfile entry, or
 *   extension not installed at all). Grandfather path — caller proceeds
 *   as before the check existed.
 */
export type LocalEditsStatus = "match" | "mismatch" | "no-anchor";

/**
 * Compares the lockfile-stored filesChecksum for `name` against a fresh
 * digest of the on-disk per-extension subtree. Any infrastructure error
 * (lockfile unreadable, per-extension dir unwalkable) degrades to
 * `no-anchor` so callers never wedge a user command on a safety-check bug.
 */
export async function detectLocalEditsForExtension(
  repoDir: string,
  name: string,
  lockfilePath: string,
): Promise<LocalEditsStatus> {
  try {
    const repo = await LockfileRepository.create(lockfilePath);
    const stored = repo.getEntry(name)?.filesChecksum;
    if (!stored) return "no-anchor";
    const extRoot = join(
      resolve(repoDir),
      ".swamp",
      "pulled-extensions",
      name,
    );
    const onDisk = await readInstalledExtensionDigest(extRoot);
    if (onDisk === null) return "no-anchor";
    return onDisk === stored ? "match" : "mismatch";
  } catch {
    return "no-anchor";
  }
}

/**
 * Thrown synchronously by callers that refuse a force-overwrite when
 * local edits are detected. Message names the extension and points the
 * user at the explicit opt-in command. Extends UserError so CLI layers
 * render it without a stack trace; distinct class so HTTP layers can map
 * it to a dedicated status code (409 Conflict).
 */
export class LocalEditsError extends UserError {
  readonly extensionName: string;
  constructor(extensionName: string) {
    super(
      `Refusing to overwrite ${extensionName}: local edits detected under ` +
        `.swamp/pulled-extensions/${extensionName}/. Run ` +
        `'swamp extension pull ${extensionName} --force' from the terminal ` +
        `to overwrite, or revert your edits first.`,
    );
    this.name = "LocalEditsError";
    this.extensionName = extensionName;
  }
}
