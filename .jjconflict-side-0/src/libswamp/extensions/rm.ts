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
import { readUpstreamExtensions } from "../../infrastructure/persistence/upstream_extensions.ts";
import { parseExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import { atomicWriteTextFile } from "../../infrastructure/persistence/atomic_write.ts";
import { UserError } from "../../domain/errors.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
const LOCK_RETRY_COUNT = 10;
const LOCK_RETRY_DELAY_MS = 100;

/** Upstream extension entry for rm operations. */
export interface UpstreamEntry {
  version: string;
  pulledAt: string;
  files?: string[];
}

/** Map of extension name to upstream entry. */
export type UpstreamMap = Record<string, UpstreamEntry>;

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
  readUpstreamExtensions: (modelsDir: string) => Promise<UpstreamMap>;
  findDependents: (
    repoDir: string,
    upstreamData: UpstreamMap,
    targetName: string,
  ) => Promise<string[]>;
  removeFile: (path: string) => Promise<void>;
  readDirEntries: (path: string) => Promise<Deno.DirEntry[]>;
  removeDir: (path: string) => Promise<void>;
  removeUpstreamExtension: (modelsDir: string, name: string) => Promise<void>;
  modelsDir: string;
  repoDir: string;
}

/**
 * Finds installed extensions that depend on the given extension name
 * by scanning manifest.yaml files tracked in upstream_extensions.json.
 */
export async function findDependents(
  repoDir: string,
  upstreamData: UpstreamMap,
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

/**
 * Acquires an advisory lockfile. Retries with short backoff.
 * Returns a cleanup function to release the lock.
 */
async function acquireLock(lockPath: string): Promise<Deno.FsFile> {
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      const file = await Deno.open(lockPath, {
        create: true,
        createNew: true,
        write: true,
      });
      return file;
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        if (attempt < LOCK_RETRY_COUNT - 1) {
          await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
          continue;
        }
        throw new Error(
          "Could not acquire lock on upstream_extensions.json. Another operation may be in progress.",
        );
      }
      throw error;
    }
  }
  throw new Error("Could not acquire lock on upstream_extensions.json.");
}

/**
 * Removes an extension entry from upstream_extensions.json, using a lockfile
 * for concurrency safety and atomicWriteTextFile for crash safety.
 */
export async function removeUpstreamExtension(
  modelsDir: string,
  name: string,
): Promise<void> {
  const jsonPath = join(modelsDir, "upstream_extensions.json");
  const lockPath = `${jsonPath}.lock`;

  const lockFile = await acquireLock(lockPath);
  try {
    let data: UpstreamMap = {};
    try {
      const content = await Deno.readTextFile(jsonPath);
      data = JSON.parse(content) as UpstreamMap;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    delete data[name];

    await atomicWriteTextFile(jsonPath, JSON.stringify(data, null, 2) + "\n");
  } finally {
    lockFile.close();
    try {
      await Deno.remove(lockPath);
    } catch {
      // Best-effort cleanup
    }
  }
}

/** Gathers preview info for the extension rm operation. */
export async function extensionRmPreview(
  ctx: LibSwampContext,
  deps: ExtensionRmDeps,
  input: ExtensionRmInput,
): Promise<ExtensionRmPreview> {
  ctx.logger.debug`Looking up extension: ${input.extensionName}`;

  const upstreamData = await deps.readUpstreamExtensions(deps.modelsDir);
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

      const upstreamData = await deps.readUpstreamExtensions(deps.modelsDir);
      const entry = upstreamData[input.extensionName];

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

      await deps.removeUpstreamExtension(deps.modelsDir, input.extensionName);

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

/** Wires real infrastructure into ExtensionRmDeps. */
export function createExtensionRmDeps(
  repoDir: string,
  modelsDir: string,
): ExtensionRmDeps {
  return {
    readUpstreamExtensions,
    findDependents,
    removeFile: (path: string) => Deno.remove(path),
    readDirEntries: async (path: string) => {
      const entries: Deno.DirEntry[] = [];
      for await (const entry of Deno.readDir(path)) {
        entries.push(entry);
      }
      return entries;
    },
    removeDir: (path: string) => Deno.remove(path),
    removeUpstreamExtension,
    modelsDir,
    repoDir,
  };
}
