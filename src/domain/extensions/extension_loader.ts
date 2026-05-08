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

import { dirname, join, resolve, SEPARATOR, toFileUrl } from "@std/path";
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
} from "./bundle_freshness.ts";
import {
  BUNDLE_LAYOUT_VERSION,
  type ExtensionCatalogStore,
  sourceDirsFingerprint,
} from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import {
  bundleNamespace,
  SWAMP_DATA_DIR,
} from "../../infrastructure/persistence/paths.ts";
import { assertSafePath } from "../../infrastructure/persistence/safe_path.ts";
import { emitTypeExtractionFailure } from "../../infrastructure/logging/extension_load_warnings.ts";
import type { DatastorePathResolver } from "../datastore/datastore_path_resolver.ts";
import type {
  BundleIndexResult,
  ExtensionLoadResult,
  KindAdapter,
  RegistrationContext,
} from "./kind_adapter.ts";

export class ExtensionLoader {
  private readonly denoRuntime: DenoRuntime;
  private readonly repoDir: string | null;
  private readonly datastoreResolver?: DatastorePathResolver;
  private readonly repository?: ExtensionRepository;
  private readonly adapter: KindAdapter;
  private readonly logger;

  constructor(
    denoRuntime: DenoRuntime,
    adapter: KindAdapter,
    repoDir: string | null = null,
    datastoreResolver?: DatastorePathResolver,
    repository?: ExtensionRepository,
  ) {
    this.denoRuntime = denoRuntime;
    this.adapter = adapter;
    this.repoDir = repoDir;
    this.datastoreResolver = datastoreResolver;
    this.repository = repository;
    this.logger = getLogger(["swamp", adapter.kind, "loader"]);
  }

  private requireRepository(method: string): ExtensionRepository {
    if (!this.repository) {
      throw new Error(
        `ExtensionLoader(${this.adapter.kind}).${method} requires an ExtensionRepository.`,
      );
    }
    return this.repository;
  }

  async load(
    dir: string,
    options?: {
      skipAlreadyRegistered?: boolean;
      additionalDirs?: string[];
    },
  ): Promise<ExtensionLoadResult> {
    const result: ExtensionLoadResult = {
      loaded: [],
      extended: [],
      failed: [],
    };

    installZodGlobal();
    const denoPath = await this.denoRuntime.ensureDeno();

    const allFiles: Array<{ file: string; baseDir: string }> = [];
    for (const d of [dir, ...(options?.additionalDirs ?? [])]) {
      try {
        await Deno.stat(d);
      } catch {
        continue;
      }
      const files = await this.discoverFiles(d);
      for (const file of files) {
        allFiles.push({ file, baseDir: d });
      }
    }

    const primaryFiles: Array<{
      file: string;
      module: Record<string, unknown>;
      absolutePath: string;
    }> = [];
    const secondaryFiles: Array<{
      file: string;
      module: Record<string, unknown>;
    }> = [];

    for (const { file, baseDir } of allFiles) {
      try {
        const absolutePath = resolve(baseDir, file);
        const source = await Deno.readTextFile(absolutePath);
        if (!this.adapter.exportRegex.test(source)) {
          this.logger
            .debug`Skipping ${file} (no ${this.adapter.kind} export found)`;
          continue;
        }

        const { js, fromCache } = await this.bundleWithCache(
          absolutePath,
          file,
          denoPath,
          baseDir,
        );
        if (fromCache) {
          this.logger
            .warn`Using cached bundle for ${file} — source may have changed but bundle could not be regenerated`;
        }
        const module = await this.importBundle(js, file, baseDir);

        if (module[this.adapter.primaryExportKey]) {
          primaryFiles.push({ file, module, absolutePath });
        } else if (
          this.adapter.secondaryExportKey &&
          module[this.adapter.secondaryExportKey]
        ) {
          secondaryFiles.push({ file, module });
        }
      } catch (error) {
        result.failed.push({ file, error: String(error) });
      }
    }

    const ctx: RegistrationContext = {
      absolutePath: "",
      denoPath,
      denoRuntime: this.denoRuntime,
      repoDir: this.repoDir,
    };

    for (const { file, module, absolutePath } of primaryFiles) {
      try {
        const exported = module[this.adapter.primaryExportKey];
        const parsed = this.adapter.validatePrimaryExport(exported);
        if (!parsed.success) {
          result.failed.push({
            file,
            error: this.adapter.formatValidationError(parsed.error),
          });
          continue;
        }

        const validated = parsed.data as Record<string, unknown>;
        const typeNormalized = this.adapter.normalizeType(validated);

        if (this.adapter.validateNamespace) {
          const namespaceError = this.adapter.validateNamespace(
            String(validated.type ?? validated.name ?? ""),
          );
          if (namespaceError) {
            result.failed.push({ file, error: namespaceError });
            continue;
          }
        }

        if (this.adapter.hasType(typeNormalized)) {
          if (options?.skipAlreadyRegistered) continue;
          result.failed.push({
            file,
            error:
              `${this.adapter.kind} type '${typeNormalized}' already registered`,
          });
          continue;
        }

        this.adapter.register(
          typeNormalized,
          validated,
          module,
          { ...ctx, absolutePath },
        );
        result.loaded.push(file);
      } catch (error) {
        result.failed.push({ file, error: String(error) });
      }
    }

    if (this.adapter.processSecondaryExport) {
      for (const { file, module } of secondaryFiles) {
        try {
          this.adapter.processSecondaryExport(
            file,
            module[this.adapter.secondaryExportKey!],
            result,
          );
        } catch (error) {
          result.failed.push({ file, error: String(error) });
        }
      }
    }

    return result;
  }

