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
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { resolveMountedSourceDirs } from "../../infrastructure/persistence/swamp_sources_repository.ts";
import type { UpstreamExtensionsMap } from "../../infrastructure/persistence/upstream_extensions.ts";
import { parseExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import { UserError } from "../../domain/errors.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound } from "../errors.ts";
import {
  type FailedFile,
  RemoveExtensionService,
  type RetainedFile,
} from "./remove_extension_service.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { refreshManagedLockfile } from "./managed_lockfile_transaction.ts";

export interface ExtensionRmPreview {
  name: string;
  version: string;
  fileCount: number;
  dependents: string[];
}

export interface ExtensionRmData {
  name: string;
  version: string;
  filesDeleted: number;
  filesSkipped: number;
  dirsRemoved: number;
  /**
   * optional because a thin client may talk to an older server that does not
   * send it.
   */
  failedFiles?: FailedFile[];
  /**
   * optional because a thin client may talk to an older server that does not
   * send it.
   */
  retainedFiles?: RetainedFile[];
}

export type ExtensionRmEvent =
  | { kind: "deleting" }
  | { kind: "completed"; data: ExtensionRmData }
  | { kind: "error"; error: SwampError };

export interface ExtensionRmInput {
  extensionName: string;
}

export interface ExtensionRmDeps {
  findDependents: (
    repoDir: string,
    upstreamData: UpstreamExtensionsMap,
    targetName: string,
  ) => Promise<string[]>;
  /** captures a snapshot at construction; construct fresh deps per rm operation. */
  lockfileRepository: LockfileRepository;
  /**
   * extensionRm routes through RemoveExtensionService so the catalog
   * tombstone-save fires first (catalog, lockfile, filesystem).
   */
  repository: ExtensionRepository;
  repoDir: string;
}

export async function findDependents(
  repoDir: string,
  upstreamData: UpstreamExtensionsMap,
  targetName: string,
): Promise<string[]> {
  const dependents: string[] = [];

  for (const [extName, entry] of Object.entries(upstreamData)) {
    if (extName === targetName) continue;
    if (!entry.files) continue;

    // Match the extension's own manifest by its per-extension path. A
    // skill merged file by file can ship its own manifest.yaml, and
    // .claude/... paths sort before .swamp/... ones.
    const manifestSuffix = `/${extName}/manifest.yaml`;
    const manifestFile = entry.files.find((f) =>
      f.replaceAll("\\", "/").endsWith(manifestSuffix)
    );
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

export async function extensionRmPreview(
  ctx: LibSwampContext,
  deps: ExtensionRmDeps,
  input: ExtensionRmInput,
): Promise<ExtensionRmPreview> {
  ctx.logger.debug`Looking up extension: ${input.extensionName}`;

  // preview what the datastore's lockfile holds, not a stale cache: an
  // extension another checkout installed is removable.
  await refreshManagedLockfile(deps.lockfileRepository);
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

/**
 * routes through RemoveExtensionService; the generator surface and event shape
 * are preserved so renderers and the CLI two-phase prompt are unchanged.
 */
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

      // confirm installed before constructing the service: the rm event shape
      // reports not installed with notFound(), while the service itself throws.
      let entry = deps.lockfileRepository.getEntry(input.extensionName);
      if (!entry) {
        // serve removes without a preview: an extension another checkout
        // installed is only in the datastore's lockfile.
        await refreshManagedLockfile(deps.lockfileRepository);
        entry = deps.lockfileRepository.getEntry(input.extensionName);
      }
      if (!entry || !entry.files) {
        yield {
          kind: "error",
          error: notFound("Extension", input.extensionName),
        };
        return;
      }

      const service = new RemoveExtensionService({
        repository: deps.repository,
        lockfileRepository: deps.lockfileRepository,
        repoDir: deps.repoDir,
      });

      const result = await service.execute(input.extensionName);
      ctx.logger
        .debug`Removed ${input.extensionName} (v${result.version}); ${result.filesDeleted} file(s) deleted, ${result.filesSkipped} skipped, ${result.failedFiles.length} failed, ${result.retainedFiles.length} retained, ${result.dirsRemoved} dir(s) pruned`;
      yield {
        kind: "completed",
        data: {
          name: result.name,
          version: result.version,
          filesDeleted: result.filesDeleted,
          filesSkipped: result.filesSkipped,
          dirsRemoved: result.dirsRemoved,
          failedFiles: result.failedFiles,
          retainedFiles: result.retainedFiles,
        },
      };
    })(),
  );
}

/**
 * constructs a fresh lockfile snapshot and a fresh ExtensionRepository; the
 * caller must call deps.repository.close() after the rm operation completes.
 */
export async function createExtensionRmDeps(
  repoDir: string,
  lockfilePath: string,
): Promise<ExtensionRmDeps> {
  const lockfileRepository = await LockfileRepository.create(lockfilePath);
  const catalog = new ExtensionCatalogStore(
    swampPath(repoDir, "_extension_catalog.db"),
  );
  const repository = new ExtensionRepository({
    catalog,
    lockfileRepository,
    repoRoot: repoDir,
    mountedSourceDirs: await resolveMountedSourceDirs(repoDir),
  });
  return {
    findDependents,
    lockfileRepository,
    repository,
    repoDir,
  };
}
