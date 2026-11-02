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

import { parse } from "@std/path";
import { resolveLocalImports } from "../models/local_import_resolver.ts";
import { hashFile, type SourceModuleLookup } from "./bundle_freshness.ts";

/**
 * a long-lived process compares it with the files on disk before bundling
 * again, so it never ships code other than what it loaded; holds no catalog
 * reference, which is closed by the time a run needs the bundle
 */
export interface SourceSnapshot {
  readonly files: readonly string[];
  readonly signature: string;
}

/**
 * when the catalog recorded no modules (a pulled extension with a pre-built
 * bundle), uses the relative-import closure
 */
export async function captureSourceSnapshot(
  absolutePath: string,
  modules: SourceModuleLookup,
): Promise<SourceSnapshot> {
  const recorded = modules.findSourceModules(absolutePath);
  const imported = recorded ??
    (await resolveLocalImports([absolutePath], parse(absolutePath).root))
      .resolvedFiles;
  const files = [...new Set([absolutePath, ...imported])];
  return { files, signature: await signFiles(files) };
}

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
 * the message names the type and extension only, never a path, since it reaches
 * remote clients
 */
export class StaleExtensionSourceError extends Error {
  constructor(typeNormalized: string, extensionName?: string) {
    super(
      `Behavior type ${typeNormalized}${
        extensionName ? ` (extension ${extensionName})` : ""
      } changed on disk after swamp serve loaded it, so serve will not send ` +
        `workers code it does not run itself. ` +
        (extensionName
          ? `Restart serve, or run 'swamp serve reload' (add --server <url> ` +
            `for a remote serve) if it was started with --hot-reload.`
          : `Run the step again: serve picks up the edited behavior before ` +
            `each run.`),
    );
    this.name = "StaleExtensionSourceError";
  }
}