  async buildIndex(
    dir: string,
    options?: { additionalDirs?: string[] },
  ): Promise<ExtensionLoadResult> {
    const repository = this.requireRepository("buildIndex");
    const catalog = repository.getCatalogStore();
    const result: ExtensionLoadResult = {
      loaded: [],
      extended: [],
      failed: [],
    };

    installZodGlobal();
    const denoPath = await this.denoRuntime.ensureDeno();

    const currentBasePath = this.resolveBundlePath();
    const currentSourceFingerprint = sourceDirsFingerprint(
      dir,
      options?.additionalDirs,
    );
    const guard = repository.invalidationGuards({
      kind: this.adapter.kind,
      expectedLayoutVersion: BUNDLE_LAYOUT_VERSION,
      expectedDatastoreBasePath: currentBasePath,
      expectedSourceDirsFingerprint: currentSourceFingerprint,
    });
    if (guard.shouldInvalidate && guard.reason !== "not-populated") {
      this.logger
        .warn`Catalog invalidated for ${this.adapter.kind} rescan: ${guard.reason}`;
      catalog.invalidate(this.adapter.kind);
    }

    if (catalog.isPopulated(this.adapter.kind)) {
      const staleFiles = await this.findStaleFiles(
        dir,
        catalog,
        options?.additionalDirs,
      );

      if (staleFiles.length === 0) {
        this.registerLazyFromCatalog(catalog);
        return result;
      }

      const eagerlyRegisteredTypes = new Set<string>();
      for (const { absolutePath, relativePath, baseDir } of staleFiles) {
        try {
          const registeredType = await this.rebundleAndUpdateCatalog(
            absolutePath,
            relativePath,
            denoPath,
            baseDir,
            catalog,
          );
          if (registeredType) {
            eagerlyRegisteredTypes.add(registeredType);
          }
          result.loaded.push(relativePath);
        } catch (error) {
          result.failed.push({ file: relativePath, error: String(error) });
        }
      }

      if (this.adapter.attachPendingExtensionsForType) {
        for (const type of eagerlyRegisteredTypes) {
          await this.adapter.attachPendingExtensionsForType(
            type,
            catalog,
            (paths) => this.importBundleByPath(paths),
          );
        }
      }

      this.registerLazyFromCatalog(catalog);
      return result;
    }

    const fullResult = await this.load(dir, {
      additionalDirs: options?.additionalDirs,
      skipAlreadyRegistered: true,
    });

    await this.populateCatalogFromRegistry(
      catalog,
      dir,
      options?.additionalDirs,
    );
    catalog.markPopulated(this.adapter.kind);
    catalog.setLayoutVersion(BUNDLE_LAYOUT_VERSION);
    catalog.setDatastoreBasePath(currentBasePath, this.adapter.kind);
    catalog.setSourceDirsFingerprint(
      currentSourceFingerprint,
      this.adapter.kind,
    );

    if (this.adapter.migrateOldFlatBundles && this.repoDir) {
      this.adapter.migrateOldFlatBundles(this.repoDir, options?.additionalDirs);
    }

    return fullResult;
  }

