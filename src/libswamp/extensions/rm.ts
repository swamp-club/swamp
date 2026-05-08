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
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import type { UpstreamExtensionsMap } from "../../infrastructure/persistence/upstream_extensions.ts";
import { parseExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import { UserError } from "../../domain/errors.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound } from "../errors.ts";
import { RemoveExtensionService } from "./remove_extension_service.ts";

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
  /**
   * Lockfile repository owning read+write of upstream_extensions.json.
   * Captures a snapshot at construction (per its own JSDoc); construct
   * fresh deps per rm operation via {@link createExtensionRmDeps}.
   */
  lockfileRepository: LockfileRepository;
  /**
   * W2 extension repository — owns the catalog write surface.
   * `extensionRm` routes through {@link RemoveExtensionService} so the
   * catalog tombstone-save fires FIRST in the inverted ordering
   * (catalog → lockfile → filesystem). Closes swamp-club#201:
   * `extension rm` now prunes catalog rows.
   */
  repository: ExtensionRepository;
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

/**
 * Removes an extension and its tracked files. **Closes
 * swamp-club#201** — routes through {@link RemoveExtensionService} so
 * the catalog tombstone-save fires FIRST (inverted ordering vs.
 * install). The async generator surface and event shape are
 * preserved so renderers and the CLI two-phase prompt flow stay
 * unchanged.
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

      // Confirm the extension is installed before constructing the
      // service. The service itself throws UserError on a no-op rm,
      // but the existing rm event shape uses notFound() for the
      // "not installed" case so renderers don't see a behaviour
      // change vs. pre-W2.
      const entry = deps.lockfileRepository.getEntry(input.extensionName);
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
        .debug`Removed ${input.extensionName} (v${result.version}); ${result.filesDeleted} file(s) deleted, ${result.filesSkipped} skipped, ${result.dirsRemoved} dir(s) pruned`;
      yield {
        kind: "completed",
        data: {
          name: result.name,
          version: result.version,
          filesDeleted: result.filesDeleted,
          filesSkipped: result.filesSkipped,
          dirsRemoved: result.dirsRemoved,
        },
      };
    })(),
  );
}

/**
 * Wires real infrastructure into ExtensionRmDeps. Constructs a fresh
 * {@link LockfileRepository} that captures a snapshot at this moment
 * AND a fresh {@link ExtensionRepository} so the rm flow routes
 * through {@link RemoveExtensionService} and prunes catalog rows
 * (closes swamp-club#201). The returned deps object owns the catalog
 * handle — caller is responsible for calling
 * `deps.repository.close()` after the rm operation
 * completes.
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
  });
  return {
    findDependents,
    lockfileRepository,
    repository,
    repoDir,
  };
}
