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

import { hashFile, type SourceModuleLookup } from "./bundle_freshness.ts";

/**
 * The source files a registered extension type was loaded from, as they
 * stood when it was registered: one line per file with its content hash. A long-lived process compares it with the files on disk before it
 * bundles the source again (swamp-club#3594), so it never ships code other
 * than the code it loaded. Holds no catalog reference: the catalog a reload
 * registered from is closed by the time a run needs the bundle.
 */
export interface SourceSnapshot {
  readonly files: readonly string[];
  readonly signature: string;
}

/**
 * Snapshots `absolutePath` and the local modules the catalog recorded for
 * it. Without recorded modules only the entry file is covered.
 */
export async function captureSourceSnapshot(
  absolutePath: string,
  modules: SourceModuleLookup,
): Promise<SourceSnapshot> {
  const files = [
    ...new Set([
      absolutePath,
      ...(modules.findSourceModules(absolutePath) ?? []),
    ]),
  ];
  return { files, signature: await signFiles(files) };
}

/** Whether any snapshotted file was changed, replaced or removed since. */
export async function sourceSnapshotChanged(
  snapshot: SourceSnapshot,
): Promise<boolean> {
  return await signFiles(snapshot.files) !== snapshot.signature;
}

async function signFiles(files: readonly string[]): Promise<string> {
  const lines = await Promise.all(files.map(async (file) => {
    try {
      return `${file}\0${await hashFile(file)}`;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return `${file}\0missing`;
      throw error;
    }
  }));
  return lines.join("\n");
}

/**
 * A registered extension type's source changed on disk after the process
 * loaded it, so bundling it now would ship code the process does not run.
 * The message names the type and extension only, never a path: it reaches
 * remote clients.
 */
export class StaleExtensionSourceError extends Error {
  constructor(typeNormalized: string, extensionName?: string) {
    super(
      `Behavior type ${typeNormalized}${
        extensionName ? ` (extension ${extensionName})` : ""
      } changed on disk after swamp serve loaded it, so serve will not send ` +
        `workers code it does not run itself. Reload serve ` +
        `('swamp serve reload', with --hot-reload) or restart it to run ` +
        `the changed extension.`,
    );
    this.name = "StaleExtensionSourceError";
  }
}