  async loadSingleType(typeNormalized: string): Promise<void> {
    const catalog = this.requireRepository("loadSingleType").getCatalogStore();
    installZodGlobal();

    const entry = catalog.findByType(
      typeNormalized,
      this.adapter.catalogKinds[0],
    );
    if (!entry) {
      throw new Error(
        `No catalog entry for ${this.adapter.kind} type: ${typeNormalized}`,
      );
    }

    await this.importAndRegisterBundle(entry);

    if (this.adapter.findExtensionsForType) {
      const extensions = this.adapter.findExtensionsForType(
        catalog,
        typeNormalized,
      );
      for (const ext of extensions) {
        if (this.adapter.importAndExtendBundle) {
          await this.adapter.importAndExtendBundle(
            ext,
            (paths) => this.importBundleByPath(paths),
            { loaded: [], extended: [], failed: [] },
          );
        }
      }
    }
  }

  async attachPendingExtensionsForType(
    typeNormalized: string,
  ): Promise<void> {
    if (!this.adapter.attachPendingExtensionsForType) return;
    const catalog = this.requireRepository("attachPendingExtensionsForType")
      .getCatalogStore();
    await this.adapter.attachPendingExtensionsForType(
      typeNormalized,
      catalog,
      (paths) => this.importBundleByPath(paths),
    );
  }

