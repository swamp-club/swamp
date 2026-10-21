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

import { dirname, join } from "@std/path";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";
import {
  CATALOG_FILE_NAMES,
  DEFAULT_DATASTORE_SUBDIRS,
} from "../../domain/datastore/datastore_config.ts";
import {
  namespaceCollidesWithLayout,
  namespaceNameClash,
} from "../../domain/data/namespace.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface SubdirPreview {
  subdir: string;
  source: string;
  destination: string;
  fileCount: number;
  totalBytes: number;
}

export interface NamespaceMigratePreviewData {
  namespace: string;
  datastorePath: string;
  reverse: boolean;
  confirm: boolean;
  directories: SubdirPreview[];
  totalFiles: number;
  totalBytes: number;
  isExtensionDatastore: boolean;
}

export interface NamespaceMigrateProgressData {
  subdir: string;
  source: string;
  destination: string;
}

export interface NamespaceMigrateWarningData {
  subdir: string;
  source: string;
  destination: string;
  skippedPaths: string[];
}

export interface NamespaceMigrateCompletedData {
  namespace: string;
  datastorePath: string;
  reverse: boolean;
  migratedDirectories: string[];
  totalFiles: number;
  totalBytes: number;
  isExtensionDatastore: boolean;
}

export type NamespaceMigrateEvent =
  | { kind: "preview"; data: NamespaceMigratePreviewData }
  | { kind: "progress"; data: NamespaceMigrateProgressData }
  | { kind: "warning"; data: NamespaceMigrateWarningData }
  | { kind: "completed"; data: NamespaceMigrateCompletedData }
  | {
    kind: "error";
    error: SwampError;
    succeededDirectories: string[];
    failedDirectory?: string;
  };

export interface NamespaceMigrateInput {
  confirm: boolean;
  reverse: boolean;
}

export interface DirSize {
  fileCount: number;
  totalBytes: number;
}

export interface MergeDirResult {
  moved: number;
  skipped: number;
  skippedPaths: string[];
}

/** What a directory holds at its top level. */
export interface DirContents {
  /** Catalog database files, which are repo-local and never migrated. */
  catalogFiles: number;
  otherEntries: number;
}

/**
 * The catalog and its SQLite sidecars. The catalog is repo-local at the
 * un-namespaced `data` path whatever the namespace, so migration never
 * moves, compares or counts these as data (swamp-club#3316).
 */
export const INFRASTRUCTURE_FILES: ReadonlySet<string> = new Set(
  CATALOG_FILE_NAMES,
);

const MERGEABLE_ON_REVERSE = new Set([
  "bundles",
  "vault-bundles",
  "report-bundles",
]);

/**
 * Explains why a namespace named after a datastore layout directory cannot be
 * migrated or repaired automatically: `{base}/{namespace}` and the solo
 * layout's `{base}/{subdir}` are the same directory.
 */
export function layoutCollisionMessage(namespace: string): string {
  return `${namespaceNameClash(namespace)}, so its data cannot be told ` +
    `apart from un-namespaced data and ` +
    `cannot be moved automatically.\n\n` +
    `To move it to another name by hand:\n` +
    `  1. swamp datastore namespace set <new-name>\n` +
    `  2. Move the layout directories (data, outputs, ...) inside ` +
    `<datastore>/${namespace}/ into <datastore>/<new-name>/. Leave ` +
    `anything else where it is: it is un-namespaced data\n` +
    `  3. Delete <datastore>/${namespace}/.namespace.json\n` +
    `  4. If un-namespaced data remains at the datastore root, run ` +
    `'swamp datastore namespace migrate --confirm'\n` +
    `  5. swamp doctor datastores`;
}

export interface NamespaceMigrateDeps {
  getDatastorePath: () => string;
  getNamespace: () => string | undefined;
  /** The repo's configured datastore-tier directories. */
  getDatastoreDirectories: () => readonly string[];
  dirExists: (path: string) => Promise<boolean>;
  dirHasDataFiles: (path: string) => Promise<boolean>;
  dirContents: (path: string) => Promise<DirContents>;
  dirSize: (path: string) => Promise<DirSize>;
  renameDir: (source: string, destination: string) => Promise<void>;
  mergeDirInto: (
    source: string,
    destination: string,
  ) => Promise<MergeDirResult>;
  findFileCollisions: (
    source: string,
    destination: string,
  ) => Promise<string[]>;
  compareFiles: (a: string, b: string) => Promise<boolean>;
  removeFile: (path: string) => Promise<void>;
  ensureDir: (path: string) => Promise<void>;
  /**
   * Deletes stale catalog copies an earlier migration moved into a
   * namespace `data` directory, and the directory if that empties it.
   * Returns the number of files deleted. Must never touch the live catalog.
   */
  removeOrphanedCatalogFiles: (namespaceDataDir: string) => Promise<number>;
  invalidateCatalog: () => void;
  markDirtyBulk: () => Promise<void>;
  removeNamespaceManifest: (namespace: string) => Promise<void>;
  listLocalNamespaces: () => Promise<string[]>;
  isExtensionDatastore: boolean;
}

