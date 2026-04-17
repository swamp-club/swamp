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
import { readUpstreamExtensions } from "../../infrastructure/persistence/upstream_extensions.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  type InstallContext,
  installExtension,
  parseExtensionRef,
} from "./pull.ts";

/** Result of installing a single extension during bulk install. */
export interface ExtensionInstallEntry {
  name: string;
  version: string;
  status: "installed" | "up_to_date" | "failed";
  error?: string;
}

/** Data for the completed event. */
export interface ExtensionInstallData {
  entries: ExtensionInstallEntry[];
  installed: number;
  upToDate: number;
  failed: number;
}

export type ExtensionInstallEvent =
  | { kind: "resolving" }
  | { kind: "installing"; name: string; version: string }
  | { kind: "completed"; data: ExtensionInstallData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the extension install operation. */
export interface ExtensionInstallDeps {
  lockfilePath: string;
  repoDir: string;
  createInstallContext: (
    name: string,
    version: string,
  ) => InstallContext;
}

/**
 * Reads upstream_extensions.json and re-pulls any extensions whose files
 * are missing from disk. Analogous to `npm install` restoring node_modules
 * from package-lock.json.
 */
export async function* extensionInstall(
  _ctx: LibSwampContext,
  deps: ExtensionInstallDeps,
): AsyncIterable<ExtensionInstallEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.install",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const upstream = await readUpstreamExtensions(deps.lockfilePath);
      const entries: ExtensionInstallEntry[] = [];
      let installed = 0;
      let upToDate = 0;
      let failed = 0;

      for (const [name, entry] of Object.entries(upstream)) {
        const version = entry.version;

        // Check if any source files are missing
        const isMissing = await hasAnyMissingFiles(
          entry.files ?? [],
          deps.repoDir,
        );

        if (!isMissing) {
          entries.push({ name, version, status: "up_to_date" });
          upToDate++;
          continue;
        }

        yield { kind: "installing", name, version };

        try {
          const installCtx = deps.createInstallContext(name, version);
          // Thread the lockfile's stored checksum through as an integrity
          // anchor. installExtension verifies the freshly-downloaded archive
          // matches byte-for-byte and fails loudly on registry drift.
          // Pre-checksum-tracking entries (pre-f4dfc083) have no stored
          // value and skip verification (handled in installExtension).
          if (entry.checksum) {
            installCtx.expectedChecksum = entry.checksum;
          }
          const ref = parseExtensionRef(`${name}@${version}`);
          await installExtension(ref, installCtx);
          entries.push({ name, version, status: "installed" });
          installed++;
        } catch (error) {
          entries.push({
            name,
            version,
            status: "failed",
            error: String(error),
          });
          failed++;
        }
      }

      yield {
        kind: "completed",
        data: { entries, installed, upToDate, failed },
      };
    })(),
  );
}

/**
 * Checks if any of the given file paths are missing from disk.
 */
async function hasAnyMissingFiles(
  files: string[],
  repoDir: string,
): Promise<boolean> {
  for (const file of files) {
    const absolutePath = join(repoDir, file);
    try {
      await Deno.stat(absolutePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return true;
      }
      throw error;
    }
  }
  return false;
}
