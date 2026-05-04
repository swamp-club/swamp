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

import { dirname, join, resolve } from "@std/path";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import type { UpstreamExtensionsMap } from "../../infrastructure/persistence/upstream_extensions.ts";
import { parseExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import { UserError } from "../../domain/errors.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

/** Preview data returned before confirmation. */
export interface ExtensionRmPreview {
  name: string;
  version: string;
  fileCount: number;
  dependents: string[];
}

/** Data structure for the extension rm completed event. */
export interface ExtensionRmData {
  name: string;
  version: string;
  filesDeleted: number;
  filesSkipped: number;
  dirsRemoved: number;
}

export type ExtensionRmEvent =
  | { kind: "deleting" }
  | { kind: "completed"; data: ExtensionRmData }
  | { kind: "error"; error: SwampError };

/** Input for the extension rm operation. */
export interface ExtensionRmInput {
  extensionName: string;
}

/** Dependencies for the extension rm operation. */
export interface ExtensionRmDeps {
  findDependents: (
    repoDir: string,
    upstreamData: UpstreamExtensionsMap,
    targetName: string,
  ) => Promise<string[]>;
  removeFile: (path: string) => Promise<void>;
  readDirEntries: (path: string) => Promise<Deno.DirEntry[]>;
  removeDir: (path: string) => Promise<void>;
  /**
   * Lockfile repository owning read+write of upstream_extensions.json.
   * Captures a snapshot at construction (per its own JSDoc); construct
   * fresh deps per rm operation via {@link createExtensionRmDeps}.
   */
  lockfileRepository: LockfileRepository;
  repoDir: string;
}

/**
 * Finds installed extensions that depend on the given extension name
 * by scanning manifest.yaml files tracked in upstream_extensions.json.
 */
export async function findDependents(
  repoDir: string,
  upstreamData: UpstreamExtensionsMap,
  targetName: string,
): Promise<string[]> {
  const dependents: string[] = [];

  for (const [extName, entry] of Object.entries(upstreamData)) {
    if (extName === targetName) continue;
    if (!entry.files) continue;

    const manifestFile = entry.files.find((f) => f.endsWith("manifest.yaml"));
    if (!manifestFile) continue;

    try {
      const manifestPath = join(repoDir, manifestFile);
      const content = await Deno.readTextFile(manifestPath);
      const manifest = parseExtensionManifest(content);
      if (manifest.dependencies.includes(targetName)) {
        dependents.push(extName);
      }
    } catch {
      // If manifest can't be read or parsed, skip
    }
  }

  return dependents;
}

/**
 * Removes empty parent directories up to (but not including) the stop directory.
 * Returns the number of directories removed.
 */
async function pruneEmptyDirs(
  dirs: string[],
  stopDir: string,
  deps: Pick<ExtensionRmDeps, "readDirEntries" | "removeDir">,
): Promise<number> {
  let removed = 0;
  const resolvedStop = resolve(stopDir);

  const sorted = [...new Set(dirs)].sort((a, b) => b.length - a.length);

  for (const dir of sorted) {
    let current = resolve(dir);
    while (current.length > resolvedStop.length && current !== resolvedStop) {
      try {
        const entries = await deps.readDirEntries(current);
        if (entries.length === 0) {
          await deps.removeDir(current);
          removed++;
          current = dirname(current);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }

  return removed;
}

/** Gathers preview info for the extension rm operation. */
export async function extensionRmPreview(
  ctx: LibSwampContext,
  deps: ExtensionRmDeps,
  input: ExtensionRmInput,
): Promise<ExtensionRmPreview> {
  ctx.logger.debug`Looking up extension: ${input.extensionName}`;

  const upstreamData = deps.lockfileRepository.getAllEntries();
  const entry = upstreamData[input.extensionName];

  if (!entry) {
    throw new UserError(
      `Extension ${input.extensionName} is not installed.`,
    );
  }

  if (!entry.files) {
    throw new UserError(
      `Extension ${input.extensionName} was pulled before file tracking was added. Re-pull with --force to populate the file list, then retry rm.`,
    );
  }

  const dependents = await deps.findDependents(
    deps.repoDir,
    upstreamData,
    input.extensionName,
  );

  return {
    name: input.extensionName,
    version: entry.version,
    fileCount: entry.files.length,
    dependents,
  };
}

/** Removes an extension and its tracked files. */
export async function* extensionRm(
  ctx: LibSwampContext,
  deps: ExtensionRmDeps,
  input: ExtensionRmInput,
): AsyncIterable<ExtensionRmEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.rm",
    {},
    (async function* () {
      yield { kind: "deleting" };

      const entry = deps.lockfileRepository.getEntry(input.extensionName);

      if (!entry || !entry.files) {
        yield {
          kind: "error",
          error: notFound("Extension", input.extensionName),
        };
        return;
      }

      let filesDeleted = 0;
      let filesSkipped = 0;
      const parentDirs: string[] = [];

      for (const filePath of entry.files) {
        const absolutePath = join(deps.repoDir, filePath);
        try {
          await deps.removeFile(absolutePath);
          filesDeleted++;
          parentDirs.push(dirname(absolutePath));
          ctx.logger.debug("  deleted {file}", { file: filePath });
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            filesSkipped++;
            ctx.logger.debug("  skipped {file} (already missing)", {
              file: filePath,
            });
          } else {
            throw error;
          }
        }
      }

      const dirsRemoved = await pruneEmptyDirs(parentDirs, deps.repoDir, deps);

      await deps.lockfileRepository.removeEntry(input.extensionName);

      yield {
        kind: "completed",
        data: {
          name: input.extensionName,
          version: entry.version,
          filesDeleted,
          filesSkipped,
          dirsRemoved,
        },
      };
    })(),
  );
}

/**
 * Wires real infrastructure into ExtensionRmDeps. Constructs a fresh
 * {@link LockfileRepository} that captures a snapshot at this moment;
 * the returned deps object is single-use per the
 * {@link ExtensionRmDeps.lockfileRepository} JSDoc.
 */
export async function createExtensionRmDeps(
  repoDir: string,
  lockfilePath: string,
): Promise<ExtensionRmDeps> {
  const lockfileRepository = await LockfileRepository.create(lockfilePath);
  return {
    findDependents,
    removeFile: async (path: string) => {
      const stat = await Deno.stat(path);
      await Deno.remove(path, { recursive: stat.isDirectory });
    },
    readDirEntries: async (path: string) => {
      const entries: Deno.DirEntry[] = [];
      for await (const entry of Deno.readDir(path)) {
        entries.push(entry);
      }
      return entries;
    },
    removeDir: (path: string) => Deno.remove(path),
    lockfileRepository,
    repoDir,
  };
}
