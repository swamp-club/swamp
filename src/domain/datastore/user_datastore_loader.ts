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

import { z } from "zod";
import { dirname, join, resolve, toFileUrl } from "@std/path";
import { getLogger } from "@logtape/logtape";
import {
  bundleExtension,
  fixCjsEsmInterop,
  installZodGlobal,
  isExpectedBundleFailure,
  rewriteZodImports,
  sanitizeDataUrlError,
  uint8ArrayToBase64,
} from "../models/bundle.ts";
import { resolveLocalImports } from "../models/local_import_resolver.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import type { DatastoreProvider } from "./datastore_provider.ts";
import { datastoreTypeRegistry } from "./datastore_type_registry.ts";
import {
  bundleNamespace,
  SWAMP_DATA_DIR,
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";
import { assertSafePath } from "../../infrastructure/persistence/safe_path.ts";
import {
  type ExtensionCatalogStore,
  type ExtensionTypeRow,
  sourceDirsFingerprint,
} from "../../infrastructure/persistence/extension_catalog_store.ts";

const logger = getLogger(["swamp", "datastores", "loader"]);

/** Pattern for valid user datastore type: @collective/name or collective/name */
const USER_DATASTORE_TYPE_PATTERN = /^@?[a-z0-9_-]+\/[a-z0-9_-]+$/;

/**
 * Schema for validating user datastore exports.
 */
const UserDatastoreSchema = z.object({
  type: z.string().refine(
    (t) => USER_DATASTORE_TYPE_PATTERN.test(t),
    {
      message:
        "Datastore type must match @collective/name or collective/name (e.g., @myorg/custom-store or myorg/custom-store)",
    },
  ),
  name: z.string(),
  description: z.string(),
  configSchema: z.custom<z.ZodTypeAny>((val) => val instanceof z.ZodType)
    .optional(),
  createProvider: z.custom<
    (config: Record<string, unknown>) => DatastoreProvider
  >((val) => typeof val === "function"),
});

/**
 * Result of loading user datastore extensions from a directory.
 */
export interface DatastoreLoadResult {
  loaded: string[];
  failed: Array<{ file: string; error: string }>;
}

/**
 * Loader for user-defined TypeScript datastore implementations.
 *
 * Users export a `datastore` object from TypeScript files that defines:
 * - type: namespaced identifier (e.g., "@myorg/custom-store")
 * - name: human-readable name
 * - description: datastore type description
 * - configSchema: optional Zod schema for config validation
 * - createProvider: factory function returning a DatastoreProvider
 *
 * This loader validates the structure and registers datastore types with the global registry.
 */
export class UserDatastoreLoader {
  private readonly denoRuntime: DenoRuntime;
  private readonly repoDir: string | null;

  /**
   * @param denoRuntime - Runtime manager for obtaining a deno binary path
   * @param repoDir - Repository root for writing bundles to .swamp/datastore-bundles/
   *                   (pass null to skip bundle caching)
   */
  constructor(denoRuntime: DenoRuntime, repoDir: string | null = null) {
    this.denoRuntime = denoRuntime;
    this.repoDir = repoDir;
  }

  /**
   * Loads all user datastore implementations from the specified directory.
   *
   * @param datastoresDir - The directory containing user datastore files
   * @returns Result containing lists of loaded and failed files
   */
  async loadDatastores(
    datastoresDir: string,
    options?: {
      skipAlreadyRegistered?: boolean;
      /** Additional directories to scan (e.g. pulled extensions). */
      additionalDirs?: string[];
    },
  ): Promise<DatastoreLoadResult> {
    const result: DatastoreLoadResult = { loaded: [], failed: [] };

    // Ensure swamp's Zod is available on globalThis before importing bundles.
    installZodGlobal();

    // Ensure deno is available before bundling
    const denoPath = await this.denoRuntime.ensureDeno();

    // Discover files from primary dir and any additional dirs
    const allFiles: Array<{ file: string; baseDir: string }> = [];
    for (
      const dir of [datastoresDir, ...(options?.additionalDirs ?? [])]
    ) {
      try {
        await Deno.stat(dir);
      } catch {
        continue;
      }
      const files = await this.discoverFiles(dir);
      for (const file of files) {
        allFiles.push({ file, baseDir: dir });
      }
    }

    for (const { file, baseDir } of allFiles) {
      try {
        const absolutePath = resolve(baseDir, file);

        // Pre-check: only bundle files that declare a datastore export.
        const source = await Deno.readTextFile(absolutePath);
        if (!/export\s+const\s+datastore\s*[=:]/.test(source)) {
          logger.debug`Skipping ${file} (no datastore export found)`;
          continue;
        }

        const js = await this.bundleWithCache(
          absolutePath,
          file,
          denoPath,
          baseDir,
        );
        const module = await this.importBundle(js, file, baseDir);

        if (!module.datastore) {
          // Files without a datastore export are silently skipped (utility files)
          continue;
        }

        const parsed = UserDatastoreSchema.safeParse(module.datastore);
        if (!parsed.success) {
          result.failed.push({
            file,
            error: this.formatValidationError(parsed.error),
          });
          continue;
        }

        const userDatastore = parsed.data;

        // Register with the datastore type registry
        if (datastoreTypeRegistry.has(userDatastore.type)) {
          if (options?.skipAlreadyRegistered) {
            continue;
          }
          result.failed.push({
            file,
            error:
              `Datastore type '${userDatastore.type}' is already registered`,
          });
          continue;
        }

        datastoreTypeRegistry.register({
          type: userDatastore.type,
          name: userDatastore.name,
          description: userDatastore.description,
          configSchema: userDatastore.configSchema,
          createProvider: userDatastore.createProvider,
          isBuiltIn: false,
        });

        result.loaded.push(file);
      } catch (error) {
        result.failed.push({ file, error: String(error) });
      }
    }

    return result;
  }

  /**
   * Bundles a datastore file, using cached bundle from .swamp/datastore-bundles/ when possible.
   */
  private async bundleWithCache(
    absolutePath: string,
    relativePath: string,
    denoPath: string,
    boundaryDir: string,
  ): Promise<string> {
    if (this.repoDir) {
      const bundlePath = join(
        this.repoDir,
        SWAMP_DATA_DIR,
        SWAMP_SUBDIRS.datastoreBundles,
        bundleNamespace(boundaryDir, this.repoDir),
        relativePath.replace(/\.ts$/, ".js"),
      );

      // Check mtime-based cache against all local dependencies.
      // If the bundle exists but freshness cannot be determined (e.g. a
      // dependency file is missing because the extension was pushed with an
      // older swamp that had a single-line import regex), fall back to the
      // cached bundle rather than attempting a re-bundle that will also fail.
      let bundleExists = false;
      try {
        const bundleStat = await Deno.stat(bundlePath);
        bundleExists = true;
        if (bundleStat.mtime) {
          const { resolvedFiles } = await resolveLocalImports(
            [absolutePath],
            boundaryDir,
          );
          const depStats = await Promise.all(
            resolvedFiles.map((f) => Deno.stat(f)),
          );
          const newestSourceMtime = depStats.reduce<Date | null>(
            (max, s) => {
              if (!s.mtime) return max;
              if (!max) return s.mtime;
              return s.mtime > max ? s.mtime : max;
            },
            null,
          );
          if (newestSourceMtime && bundleStat.mtime > newestSourceMtime) {
            logger.debug`Using cached datastore bundle for ${relativePath}`;
            return await Deno.readTextFile(bundlePath);
          }
        }
      } catch {
        // Freshness check failed (e.g. missing dependency file).
        // Fall through to attempt a rebundle rather than using a
        // potentially stale cache.
      }

      // Try to rebundle from source. If bundling fails (e.g. bare specifiers
      // without a deno.json import map) and a cached bundle exists, fall back
      // to the cache. The old bundle file is untouched on failure since
      // bundleExtension returns the JS string in memory before we write.
      try {
        const js = await bundleExtension(absolutePath, denoPath);
        const bundleBoundary = join(this.repoDir, SWAMP_DATA_DIR);
        await assertSafePath(bundlePath, bundleBoundary);
        await Deno.mkdir(dirname(bundlePath), { recursive: true });
        await Deno.writeTextFile(bundlePath, js);
        logger.debug`Wrote datastore bundle cache: ${bundlePath}`;
        return js;
      } catch (bundleError) {
        if (bundleExists) {
          try {
            const cached = await Deno.readTextFile(bundlePath);
            const msg = bundleError instanceof Error
              ? bundleError.message
              : String(bundleError);
            const expected = isExpectedBundleFailure(
              absolutePath,
              this.repoDir ?? undefined,
            );
            if (expected) {
              logger
                .debug`Rebundle failed for ${relativePath}, using cached bundle: ${msg}`;
              // Touch the cache mtime so subsequent loads see it as fresh,
              // avoiding repeated failed rebundle attempts on every cold
              // start. Only for expected failures (pulled extensions without
              // project config) where retrying would always fail.
              try {
                const now = new Date();
                await Deno.utime(bundlePath, now, now);
              } catch { /* ignore — worst case we retry next load */ }
            } else {
              logger
                .warn`Rebundle failed for ${relativePath}, using cached bundle: ${msg}`;
            }
            return cached;
          } catch {
            // Cache file was removed between stat and read — treat as no cache.
          }
        }
        throw bundleError;
      }
    }

    // No repo dir — just bundle without caching
    return await bundleExtension(absolutePath, denoPath);
  }

  /**
   * Imports bundled JavaScript and returns the module exports.
   * Uses file URL import when a bundle file exists on disk, otherwise falls back to data URL.
   */
  private async importBundle(
    js: string,
    relativePath: string,
    baseDir?: string,
  ): Promise<Record<string, unknown>> {
    const rewritten = fixCjsEsmInterop(rewriteZodImports(js));

    if (this.repoDir) {
      const ns = baseDir ? bundleNamespace(baseDir, this.repoDir) : "";
      const bundlePath = ns
        ? join(
          this.repoDir,
          SWAMP_DATA_DIR,
          SWAMP_SUBDIRS.datastoreBundles,
          ns,
          relativePath.replace(/\.ts$/, ".js"),
        )
        : join(
          this.repoDir,
          SWAMP_DATA_DIR,
          SWAMP_SUBDIRS.datastoreBundles,
          relativePath.replace(/\.ts$/, ".js"),
        );

      try {
        await Deno.stat(bundlePath);
        let cachedJs = await Deno.readTextFile(bundlePath);
        const fixed = fixCjsEsmInterop(rewriteZodImports(cachedJs));
        if (fixed !== cachedJs) {
          cachedJs = fixed;
          await Deno.writeTextFile(bundlePath, cachedJs);
        }
        return await import(toFileUrl(bundlePath).href);
      } catch (error) {
        logger.debug`File URL import failed for ${relativePath}: ${
          String(error).substring(0, 200)
        }`;
      }
    }

    // Fallback: import via base64 data URL (no file on disk)
    try {
      const encoded = uint8ArrayToBase64(
        new TextEncoder().encode(rewritten),
      );
      return await import(
        `data:application/javascript;base64,${encoded}`
      );
    } catch (error) {
      throw new Error(sanitizeDataUrlError(error));
    }
  }

  /**
   * Formats a Zod validation error into a clear message.
   */
  private formatValidationError(error: z.ZodError): string {
    return error.issues
      .map((i) => {
        const path = i.path.join(".");
        return `${path}: ${i.message}`;
      })
      .join("; ");
  }

  /**
   * Builds the catalog index for datastore types without importing bundles.
   * On first run, does a full import to bootstrap the catalog.
   * On subsequent runs, checks mtimes and only rebundles stale files.
   * Registers lazy entries for all datastore types in the catalog.
   */
  async buildIndex(
    datastoresDir: string,
    catalog: ExtensionCatalogStore,
    options?: { additionalDirs?: string[] },
  ): Promise<DatastoreLoadResult> {
    const result: DatastoreLoadResult = { loaded: [], failed: [] };

    installZodGlobal();
    const denoPath = await this.denoRuntime.ensureDeno();

    // Force a full rescan if the set of extension source directories has
    // changed (e.g. user ran `swamp extension source add`). Without this,
    // the catalog's "populated" flag causes buildIndex to skip the full
    // import path, so datastores from newly added sources are never
    // discovered (#1107).
    const currentSourceFingerprint = sourceDirsFingerprint(
      datastoresDir,
      options?.additionalDirs,
    );
    if (
      catalog.isPopulated("datastore") &&
      catalog.getSourceDirsFingerprint("datastore") !==
        currentSourceFingerprint
    ) {
      logger
        .warn`Extension source dirs changed — invalidating datastore catalog for full rescan`;
      catalog.invalidate("datastore");
    }

    if (catalog.isPopulated("datastore")) {
      const staleFiles = await this.findStaleFiles(
        datastoresDir,
        catalog,
        options?.additionalDirs,
      );

      if (staleFiles.length === 0) {
        this.registerLazyFromCatalog(catalog);
        return result;
      }

      for (const { absolutePath, relativePath, baseDir } of staleFiles) {
        try {
          await this.rebundleAndUpdateCatalog(
            absolutePath,
            relativePath,
            denoPath,
            baseDir,
            catalog,
          );
          result.loaded.push(relativePath);
        } catch (error) {
          result.failed.push({ file: relativePath, error: String(error) });
        }
      }

      this.registerLazyFromCatalog(catalog);
      return result;
    }

    // Catalog not populated — full import to bootstrap.
    const fullResult = await this.loadDatastores(datastoresDir, {
      additionalDirs: options?.additionalDirs,
      skipAlreadyRegistered: true,
    });

    this.populateCatalogFromRegistry(
      catalog,
      datastoresDir,
      options?.additionalDirs,
    );
    catalog.markPopulated("datastore");
    catalog.setSourceDirsFingerprint(currentSourceFingerprint, "datastore");

    return fullResult;
  }

  /**
   * Loads a single datastore type by its normalized type name.
   * Looks up the bundle path from the catalog, imports the bundle,
   * and registers the type.
   */
  async loadSingleType(
    typeNormalized: string,
    catalog: ExtensionCatalogStore,
  ): Promise<void> {
    installZodGlobal();

    const entry = catalog.findByType(typeNormalized, "datastore");
    if (!entry) {
      throw new Error(
        `No catalog entry for datastore type: ${typeNormalized}`,
      );
    }

    await this.importAndRegisterBundle(entry);
  }

  /**
   * Imports a single datastore bundle and registers it.
   */
  private async importAndRegisterBundle(
    entry: ExtensionTypeRow,
  ): Promise<void> {
    if (datastoreTypeRegistry.get(entry.type_normalized)) return;

    let js = await Deno.readTextFile(entry.bundle_path);
    const fixed = fixCjsEsmInterop(rewriteZodImports(js));
    if (fixed !== js) {
      js = fixed;
      await Deno.writeTextFile(entry.bundle_path, js);
    }
    const module = await import(toFileUrl(entry.bundle_path).href);

    if (!module.datastore) {
      throw new Error(
        `Bundle has no datastore export: ${entry.bundle_path}`,
      );
    }

    const parsed = UserDatastoreSchema.safeParse(module.datastore);
    if (!parsed.success) {
      throw new Error(this.formatValidationError(parsed.error));
    }

    datastoreTypeRegistry.promoteFromLazy({
      type: parsed.data.type,
      name: parsed.data.name,
      description: parsed.data.description,
      configSchema: parsed.data.configSchema,
      createProvider: parsed.data.createProvider,
      isBuiltIn: false,
    });
  }

  /**
   * Registers lazy entries for all datastore types in the catalog.
   */
  private registerLazyFromCatalog(catalog: ExtensionCatalogStore): void {
    const entries = catalog.findByKind("datastore");
    for (const entry of entries) {
      datastoreTypeRegistry.registerLazy({
        type: entry.type_normalized,
        bundlePath: entry.bundle_path,
        sourcePath: entry.source_path,
        version: entry.version,
      });
    }
  }

  /**
   * Populates the catalog from the currently loaded registry.
   */
  private populateCatalogFromRegistry(
    catalog: ExtensionCatalogStore,
    datastoresDir: string,
    additionalDirs?: string[],
  ): void {
    if (!this.repoDir) return;

    const bundleBaseDir = join(
      this.repoDir,
      SWAMP_DATA_DIR,
      SWAMP_SUBDIRS.datastoreBundles,
    );

    const dirs = [datastoresDir, ...(additionalDirs ?? [])];
    for (const dir of dirs) {
      try {
        this.populateCatalogFromDir(dir, bundleBaseDir, catalog);
      } catch {
        // Directory doesn't exist — skip
      }
    }
  }

  /**
   * Synchronously populates catalog entries from a single directory.
   */
  private populateCatalogFromDir(
    dir: string,
    bundleBaseDir: string,
    catalog: ExtensionCatalogStore,
  ): void {
    const files = this.discoverFilesSync(dir);
    const ns = this.repoDir ? bundleNamespace(dir, this.repoDir) : "";
    for (const relativePath of files) {
      const absolutePath = resolve(dir, relativePath);
      const bundlePath = join(
        bundleBaseDir,
        ns,
        relativePath.replace(/\.ts$/, ".js"),
      );

      try {
        const sourceStat = Deno.statSync(absolutePath);
        Deno.statSync(bundlePath);

        const source = Deno.readTextFileSync(absolutePath);
        if (!/export\s+const\s+datastore\s*[=:]/.test(source)) continue;

        const typeMatch = source.match(/type\s*:\s*["']([^"']+)["']/);
        if (!typeMatch) continue;

        const typeNormalized = typeMatch[1].toLowerCase();

        catalog.upsert({
          type_normalized: typeNormalized,
          kind: "datastore",
          bundle_path: bundlePath,
          source_path: absolutePath,
          version: "",
          description: "",
          extends_type: "",
          source_mtime: sourceStat.mtime?.toISOString() ?? "",
        });
      } catch {
        // Skip files that can't be read or don't have bundles
      }
    }
  }

  /**
   * Synchronous version of discoverFiles for catalog population.
   */
  private discoverFilesSync(dir: string, prefix = ""): string[] {
    const files: string[] = [];
    for (const entry of Deno.readDirSync(dir)) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory) {
        if (entry.name.startsWith("_")) continue;
        files.push(
          ...this.discoverFilesSync(join(dir, entry.name), relativePath),
        );
      } else if (
        entry.isFile && entry.name.endsWith(".ts") &&
        !entry.name.endsWith("_test.ts")
      ) {
        files.push(relativePath);
      }
    }
    return files.sort();
  }

  /**
   * Finds files that have changed since the catalog was last populated.
   */
  private async findStaleFiles(
    datastoresDir: string,
    catalog: ExtensionCatalogStore,
    additionalDirs?: string[],
  ): Promise<
    Array<{ absolutePath: string; relativePath: string; baseDir: string }>
  > {
    const stale: Array<{
      absolutePath: string;
      relativePath: string;
      baseDir: string;
    }> = [];

    const allDirs = [datastoresDir, ...(additionalDirs ?? [])];

    const catalogEntries = catalog.findByKind("datastore");
    const catalogBySource = new Map<string, ExtensionTypeRow>();
    for (const entry of catalogEntries) {
      catalogBySource.set(entry.source_path, entry);
    }

    const seenSources = new Set<string>();

    for (const dir of allDirs) {
      try {
        await Deno.stat(dir);
      } catch {
        continue;
      }

      const files = await this.discoverFiles(dir);
      for (const relativePath of files) {
        const absolutePath = resolve(dir, relativePath);
        seenSources.add(absolutePath);

        const catalogEntry = catalogBySource.get(absolutePath);
        if (!catalogEntry) {
          stale.push({ absolutePath, relativePath, baseDir: dir });
          continue;
        }

        try {
          const stat = await Deno.stat(absolutePath);
          const sourceMtime = stat.mtime?.toISOString() ?? "";
          if (sourceMtime !== catalogEntry.source_mtime) {
            stale.push({ absolutePath, relativePath, baseDir: dir });
            continue;
          }

          // Entry point is fresh — check transitive dependencies against
          // the cached bundle file's mtime. This catches edits to imported
          // .ts files that don't touch the entry point (#1094).
          const bundlePath = this.getDatastoreBundlePath(relativePath, dir);
          if (bundlePath) {
            try {
              const bundleStat = await Deno.stat(bundlePath);
              if (bundleStat.mtime) {
                const { resolvedFiles } = await resolveLocalImports(
                  [absolutePath],
                  dir,
                );
                const depStats = await Promise.all(
                  resolvedFiles.map((f) => Deno.stat(f)),
                );
                const newestDepMtime = depStats.reduce<Date | null>(
                  (max, s) => {
                    if (!s.mtime) return max;
                    if (!max) return s.mtime;
                    return s.mtime > max ? s.mtime : max;
                  },
                  null,
                );
                if (
                  newestDepMtime && newestDepMtime >= bundleStat.mtime
                ) {
                  stale.push({ absolutePath, relativePath, baseDir: dir });
                }
              }
            } catch {
              // Bundle file missing or dep stat failed — mark as stale
              // to trigger a rebundle.
              stale.push({ absolutePath, relativePath, baseDir: dir });
            }
          }
        } catch {
          stale.push({ absolutePath, relativePath, baseDir: dir });
        }
      }
    }

    for (const [sourcePath] of catalogBySource) {
      if (!seenSources.has(sourcePath)) {
        catalog.removeBySourcePath(sourcePath);
      }
    }

    return stale;
  }

  /**
   * Rebundles a single file and updates the catalog entry.
   */
  private async rebundleAndUpdateCatalog(
    absolutePath: string,
    relativePath: string,
    denoPath: string,
    baseDir: string,
    catalog: ExtensionCatalogStore,
  ): Promise<void> {
    const source = await Deno.readTextFile(absolutePath);
    if (!/export\s+const\s+datastore\s*[=:]/.test(source)) {
      return;
    }

    const js = await this.bundleWithCache(
      absolutePath,
      relativePath,
      denoPath,
      baseDir,
    );
    const module = await this.importBundle(js, relativePath, baseDir);

    if (!module.datastore) return;

    const parsed = UserDatastoreSchema.safeParse(module.datastore);
    if (!parsed.success) {
      throw new Error(this.formatValidationError(parsed.error));
    }

    const stat = await Deno.stat(absolutePath);
    const sourceMtime = stat.mtime?.toISOString() ?? "";
    const typeNormalized = parsed.data.type.toLowerCase();
    const bundlePath = this.getDatastoreBundlePath(relativePath, baseDir);

    catalog.upsert({
      type_normalized: typeNormalized,
      kind: "datastore",
      bundle_path: bundlePath,
      source_path: absolutePath,
      version: "",
      description: parsed.data.description,
      extends_type: "",
      source_mtime: sourceMtime,
    });

    // Also register since we already imported
    if (!datastoreTypeRegistry.has(parsed.data.type)) {
      datastoreTypeRegistry.register({
        type: parsed.data.type,
        name: parsed.data.name,
        description: parsed.data.description,
        configSchema: parsed.data.configSchema,
        createProvider: parsed.data.createProvider,
        isBuiltIn: false,
      });
    }
  }

  /**
   * Returns the bundle cache path for a relative source path.
   */
  private getDatastoreBundlePath(
    relativePath: string,
    baseDir: string,
  ): string {
    if (!this.repoDir) return "";
    return join(
      this.repoDir,
      SWAMP_DATA_DIR,
      SWAMP_SUBDIRS.datastoreBundles,
      bundleNamespace(baseDir, this.repoDir),
      relativePath.replace(/\.ts$/, ".js"),
    );
  }

  /**
   * Recursively discovers TypeScript files in the given directory.
   * Returns relative paths. Excludes test files.
   */
  private async discoverFiles(
    dir: string,
    prefix = "",
  ): Promise<string[]> {
    const files: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory) {
        // Skip _-prefixed directories (e.g. _lib/) — helper modules, not entry points
        if (entry.name.startsWith("_")) {
          continue;
        }
        const nested = await this.discoverFiles(
          join(dir, entry.name),
          relativePath,
        );
        files.push(...nested);
      } else if (
        entry.isFile && entry.name.endsWith(".ts") &&
        !entry.name.endsWith("_test.ts")
      ) {
        files.push(relativePath);
      }
    }
    return files.sort();
  }
}