  public async bundleAndIndexOne(args: {
    absolutePath: string;
    relativePath: string;
    baseDir: string;
  }): Promise<BundleIndexResult | null> {
    const source = await Deno.readTextFile(args.absolutePath);
    if (!this.adapter.exportRegex.test(source)) {
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
    const module = await this.importBundle(
      js,
      args.relativePath,
      args.baseDir,
    );
    const fingerprint = await computeSourceFingerprint(
      args.absolutePath,
      args.baseDir,
    );

    if (module[this.adapter.primaryExportKey]) {
      const parsed = this.adapter.validatePrimaryExport(
        module[this.adapter.primaryExportKey],
      );
      if (!parsed.success) {
        throw new Error(
          this.adapter.formatValidationError(parsed.error),
        );
      }
      const validated = parsed.data as Record<string, unknown>;
      return {
        kind: this.adapter.catalogKinds[0],
        typeNormalized: this.adapter.normalizeType(validated),
        bundlePath: this.getBundlePath(args.relativePath, args.baseDir),
        fingerprint,
        fromCache,
      };
    }

    if (
      this.adapter.secondaryExportKey &&
      module[this.adapter.secondaryExportKey] &&
      this.adapter.validateSecondaryExport
    ) {
      const parsed = this.adapter.validateSecondaryExport(
        module[this.adapter.secondaryExportKey],
      );
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      const validated = parsed.data as Record<string, unknown>;
      return {
        kind: this.adapter.catalogKinds[1] ?? this.adapter.catalogKinds[0],
        typeNormalized: this.adapter.normalizeType(validated),
        bundlePath: this.getBundlePath(args.relativePath, args.baseDir),
        fingerprint,
        fromCache,
      };
    }

    return null;
  }

  private async importAndRegisterBundle(
    entry: {
      type_normalized: string;
      bundle_path: string;
      source_path: string;
    },
  ): Promise<void> {
    if (this.adapter.isFullyLoaded(entry.type_normalized)) return;

    const module = await this.importBundleByPath({
      bundlePath: entry.bundle_path,
      sourcePath: entry.source_path,
    });

    const exportKey = this.adapter.primaryExportKey;
    if (!module[exportKey]) {
      throw new Error(
        `Bundle has no ${exportKey} export: ${entry.bundle_path}`,
      );
    }

    const parsed = this.adapter.validatePrimaryExport(module[exportKey]);
    if (!parsed.success) {
      throw new Error(this.adapter.formatValidationError(parsed.error));
    }

    const denoPath = await this.denoRuntime.ensureDeno();
    this.adapter.promoteFromLazy(
      entry.type_normalized,
      parsed.data as Record<string, unknown>,
      module,
      {
        absolutePath: entry.source_path,
        denoPath,
        denoRuntime: this.denoRuntime,
        repoDir: this.repoDir,
      },
    );
  }

  async importBundleByPath(
    paths: { bundlePath: string; sourcePath: string },
  ): Promise<Record<string, unknown>> {
    let js: string;
    try {
      js = await Deno.readTextFile(paths.bundlePath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      js = await this.recoverMissingBundle(paths);
    }
    const fixed = fixCjsEsmInterop(rewriteZodImports(js));
    if (fixed !== js) {
      js = fixed;
      await Deno.writeTextFile(paths.bundlePath, js);
    }
    return await import(toFileUrl(paths.bundlePath).href);
  }

  private async recoverMissingBundle(
    paths: { bundlePath: string; sourcePath: string },
  ): Promise<string> {
    const denoPath = await this.denoRuntime.ensureDeno();
    let denoConfigPath: string | undefined;
    if (this.adapter.resolveDenoConfig) {
      denoConfigPath = this.adapter.resolveDenoConfig(
        paths.sourcePath,
        this.repoDir,
      );
    }
    const js = await bundleExtension(paths.sourcePath, denoPath, {
      denoConfigPath,
    });
    await Deno.mkdir(dirname(paths.bundlePath), { recursive: true });
    await Deno.writeTextFile(paths.bundlePath, js);
    this.logger
      .info`Recovered missing bundle for ${paths.sourcePath} on demand`;
    return js;
  }

  private registerLazyFromCatalog(catalog: ExtensionCatalogStore): void {
    for (const kind of this.adapter.catalogKinds) {
      if (kind !== this.adapter.catalogKinds[0]) continue;
      const entries = catalog.findByKind(kind);
      for (const entry of entries) {
        if (entry.state === "ValidationFailed") continue;
        this.adapter.registerLazy(entry);
      }
    }
  }

  private async populateCatalogFromRegistry(
    catalog: ExtensionCatalogStore,
    dir: string,
    additionalDirs?: string[],
  ): Promise<void> {
    if (!this.repoDir) return;

    const bundleBaseDir = this.resolveBundlePath();
    const cache = createFreshnessCache();

    const dirs = [dir, ...(additionalDirs ?? [])];
    for (const d of dirs) {
      try {
        await this.populateCatalogFromDir(d, bundleBaseDir, catalog, cache);
      } catch {
        // Directory doesn't exist — skip
      }
    }
  }

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
        if (!this.adapter.exportRegex.test(source)) continue;

        const extracted = this.adapter.extractTypeFromSource(source);
        if (!extracted) {
          emitTypeExtractionFailure(absolutePath, this.adapter.kind);
          continue;
        }

        const sourceFingerprint = await computeSourceFingerprint(
          absolutePath,
          dir,
          cache,
        );

        catalog.upsert({
          type_normalized: extracted.typeNormalized,
          kind: extracted.kind,
          bundle_path: bundlePath,
          source_path: absolutePath,
          version: extracted.version,
          description: "",
          extends_type: extracted.extendsType,
          source_mtime: sourceStat.mtime?.toISOString() ?? "",
          source_fingerprint: sourceFingerprint,
        });
      } catch {
        // Skip files that can't be read or don't have bundles
      }
    }
  }

  private async rebundleAndUpdateCatalog(
    absolutePath: string,
    relativePath: string,
    denoPath: string,
    baseDir: string,
    catalog: ExtensionCatalogStore,
  ): Promise<string | undefined> {
    const source = await Deno.readTextFile(absolutePath);
    if (!this.adapter.exportRegex.test(source)) {
      return undefined;
    }

    const { js, fromCache } = await this.bundleWithCache(
      absolutePath,
      relativePath,
      denoPath,
      baseDir,
    );
    const module = await this.importBundle(js, relativePath, baseDir);

    const stat = await Deno.stat(absolutePath);
    const sourceMtime = stat.mtime?.toISOString() ?? "";
    const sourceFingerprint = await computeSourceFingerprint(
      absolutePath,
      baseDir,
    );

    let effectiveFingerprint = sourceFingerprint;
    if (fromCache) {
      const existing = catalog.findBySourcePath(absolutePath);
      if (existing?.source_fingerprint) {
        if (existing.source_fingerprint !== sourceFingerprint) {
          this.logger
            .warn`Bundle could not be regenerated for ${relativePath} — source fingerprint preserved, will retry on next command`;
        }
        effectiveFingerprint = existing.source_fingerprint;
      }
    }

    const exportKey = this.adapter.primaryExportKey;

    if (module[exportKey]) {
      const bundlePath = this.getBundlePath(relativePath, baseDir);
      const parsed = this.adapter.validatePrimaryExport(module[exportKey]);
      if (!parsed.success) {
        markCatalogValidationFailed({
          catalog,
          sourcePath: absolutePath,
          kind: this.adapter.catalogKinds[0],
          bundlePath,
          sourceMtime,
          sourceFingerprint: effectiveFingerprint,
        });
        throw new Error(
          this.adapter.formatValidationError(parsed.error),
        );
      }
      const validated = parsed.data as Record<string, unknown>;
      const typeNormalized = this.adapter.normalizeType(validated);

      catalog.upsert({
        type_normalized: typeNormalized,
        kind: this.adapter.catalogKinds[0],
        bundle_path: bundlePath,
        source_path: absolutePath,
        version: String(validated.version ?? ""),
        description: String(validated.description ?? ""),
        extends_type: "",
        source_mtime: sourceMtime,
        source_fingerprint: effectiveFingerprint,
      });

      if (!this.adapter.hasType(typeNormalized)) {
        this.adapter.register(
          typeNormalized,
          validated,
          module,
          {
            absolutePath,
            denoPath,
            denoRuntime: this.denoRuntime,
            repoDir: this.repoDir,
          },
        );
      }

      return typeNormalized;
    }

    if (
      this.adapter.secondaryExportKey &&
      module[this.adapter.secondaryExportKey] &&
      this.adapter.validateSecondaryExport
    ) {
      const bundlePath = this.getBundlePath(relativePath, baseDir);
      const parsed = this.adapter.validateSecondaryExport(
        module[this.adapter.secondaryExportKey],
      );
      if (!parsed.success) {
        markCatalogValidationFailed({
          catalog,
          sourcePath: absolutePath,
          kind: this.adapter.catalogKinds[1] ?? this.adapter.catalogKinds[0],
          bundlePath,
          sourceMtime,
          sourceFingerprint: effectiveFingerprint,
        });
        throw new Error(parsed.error.message);
      }
      const validated = parsed.data as Record<string, unknown>;
      const typeNormalized = this.adapter.normalizeType(validated);

      catalog.upsert({
        type_normalized: typeNormalized,
        kind: this.adapter.catalogKinds[1] ?? this.adapter.catalogKinds[0],
        bundle_path: bundlePath,
        source_path: absolutePath,
        version: "",
        description: "",
        extends_type: typeNormalized,
        source_mtime: sourceMtime,
        source_fingerprint: effectiveFingerprint,
      });
    }

    return undefined;
  }

  resolveBundlePath(...segments: string[]): string {
    if (!this.repoDir) return "";
    if (this.adapter.useResolver && this.datastoreResolver) {
      return this.datastoreResolver.resolvePath(
        this.adapter.bundleSubdir,
        ...segments,
      );
    }
    return join(
      this.repoDir,
      SWAMP_DATA_DIR,
      this.adapter.bundleSubdir,
      ...segments,
    );
  }

  private getBundlePath(relativePath: string, baseDir: string): string {
    if (!this.repoDir) return "";
    return this.resolveBundlePath(
      bundleNamespace(baseDir, this.repoDir),
      relativePath.replace(/\.ts$/, ".js"),
    );
  }

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

      let bundleExists = false;
      try {
        await Deno.stat(bundlePath);
        bundleExists = true;
      } catch {
        // No bundle on disk yet — first-run bootstrap.
      }

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

      try {
        let denoConfigPath: string | undefined;
        if (this.adapter.resolveDenoConfig) {
          denoConfigPath = this.adapter.resolveDenoConfig(
            absolutePath,
            this.repoDir,
          );
          if (denoConfigPath) {
            this.logger
              .warn`Using discovered deno config for ${relativePath}: ${denoConfigPath}`;
          }
        }
        const js = await bundleExtension(absolutePath, denoPath, {
          denoConfigPath,
        });
        const bundleBoundary = this.resolveBundlePath();
        await assertSafePath(bundlePath, bundleBoundary);
        await Deno.mkdir(dirname(bundlePath), { recursive: true });
        await Deno.writeTextFile(bundlePath, js);
        this.logger.debug`Wrote bundle cache: ${bundlePath}`;
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
              this.repoDir,
            );
            if (expected) {
              this.logger
                .debug`Rebundle failed for ${relativePath}, using cached bundle: ${msg}`;
              try {
                const now = new Date();
                await Deno.utime(bundlePath, now, now);
              } catch { /* ignore — worst case we retry next load */ }
            } else {
              this.logger
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

    let denoConfigPath: string | undefined;
    if (this.adapter.resolveDenoConfig) {
      denoConfigPath = this.adapter.resolveDenoConfig(
        absolutePath,
        this.repoDir,
      );
      if (denoConfigPath) {
        this.logger
          .warn`Using discovered deno config for ${absolutePath}: ${denoConfigPath}`;
      }
    }
    const js = await bundleExtension(absolutePath, denoPath, {
      denoConfigPath,
    });
    return { js, fromCache: false };
  }

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
        this.logger.debug`File URL import failed for ${relativePath}: ${
          String(error).substring(0, 200)
        }`;
      }
    }

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

  private async findStaleFiles(
    dir: string,
    catalog: ExtensionCatalogStore,
    additionalDirs?: string[],
  ): Promise<
    Array<{ absolutePath: string; relativePath: string; baseDir: string }>
  > {
    return await findStaleFilesShared({
      modelsDir: dir,
      additionalDirs,
      catalog,
      discoverFiles: (d) => this.discoverFiles(d),
      kinds: [...this.adapter.catalogKinds],
    });
  }

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

  private async discoverFiles(
    dir: string,
    prefix = "",
  ): Promise<string[]> {
    const files: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory) {
        if (entry.name.startsWith("_")) continue;
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
