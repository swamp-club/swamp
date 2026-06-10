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
import { DEFAULT_DATASTORE_SUBDIRS } from "../../domain/datastore/datastore_config.ts";
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

export const INFRASTRUCTURE_FILES = new Set([
  "_catalog.db",
  "_catalog.db-journal",
  "_catalog.db-wal",
]);

const MERGEABLE_ON_REVERSE = new Set([
  "bundles",
  "vault-bundles",
  "driver-bundles",
  "report-bundles",
]);

export interface NamespaceMigrateDeps {
  getDatastorePath: () => string;
  getNamespace: () => string | undefined;
  dirExists: (path: string) => Promise<boolean>;
  dirHasDataFiles: (path: string) => Promise<boolean>;
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
  ensureDir: (path: string) => Promise<void>;
  invalidateCatalog: () => void;
  markDirtyBulk: () => Promise<void>;
  removeNamespaceManifest: (namespace: string) => Promise<void>;
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

      const datastorePath = deps.getDatastorePath();
      const directories: SubdirPreview[] = [];
      const allCollisions: Array<{ subdir: string; paths: string[] }> = [];

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
            allCollisions.push({ subdir, paths: collidingPaths });
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
        const hint = input.reverse
          ? " If data was pushed to a remote datastore, run 'swamp datastore sync --pull' first to populate the local cache."
          : "";
        yield {
          kind: "error",
          error: validationFailed(
            `No data directories found to migrate.${hint}`,
          ),
          succeededDirectories: [],
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

      for (const dir of directories) {
        try {
          await deps.ensureDir(dirname(dir.destination));
          if (await deps.dirExists(dir.destination)) {
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