export async function* datastoreNamespaceMigrate(
  ctx: LibSwampContext,
  deps: NamespaceMigrateDeps,
  input: NamespaceMigrateInput,
): AsyncIterable<NamespaceMigrateEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.namespace.migrate",
    { "namespace.reverse": input.reverse },
    (async function* () {
      const namespace = deps.getNamespace();
      if (!namespace) {
        yield {
          kind: "error",
          error: validationFailed(
            "No namespace is configured. Run 'swamp datastore namespace set <slug>' first.",
          ),
          succeededDirectories: [],
        };
        return;
      }

      if (
        namespaceCollidesWithLayout(namespace, deps.getDatastoreDirectories())
      ) {
        yield {
          kind: "error",
          error: validationFailed(layoutCollisionMessage(namespace)),
          succeededDirectories: [],
        };
        return;
      }

      const datastorePath = deps.getDatastorePath();

      if (!input.reverse) {
        const localNamespaces = await deps.listLocalNamespaces();
        const foreign = localNamespaces.filter((ns) => ns !== namespace);
        if (foreign.length > 0) {
          yield {
            kind: "error",
            error: validationFailed(
              `Local cache contains data from other namespaces: ${
                foreign.join(", ")
              }.\n` +
                `These were absorbed during an unscoped setup. They must not be migrated ` +
                `under your namespace.\n\n` +
                `To clean up:\n` +
                `  swamp datastore sync --pull    # re-sync from remote (scoped to your namespace)`,
            ),
            succeededDirectories: [],
          };
          return;
        }
      }

      const removeOrphanedCatalog = async (): Promise<void> => {
        try {
          const removed = await deps.removeOrphanedCatalogFiles(
            join(datastorePath, namespace, "data"),
          );
          if (removed > 0) {
            ctx.logger
              .info`Removed ${removed} stale catalog file(s) from the namespace data directory`;
          }
        } catch (err) {
          ctx.logger.warn`Failed to remove stale catalog files: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      };

      const directories: SubdirPreview[] = [];
      const sourcesHoldingCatalog = new Set<string>();
      const allCollisions: Array<{ subdir: string; paths: string[] }> = [];
      const identicalCollisions: Array<{
        subdir: string;
        source: string;
        destination: string;
        paths: string[];
      }> = [];

      for (const subdir of DEFAULT_DATASTORE_SUBDIRS) {
        const source = input.reverse
          ? join(datastorePath, namespace, subdir)
          : join(datastorePath, subdir);
        const destination = input.reverse
          ? join(datastorePath, subdir)
          : join(datastorePath, namespace, subdir);

        if (!(await deps.dirExists(source))) {
          ctx.logger.debug`Skipping ${subdir}: source does not exist`;
          continue;
        }

        const contents = await deps.dirContents(source);
        if (contents.catalogFiles > 0) {
          if (contents.otherEntries === 0) {
            ctx.logger.debug`Skipping ${subdir}: source holds only the catalog`;
            continue;
          }
          sourcesHoldingCatalog.add(subdir);
        }

        if (
          input.reverse && !MERGEABLE_ON_REVERSE.has(subdir) &&
          await deps.dirHasDataFiles(destination)
        ) {
          yield {
            kind: "error",
            error: validationFailed(
              `Cannot reverse-migrate: "${subdir}" already exists at ` +
                `"${destination}". Remove or rename it first.`,
            ),
            succeededDirectories: [],
          };
          return;
        }

        if (!input.reverse && await deps.dirExists(destination)) {
          const collidingPaths = await deps.findFileCollisions(
            source,
            destination,
          );
          if (collidingPaths.length > 0) {
            const nonIdentical: string[] = [];
            for (const relPath of collidingPaths) {
              const srcFile = join(source, ...relPath.split("/"));
              const dstFile = join(destination, ...relPath.split("/"));
              if (!await deps.compareFiles(srcFile, dstFile)) {
                nonIdentical.push(relPath);
              }
            }
            if (nonIdentical.length > 0) {
              allCollisions.push({ subdir, paths: nonIdentical });
            } else {
              identicalCollisions.push({
                subdir,
                source,
                destination,
                paths: collidingPaths,
              });
            }
          }
        }

        const size = await deps.dirSize(source);
        directories.push({
          subdir,
          source,
          destination,
          fileCount: size.fileCount,
          totalBytes: size.totalBytes,
        });
      }

      if (allCollisions.length > 0) {
        const totalCollisions = allCollisions.reduce(
          (sum, c) => sum + c.paths.length,
          0,
        );
        const listing = allCollisions
          .flatMap((c) => c.paths.map((p) => `  ${c.subdir}/${p}`))
          .join("\n");
        yield {
          kind: "error",
          error: validationFailed(
            `Cannot migrate: ${totalCollisions} file(s) already exist at the ` +
              `destination and would be lost during merge. Remove or rename ` +
              `the conflicting files first:\n${listing}`,
          ),
          succeededDirectories: [],
        };
        return;
      }

      if (directories.length === 0) {
        if (input.confirm) await removeOrphanedCatalog();
        yield {
          kind: "preview",
          data: {
            namespace,
            datastorePath,
            reverse: input.reverse,
            confirm: input.confirm,
            directories: [],
            totalFiles: 0,
            totalBytes: 0,
            isExtensionDatastore: deps.isExtensionDatastore,
          },
        };
        yield {
          kind: "completed",
          data: {
            namespace,
            datastorePath,
            reverse: input.reverse,
            migratedDirectories: [],
            totalFiles: 0,
            totalBytes: 0,
            isExtensionDatastore: deps.isExtensionDatastore,
          },
        };
        return;
      }

      const totalFiles = directories.reduce(
        (sum, d) => sum + d.fileCount,
        0,
      );
      const totalBytes = directories.reduce(
        (sum, d) => sum + d.totalBytes,
        0,
      );

      yield {
        kind: "preview",
        data: {
          namespace,
          datastorePath,
          reverse: input.reverse,
          confirm: input.confirm,
          directories,
          totalFiles,
          totalBytes,
          isExtensionDatastore: deps.isExtensionDatastore,
        },
      };

      if (!input.confirm) {
        yield {
          kind: "completed",
          data: {
            namespace,
            datastorePath,
            reverse: input.reverse,
            migratedDirectories: [],
            totalFiles: 0,
            totalBytes: 0,
            isExtensionDatastore: deps.isExtensionDatastore,
          },
        };
        return;
      }

      const succeeded: string[] = [];

      for (const ic of identicalCollisions) {
        for (const relPath of ic.paths) {
          const srcFile = join(ic.source, ...relPath.split("/"));
          await deps.removeFile(srcFile);
        }
        ctx.logger
          .info`Removed ${ic.paths.length} identical duplicate(s) from ${ic.subdir}/`;
      }

      for (const dir of directories) {
        try {
          await deps.ensureDir(dirname(dir.destination));
          // A source holding the catalog is merged, never renamed whole, so
          // the catalog stays where it is.
          const leaveCatalog = sourcesHoldingCatalog.has(dir.subdir);
          if (leaveCatalog) await deps.ensureDir(dir.destination);
          if (leaveCatalog || await deps.dirExists(dir.destination)) {
            const result = await deps.mergeDirInto(
              dir.source,
              dir.destination,
            );
            if (result.skipped > 0) {
              yield {
                kind: "warning",
                data: {
                  subdir: dir.subdir,
                  source: dir.source,
                  destination: dir.destination,
                  skippedPaths: result.skippedPaths,
                },
              };
            }
          } else {
            await deps.renameDir(dir.source, dir.destination);
          }
          succeeded.push(dir.subdir);

          yield {
            kind: "progress",
            data: {
              subdir: dir.subdir,
              source: dir.source,
              destination: dir.destination,
            },
          };

          ctx.logger
            .info`Migrated ${dir.subdir}: ${dir.source} → ${dir.destination}`;
        } catch (err) {
          if (succeeded.length > 0) {
            deps.invalidateCatalog();
          }
          yield {
            kind: "error",
            error: validationFailed(
              `Failed to migrate "${dir.subdir}": ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
            succeededDirectories: succeeded,
            failedDirectory: dir.subdir,
          };
          return;
        }
      }

      await removeOrphanedCatalog();

      deps.invalidateCatalog();
      ctx.logger.info("Catalog invalidated — will rebuild on next access");

      if (deps.isExtensionDatastore) {
        await deps.markDirtyBulk();
        ctx.logger.info(
          "Extension datastore marked dirty — run 'swamp datastore sync --push' to sync",
        );
      }

      if (input.reverse) {
        try {
          await deps.removeNamespaceManifest(namespace);
          ctx.logger.info`Removed namespace manifest for ${namespace}`;
        } catch (err) {
          ctx.logger.warn`Failed to remove namespace manifest: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }

      yield {
        kind: "completed",
        data: {
          namespace,
          datastorePath,
          reverse: input.reverse,
          migratedDirectories: succeeded,
          totalFiles,
          totalBytes,
          isExtensionDatastore: deps.isExtensionDatastore,
        },
      };
    })(),
  );
}
