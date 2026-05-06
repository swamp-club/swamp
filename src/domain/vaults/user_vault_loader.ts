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
import type { VaultProvider } from "./vault_provider.ts";
import { vaultTypeRegistry } from "./vault_type_registry.ts";
import {
  bundleNamespace,
  SWAMP_DATA_DIR,
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";
import { assertSafePath } from "../../infrastructure/persistence/safe_path.ts";
import { emitTypeExtractionFailure } from "../../infrastructure/logging/extension_load_warnings.ts";
import type { DatastorePathResolver } from "../datastore/datastore_path_resolver.ts";
import {
  BUNDLE_LAYOUT_VERSION,
  type ExtensionCatalogStore,
  type ExtensionTypeRow,
  sourceDirsFingerprint,
} from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";

const logger = getLogger(["swamp", "vaults", "loader"]);

/** Pattern for valid user vault type: @collective/name or collective/name */
const USER_VAULT_TYPE_PATTERN = /^@?[a-z0-9_-]+\/[a-z0-9_-]+$/;

/**
 * Schema for validating user vault exports.
 */
const UserVaultSchema = z.object({
  type: z.string().refine(
    (t) => USER_VAULT_TYPE_PATTERN.test(t),
    {
      message:
        "Vault type must match @collective/name or collective/name (e.g., @myorg/custom-vault or myorg/custom-vault)",
    },
  ),
  name: z.string(),
  description: z.string(),
  configSchema: z.custom<z.ZodTypeAny>(isZodSchemaLike).optional(),
  createProvider: z.custom<
    (name: string, config: Record<string, unknown>) => VaultProvider
  >((val) => typeof val === "function"),
});

/**
 * Result of loading user vault extensions from a directory.
 */
export interface VaultLoadResult {
  loaded: string[];
  failed: Array<{ file: string; error: string }>;
}

/**
 * Loader for user-defined TypeScript vault implementations.
 *
 * Users export a `vault` object from TypeScript files that defines:
 * - type: namespaced identifier (e.g., "@myorg/custom-vault")
 * - name: human-readable name
 * - description: vault type description
 * - configSchema: optional Zod schema for config validation
 * - createProvider: factory function returning a VaultProvider
 *
 * This loader validates the structure and registers vault types with the global registry.
 */
export class UserVaultLoader {
  private readonly denoRuntime: DenoRuntime;
  private readonly repoDir: string | null;
  private readonly datastoreResolver?: DatastorePathResolver;
  private readonly repository?: ExtensionRepository;

  /**
   * @param denoRuntime - Runtime manager for obtaining a deno binary path
   * @param repoDir - Repository root for writing bundles to .swamp/vault-bundles/
   *                   (pass null to skip bundle caching)
   * @param datastoreResolver - Optional resolver for routing bundle paths
   *                            through the configured datastore tier
   * @param repository - W1b ExtensionRepository wrapping the catalog. Held
   *                     as a long-lived field per ADV-V2-1 option (a-2);
   *                     buildIndex / loadSingleType drop their per-call
   *                     catalog params and read from this field. Optional
   *                     during the W1b transition; required for
   *                     buildIndex / loadSingleType.
   */
  constructor(
    denoRuntime: DenoRuntime,
    repoDir: string | null = null,
    datastoreResolver?: DatastorePathResolver,
    repository?: ExtensionRepository,
  ) {
    this.denoRuntime = denoRuntime;
    this.repoDir = repoDir;
    this.datastoreResolver = datastoreResolver;
    this.repository = repository;
  }

  private requireRepository(method: string): ExtensionRepository {
    if (!this.repository) {
      throw new Error(
        `UserVaultLoader.${method} requires an ExtensionRepository to be passed at construction time (W1b/(a-2) wiring).`,
      );
    }
    return this.repository;
  }

  /**
   * Resolves a vault bundle path through the datastore resolver when available,
   * falling back to the local .swamp/vault-bundles/ path otherwise.
   */
  private resolveBundlePath(...segments: string[]): string {
    if (!this.repoDir) return "";
    if (this.datastoreResolver) {
      return this.datastoreResolver.resolvePath(
        SWAMP_SUBDIRS.vaultBundles,
        ...segments,
      );
    }
    return join(
      this.repoDir,
      SWAMP_DATA_DIR,
      SWAMP_SUBDIRS.vaultBundles,
      ...segments,
    );
  }

  /**
   * Loads all user vault implementations from the specified directory.
   *
   * @param vaultsDir - The directory containing user vault files
   * @returns Result containing lists of loaded and failed files
   */
  async loadVaults(
    vaultsDir: string,
    options?: {
      skipAlreadyRegistered?: boolean;
      /** Additional directories to scan (e.g. pulled extensions). */
      additionalDirs?: string[];
    },
  ): Promise<VaultLoadResult> {
    const result: VaultLoadResult = { loaded: [], failed: [] };

    // Ensure swamp's Zod is available on globalThis before importing bundles.
    installZodGlobal();

    // Ensure deno is available before bundling
    const denoPath = await this.denoRuntime.ensureDeno();

    // Discover files from primary dir and any additional dirs
    const allFiles: Array<{ file: string; baseDir: string }> = [];
    for (
      const dir of [vaultsDir, ...(options?.additionalDirs ?? [])]
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

        // Pre-check: only bundle files that declare a vault export.
        const source = await Deno.readTextFile(absolutePath);
        if (!/export\s+const\s+vault\s*[=:]/.test(source)) {
          logger.debug`Skipping ${file} (no vault export found)`;
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

        if (!module.vault) {
          // Files without a vault export are silently skipped (utility files)
          continue;
        }

        const parsed = UserVaultSchema.safeParse(module.vault);
        if (!parsed.success) {
          result.failed.push({
            file,
            error: this.formatValidationError(parsed.error),
          });
          continue;
        }

        const userVault = parsed.data;

        // Register with the vault type registry
        if (vaultTypeRegistry.has(userVault.type)) {
          if (options?.skipAlreadyRegistered) {
            // Silently skip — used during hot-load after auto-resolution
            continue;
          }
          result.failed.push({
            file,
            error: `Vault type '${userVault.type}' is already registered`,
          });
          continue;
        }

        vaultTypeRegistry.register({
          type: userVault.type,
          name: userVault.name,
          description: userVault.description,
          configSchema: userVault.configSchema,
          createProvider: userVault.createProvider,
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
   * Bundles a vault file, using cached bundle from .swamp/vault-bundles/ when possible.
   */
  private async bundleWithCache(
    absolutePath: string,
    relativePath: string,
    denoPath: string,
    boundaryDir: string,
  ): Promise<BundleResult> {
    if (this.repoDir) {
      const bundlePath = this.resolveBundlePath(
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

      // Fast-path for pulled extensions with bare specifiers and no
      // repo-side deno.json. bundleExtension would always fail for them
      // and we'd wastefully spawn Deno before falling back to the
      // cached bundle anyway.
      if (bundleExists && isExpectedBundleFailure(absolutePath, this.repoDir)) {
        return { js: await Deno.readTextFile(bundlePath), fromCache: true };
      }

      // Try to rebundle from source. If bundling fails (e.g. bare specifiers
      // without a deno.json import map) and a cached bundle exists, fall back
      // to the cache. The old bundle file is untouched on failure since
      // bundleExtension returns the JS string in memory before we write.
      try {
        const js = await bundleExtension(absolutePath, denoPath);
        const bundleBoundary = this.resolveBundlePath();
        await assertSafePath(bundlePath, bundleBoundary);
        await Deno.mkdir(dirname(bundlePath), { recursive: true });
        await Deno.writeTextFile(bundlePath, js);
        logger.debug`Wrote vault bundle cache: ${bundlePath}`;
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
      const segments = ns
        ? [ns, relativePath.replace(/\.ts$/, ".js")]
        : [relativePath.replace(/\.ts$/, ".js")];
      const bundlePath = this.resolveBundlePath(...segments);

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
   * Builds the catalog index for vault types without importing bundles.
   * On first run, does a full import to bootstrap the catalog.
   * On subsequent runs, checks mtimes and only rebundles stale files.
   * Registers lazy entries for all vault types in the catalog.
   */
  async buildIndex(
    vaultsDir: string,
    options?: { additionalDirs?: string[] },
  ): Promise<VaultLoadResult> {
    const repository = this.requireRepository("buildIndex");
    const catalog = repository.legacyStore;
    const result: VaultLoadResult = { loaded: [], failed: [] };

    installZodGlobal();
    const denoPath = await this.denoRuntime.ensureDeno();

    // Cold-start invalidation guards — under (a-2) the vault loader gets
    // the same coverage as the model loader (layout-version,
    // datastore-base-path, per-kind source-dirs-fingerprint, populated-
    // flag) for free. This is the silent fix W1b ships: pre-W1b, vault
    // had only the source-dirs-fingerprint check.
    const currentBasePath = this.resolveBundlePath();
    const currentSourceFingerprint = sourceDirsFingerprint(
      vaultsDir,
      options?.additionalDirs,
    );
    const guard = repository.invalidationGuards({
      kind: "vault",
      expectedLayoutVersion: BUNDLE_LAYOUT_VERSION,
      expectedDatastoreBasePath: currentBasePath,
      expectedSourceDirsFingerprint: currentSourceFingerprint,
    });
    if (guard.shouldInvalidate && guard.reason !== "not-populated") {
      logger
        .warn`Catalog invalidated for "vault" rescan: ${guard.reason}`;
      catalog.invalidate("vault");
    }

    if (catalog.isPopulated("vault")) {
      const staleFiles = await this.findStaleFiles(
        vaultsDir,
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
    const fullResult = await this.loadVaults(vaultsDir, {
      additionalDirs: options?.additionalDirs,
      skipAlreadyRegistered: true,
    });

    await this.populateCatalogFromRegistry(
      catalog,
      vaultsDir,
      options?.additionalDirs,
    );
    catalog.markPopulated("vault");
    catalog.setLayoutVersion(BUNDLE_LAYOUT_VERSION);
    catalog.setDatastoreBasePath(currentBasePath, "vault");
    catalog.setSourceDirsFingerprint(currentSourceFingerprint, "vault");

    return fullResult;
  }

  /**
   * Loads a single vault type by its normalized type name.
   * Looks up the bundle path from the catalog, imports the bundle,
   * and registers the type.
   */
  async loadSingleType(typeNormalized: string): Promise<void> {
    const catalog = this.requireRepository("loadSingleType").legacyStore;
    installZodGlobal();

    const entry = catalog.findByType(typeNormalized, "vault");
    if (!entry) {
      throw new Error(`No catalog entry for vault type: ${typeNormalized}`);
    }

    await this.importAndRegisterBundle(entry);
  }

  /**
   * Imports a single vault bundle and registers it.
   */
  private async importAndRegisterBundle(
    entry: ExtensionTypeRow,
  ): Promise<void> {
    if (vaultTypeRegistry.get(entry.type_normalized)) return;

    let js = await Deno.readTextFile(entry.bundle_path);
    const fixed = fixCjsEsmInterop(rewriteZodImports(js));
    if (fixed !== js) {
      js = fixed;
      await Deno.writeTextFile(entry.bundle_path, js);
    }
    const module = await import(toFileUrl(entry.bundle_path).href);

    if (!module.vault) {
      throw new Error(`Bundle has no vault export: ${entry.bundle_path}`);
    }

    const parsed = UserVaultSchema.safeParse(module.vault);
    if (!parsed.success) {
      throw new Error(this.formatValidationError(parsed.error));
    }

    vaultTypeRegistry.promoteFromLazy({
      type: parsed.data.type,
      name: parsed.data.name,
      description: parsed.data.description,
      configSchema: parsed.data.configSchema,
      createProvider: parsed.data.createProvider,
      isBuiltIn: false,
    });
  }

  /**
   * Registers lazy entries for all vault types in the catalog.
   */
  private registerLazyFromCatalog(catalog: ExtensionCatalogStore): void {
    const entries = catalog.findByKind("vault");
    for (const entry of entries) {
      // Skip ValidationFailed rows (swamp-club#209) — see equivalent
      // guard in user_model_loader.ts:registerLazyFromCatalog. Migrated
      // to read `state` instead of `validation_failed` per W1a.
      if (entry.state === "ValidationFailed") continue;
      vaultTypeRegistry.registerLazy({
        type: entry.type_normalized,
        bundlePath: entry.bundle_path,
        sourcePath: entry.source_path,
        version: entry.version,
        description: entry.description,
      });
    }
  }

  /**
   * Populates the catalog from the currently loaded registry.
   */
  private async populateCatalogFromRegistry(
    catalog: ExtensionCatalogStore,
    vaultsDir: string,
    additionalDirs?: string[],
  ): Promise<void> {
    if (!this.repoDir) return;

    const bundleBaseDir = this.resolveBundlePath();
    const cache = createFreshnessCache();

    const dirs = [vaultsDir, ...(additionalDirs ?? [])];
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
        if (!/export\s+const\s+vault\s*[=:]/.test(source)) continue;

        const typeMatch = source.match(/type\s*:\s*["']([^"']+)["']/);
        if (!typeMatch) {
          emitTypeExtractionFailure(absolutePath, "vault");
          continue;
        }

        const typeNormalized = typeMatch[1].toLowerCase();

        // Try to get description from the already-loaded registry
        const registryInfo = vaultTypeRegistry.get(typeNormalized);

        const sourceFingerprint = await computeSourceFingerprint(
          absolutePath,
          dir,
          cache,
        );

        catalog.upsert({
          type_normalized: typeNormalized,
          kind: "vault",
          bundle_path: bundlePath,
          source_path: absolutePath,
          version: "",
          description: registryInfo?.description ?? "",
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
    vaultsDir: string,
    catalog: ExtensionCatalogStore,
    additionalDirs?: string[],
  ): Promise<
    Array<{ absolutePath: string; relativePath: string; baseDir: string }>
  > {
    return await findStaleFilesShared({
      modelsDir: vaultsDir,
      additionalDirs,
      catalog,
      discoverFiles: (dir) => this.discoverFiles(dir),
      kinds: ["vault"],
    });
  }

  /**
   * Bundles a single source file and extracts vault type metadata
   * WITHOUT writing to the catalog or registering at runtime. Returns
   * `{ kind: "vault", typeNormalized, bundlePath, fingerprint }` for
   * vault source files, or `null` for files that aren't vaults.
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
      kind: "vault";
      typeNormalized: string;
      bundlePath: string;
      fingerprint: string;
      fromCache: boolean;
    }
    | null
  > {
    const source = await Deno.readTextFile(args.absolutePath);
    if (!/export\s+const\s+vault\s*[=:]/.test(source)) {
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
    if (!module.vault) return null;

    const fingerprint = await computeSourceFingerprint(
      args.absolutePath,
      args.baseDir,
    );
    const bundlePath = this.getVaultBundlePath(
      args.relativePath,
      args.baseDir,
    );

    const parsed = UserVaultSchema.safeParse(module.vault);
    if (!parsed.success) {
      throw new Error(this.formatValidationError(parsed.error));
    }

    return {
      kind: "vault",
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
    if (!/export\s+const\s+vault\s*[=:]/.test(source)) {
      return;
    }

    const { js, fromCache } = await this.bundleWithCache(
      absolutePath,
      relativePath,
      denoPath,
      baseDir,
    );
    const module = await this.importBundle(js, relativePath, baseDir);

    if (!module.vault) return;

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
    const bundlePath = this.getVaultBundlePath(relativePath, baseDir);

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

    const parsed = UserVaultSchema.safeParse(module.vault);
    if (!parsed.success) {
      markCatalogValidationFailed({
        catalog,
        sourcePath: absolutePath,
        kind: "vault",
        bundlePath,
        sourceMtime,
        sourceFingerprint: effectiveFingerprint,
      });
      throw new Error(this.formatValidationError(parsed.error));
    }

    const typeNormalized = parsed.data.type.toLowerCase();

    catalog.upsert({
      type_normalized: typeNormalized,
      kind: "vault",
      bundle_path: bundlePath,
      source_path: absolutePath,
      version: "",
      description: parsed.data.description,
      extends_type: "",
      source_mtime: sourceMtime,
      source_fingerprint: effectiveFingerprint,
    });

    // Also register since we already imported
    if (!vaultTypeRegistry.has(parsed.data.type)) {
      vaultTypeRegistry.register({
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
  private getVaultBundlePath(
    relativePath: string,
    baseDir: string,
  ): string {
    if (!this.repoDir) return "";
    return this.resolveBundlePath(
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
