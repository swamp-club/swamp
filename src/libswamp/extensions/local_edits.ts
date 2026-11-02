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
import { resolvePulledExtensionsRoot } from "../../infrastructure/persistence/paths.ts";
import { UserError } from "../../domain/errors.ts";
import { installedDigestMatches } from "../../infrastructure/persistence/installed_extension_digest_reader.ts";
import { nestedEntryRelDirs } from "../../domain/extensions/install_journal.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";

/**
 * no-anchor is the grandfather path: no stored filesChecksum (older lockfile
 * entry, or extension not installed), so the caller proceeds as before the
 * check existed; mismatch means the caller must refuse a silent overwrite
 */
export type LocalEditsStatus = "match" | "mismatch" | "no-anchor";

/**
 * any infrastructure error degrades to no-anchor, so callers never wedge a user
 * command on a safety-check bug
 */
export async function detectLocalEditsForExtension(
  repoDir: string,
  name: string,
  lockfilePath: string,
  pulledExtensionsRoot?: string,
): Promise<LocalEditsStatus> {
  try {
    const repo = await LockfileRepository.create(lockfilePath);
    const stored = repo.getEntry(name)?.filesChecksum;
    if (!stored) return "no-anchor";
    const effectivePulledRoot = pulledExtensionsRoot ??
      resolvePulledExtensionsRoot(repoDir);
    const extRoot = join(effectivePulledRoot, name);
    const matches = await installedDigestMatches(
      extRoot,
      stored,
      nestedEntryRelDirs(name, Object.keys(repo.getAllEntries())),
    );
    if (matches === null) return "no-anchor";
    return matches ? "match" : "mismatch";
  } catch {
    return "no-anchor";
  }
}

/**
 * distinct class so HTTP layers can map it to 409 Conflict; extends UserError
 * so CLI layers render it without a stack trace
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
