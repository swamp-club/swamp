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
import { dirname, join, resolve, SEPARATOR, toFileUrl } from "@std/path";
import { isZodSchemaLike } from "../zod_compat.ts";
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
import {
  type BundleResult,
  computeSourceFingerprint,
  createFreshnessCache,
  findStaleFiles as findStaleFilesShared,
  type FreshnessCache,
  markCatalogValidationFailed,
} from "../extensions/bundle_freshness.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import type { DatastoreProvider } from "./datastore_provider.ts";
import { datastoreTypeRegistry } from "./datastore_type_registry.ts";
import {
  bundleNamespace,
  SWAMP_DATA_DIR,
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";
import { assertSafePath } from "../../infrastructure/persistence/safe_path.ts";
import { emitTypeExtractionFailure } from "../../infrastructure/logging/extension_load_warnings.ts";
import {
  BUNDLE_LAYOUT_VERSION,
  type ExtensionCatalogStore,
  type ExtensionTypeRow,
  sourceDirsFingerprint,
} from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";

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
  configSchema: z.custom<z.ZodTypeAny>(isZodSchemaLike).optional(),
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
  private readonly repository?: ExtensionRepository;

  /**
   * @param denoRuntime - Runtime manager for obtaining a deno binary path
   * @param repoDir - Repository root for writing bundles to .swamp/datastore-bundles/
   *                   (pass null to skip bundle caching)
   * @param repository - W1b ExtensionRepository wrapping the catalog. Held
   *                     as a long-lived field per ADV-V2-1 option (a-2).
   */
  constructor(
    denoRuntime: DenoRuntime,
    repoDir: string | null = null,
    repository?: ExtensionRepository,
  ) {
    this.denoRuntime = denoRuntime;
    this.repoDir = repoDir;
    this.repository = repository;
  }

  private requireRepository(method: string): ExtensionRepository {
    if (!this.repository) {
      throw new Error(
        `UserDatastoreLoader.${method} requires an ExtensionRepository to be passed at construction time (W1b/(a-2) wiring).`,
      );
    }
    return this.repository;
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

        const { js, fromCache } = await this.bundleWithCache(
          absolutePath,
          file,
          denoPath,
          baseDir,
        );
        if (fromCache) {
          logger
            .warn`Using cached bundle for ${file} — source may have changed but bundle could not be regenerated`;
        }
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
  ): Promise<BundleResult> {
    if (this.repoDir) {
      const bundlePath = join(
        this.repoDir,
        SWAMP_DATA_DIR,
        SWAMP_SUBDIRS.datastoreBundles,
        bundleNamespace(boundaryDir, this.repoDir),
        relativePath.replace(/\.ts$/, ".js"),
      );

      // Freshness is decided by the caller via
      // bundle_freshness.findStaleFiles (content-fingerprint compare).
      // We only care whether a bundle file exists on disk so we can
      // fall back to it if rebundling fails with an expected error
      // (bare specifiers without deno.json). No mtime check here —
      // mtime-based freshness was unreliable under atomic-rename
      // saves (#125).
      let bundleExists = false;
      try {
        await Deno.stat(bundlePath);
        bundleExists = true;
      } catch {
        // No bundle on disk yet — first-run bootstrap.
      }

      // Fast-path for pulled extensions only — user-developed extensions
      // must always attempt the build (swamp-club#274).
      const isPulled = this.repoDir &&
        resolve(boundaryDir).startsWith(
          join(resolve(this.repoDir), SWAMP_DATA_DIR, "pulled-extensions") +
            SEPARATOR,
        );
      if (
        bundleExists && isPulled &&
        isExpectedBundleFailure(absolutePath, this.repoDir)
      ) {
        return { js: await Deno.readTextFile(bundlePath), fromCache: true };
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
        return { js, fromCache: false };
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
            return { js: cached, fromCache: true };
          } catch {
            // Cache file was removed between stat and read — treat as no cache.
          }
        }
        throw bundleError;
      }
    }

    // No repo dir — just bundle without caching
    const js = await bundleExtension(absolutePath, denoPath);
    return { js, fromCache: false };
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
    options?: { additionalDirs?: string[] },
  ): Promise<DatastoreLoadResult> {
    const repository = this.requireRepository("buildIndex");
    const catalog = repository.legacyStore;
    const result: DatastoreLoadResult = { loaded: [], failed: [] };

    installZodGlobal();
    const denoPath = await this.denoRuntime.ensureDeno();

    // Cold-start invalidation guards — full coverage under (a-2). The
    // datastore loader's bundle base path is the per-kind datastore-bundles
    // subdir under the repo's data root.
    const currentBasePath = this.repoDir
      ? join(
        this.repoDir,
        SWAMP_DATA_DIR,
        SWAMP_SUBDIRS.datastoreBundles,
      )
      : "";
    const currentSourceFingerprint = sourceDirsFingerprint(
      datastoresDir,
      options?.additionalDirs,
    );
    const guard = repository.invalidationGuards({
      kind: "datastore",
      expectedLayoutVersion: BUNDLE_LAYOUT_VERSION,
      expectedDatastoreBasePath: currentBasePath,
      expectedSourceDirsFingerprint: currentSourceFingerprint,
    });
    if (guard.shouldInvalidate && guard.reason !== "not-populated") {
      logger
        .warn`Catalog invalidated for "datastore" rescan: ${guard.reason}`;
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

    await this.populateCatalogFromRegistry(
      catalog,
      datastoresDir,
      options?.additionalDirs,
    );
    catalog.markPopulated("datastore");
    catalog.setLayoutVersion(BUNDLE_LAYOUT_VERSION);
    catalog.setDatastoreBasePath(currentBasePath, "datastore");
    catalog.setSourceDirsFingerprint(currentSourceFingerprint, "datastore");

    return fullResult;
  }

  /**
   * Loads a single datastore type by its normalized type name.
   * Looks up the bundle path from the catalog, imports the bundle,
   * and registers the type.
   */
  async loadSingleType(typeNormalized: string): Promise<void> {
    const catalog = this.requireRepository("loadSingleType").legacyStore;
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
      // Skip ValidationFailed rows (swamp-club#209) — see equivalent
      // guard in user_model_loader.ts:registerLazyFromCatalog. Migrated
      // to read `state` instead of `validation_failed` per W1a.
      if (entry.state === "ValidationFailed") continue;
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
  private async populateCatalogFromRegistry(
    catalog: ExtensionCatalogStore,
    datastoresDir: string,
    additionalDirs?: string[],
  ): Promise<void> {
    if (!this.repoDir) return;

    const bundleBaseDir = join(
      this.repoDir,
      SWAMP_DATA_DIR,
      SWAMP_SUBDIRS.datastoreBundles,
    );
    const cache = createFreshnessCache();

    const dirs = [datastoresDir, ...(additionalDirs ?? [])];
    for (const dir of dirs) {
      try {
        await this.populateCatalogFromDir(dir, bundleBaseDir, catalog, cache);
      } catch {
        // Directory doesn't exist — skip
      }
    }
  }

  /**
   * Populates catalog entries from a single directory, recording a
   * content-fingerprint for each entry so subsequent findStaleFiles
   * passes can detect mtime-preserving edits (#125).
   */
  private async populateCatalogFromDir(
    dir: string,
    bundleBaseDir: string,
    catalog: ExtensionCatalogStore,
    cache: FreshnessCache,
  ): Promise<void> {
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
        if (!typeMatch) {
          emitTypeExtractionFailure(absolutePath, "datastore");
          continue;
        }

        const typeNormalized = typeMatch[1].toLowerCase();

        const sourceFingerprint = await computeSourceFingerprint(
          absolutePath,
          dir,
          cache,
        );

        catalog.upsert({
          type_normalized: typeNormalized,
          kind: "datastore",
          bundle_path: bundlePath,
          source_path: absolutePath,
          version: "",
          description: "",
          extends_type: "",
          source_mtime: sourceStat.mtime?.toISOString() ?? "",
          source_fingerprint: sourceFingerprint,
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
   * Finds files that need rebundling since the catalog was last populated.
   * Delegates to the shared content-fingerprint freshness check —
   * mtime-based invalidation was unreliable under atomic-rename saves and
   * mtime-preserving sync tools (issue #125).
   */
  private async findStaleFiles(
    datastoresDir: string,
    catalog: ExtensionCatalogStore,
    additionalDirs?: string[],
  ): Promise<
    Array<{ absolutePath: string; relativePath: string; baseDir: string }>
  > {
    return await findStaleFilesShared({
      modelsDir: datastoresDir,
      additionalDirs,
      catalog,
      discoverFiles: (dir) => this.discoverFiles(dir),
      kinds: ["datastore"],
    });
  }

  /**
   * Bundles a single source file and extracts datastore type metadata
   * WITHOUT writing to the catalog or registering at runtime. Returns
   * `{ kind: "datastore", typeNormalized, bundlePath, fingerprint }`
   * for datastore source files, or `null` for files that aren't
   * datastores.
   *
   * **W2 contract — load-bearing for I-Repo-1.** Lifecycle services
   * call this at install time and commit via `repository.save()`. The
   * regression test `bundleAndIndexOne does not write catalog rows`
   * pins this method's no-catalog-write contract.
   *
   * @throws Error on bundle build failure or schema validation failure.
   */
  public async bundleAndIndexOne(args: {
    absolutePath: string;
    relativePath: string;
    baseDir: string;
  }): Promise<
    | {
      kind: "datastore";
      typeNormalized: string;
      bundlePath: string;
      fingerprint: string;
      fromCache: boolean;
    }
    | null
  > {
    const source = await Deno.readTextFile(args.absolutePath);
    if (!/export\s+const\s+datastore\s*[=:]/.test(source)) {
      return null;
    }

    installZodGlobal();
    const denoPath = await this.denoRuntime.ensureDeno();
    const { js, fromCache } = await this.bundleWithCache(
      args.absolutePath,
      args.relativePath,
      denoPath,
      args.baseDir,
    );
    const module = await this.importBundle(js, args.relativePath, args.baseDir);
    if (!module.datastore) return null;

    const fingerprint = await computeSourceFingerprint(
      args.absolutePath,
      args.baseDir,
    );
    const bundlePath = this.getDatastoreBundlePath(
      args.relativePath,
      args.baseDir,
    );

    const parsed = UserDatastoreSchema.safeParse(module.datastore);
    if (!parsed.success) {
      throw new Error(this.formatValidationError(parsed.error));
    }

    return {
      kind: "datastore",
      typeNormalized: parsed.data.type.toLowerCase(),
      bundlePath,
      fingerprint,
      fromCache,
    };
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

    const { js, fromCache } = await this.bundleWithCache(
      absolutePath,
      relativePath,
      denoPath,
      baseDir,
    );
    const module = await this.importBundle(js, relativePath, baseDir);

    if (!module.datastore) return;

    // Compute mtime+fingerprint BEFORE schema validation so we can
    // record a validation-failed catalog row if the parse throws —
    // otherwise findStaleFiles re-bundles every pass on a stable
    // broken source (swamp-club#209).
    const stat = await Deno.stat(absolutePath);
    const sourceMtime = stat.mtime?.toISOString() ?? "";
    const sourceFingerprint = await computeSourceFingerprint(
      absolutePath,
      baseDir,
    );

    // When the bundle came from cache (build failed or isExpectedBundleFailure),
    // preserve the catalog's stored fingerprint so findStaleFiles retries on the
    // next warm-start. Only warn on the fallback case (fingerprint actually
    // differs), not on legitimate cache hits where source hasn't changed.
    let effectiveFingerprint = sourceFingerprint;
    if (fromCache) {
      const existing = catalog.findBySourcePath(absolutePath);
      if (existing?.source_fingerprint) {
        if (existing.source_fingerprint !== sourceFingerprint) {
          logger
            .warn`Bundle could not be regenerated for ${relativePath} — source fingerprint preserved, will retry on next command`;
        }
        effectiveFingerprint = existing.source_fingerprint;
      }
    }

    const bundlePath = this.getDatastoreBundlePath(relativePath, baseDir);

    const parsed = UserDatastoreSchema.safeParse(module.datastore);
    if (!parsed.success) {
      markCatalogValidationFailed({
        catalog,
        sourcePath: absolutePath,
        kind: "datastore",
        bundlePath,
        sourceMtime,
        sourceFingerprint: effectiveFingerprint,
      });
      throw new Error(this.formatValidationError(parsed.error));
    }

    const typeNormalized = parsed.data.type.toLowerCase();

    catalog.upsert({
      type_normalized: typeNormalized,
      kind: "datastore",
      bundle_path: bundlePath,
      source_path: absolutePath,
      version: "",
      description: parsed.data.description,
      extends_type: "",
      source_mtime: sourceMtime,
      source_fingerprint: effectiveFingerprint,
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
