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
import { computeChecksum } from "../models/checksum.ts";
import {
  type BundleResult,
  collectSeenSources,
  computeSourceFingerprint,
  createFreshnessCache,
  type FreshnessCache,
  type FreshnessScan,
  removeUnseenCatalogRows,
  scanCatalogFreshness,
  type TypelessRow,
} from "./bundle_freshness.ts";
import {
  BUNDLE_LAYOUT_VERSION,
  type ExtensionCatalogStore,
  type ExtensionTypeRow,
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
import { canonicalizePath } from "../../infrastructure/persistence/canonicalize_path.ts";
import { evictRemovedBundles } from "./bundle_eviction.ts";
import type { DatastorePathResolver } from "../datastore/datastore_path_resolver.ts";
import type {
  BundleIndexResult,
  ExtensionLoadResult,
  KindAdapter,
  RegistrationContext,
} from "./kind_adapter.ts";
import { ValidationError } from "./validation_error.ts";
import { makeLocalExtension } from "./extension.ts";
import {
  extensionKindToKindDir,
  findSourceByPath,
  recordSourceFailure,
} from "./source_failure_recorder.ts";
import { makeSourceLocation } from "./source_location.ts";
import {
  compareExtensionPrecedence,
  type ExtensionContributor,
  isPulledExtensionPath,
} from "./extension_precedence.ts";

/**
 * Build the dynamic import() URL for a bundle file, keyed on the bundle's
 * content. The ES module registry keys modules by URL and never evicts
 * them, so identical bundle bytes must map to one URL: re-importing an
 * unchanged bundle (e.g. on serve hot-reload) then reuses the cached
 * module instead of retaining a new copy, while a changed bundle gets a
 * new URL and its new code executes (swamp-club#1140, swamp-club#2340).
 *
 * `bundleJs` must be exactly the text on disk at `bundlePath`.
 */
export async function bundleImportUrl(
  bundlePath: string,
  bundleJs: string,
  sourceFingerprint?: string,
): Promise<string> {
  const contentHash = await computeChecksum(
    new TextEncoder().encode(bundleJs),
  );
  const params = [
    sourceFingerprint ? `fp=${sourceFingerprint}` : "",
    `h=${contentHash}`,
  ].filter(Boolean).join("&");
  return `${toFileUrl(bundlePath).href}?${params}`;
}

/**
 * Extract the extension name from an absolute path within the
 * pulled-extensions directory. Returns undefined for paths outside
 * pulled-extensions (user-authored or built-in models).
 *
 * Path format: .../.swamp/pulled-extensions/@scope/name/<kind>/...
 * For scoped: @scope/name. For unscoped: name.
 */
/**
 * The canonical form of `path` with symlinks resolved, or `path` itself
 * when it cannot be resolved (e.g. the file no longer exists).
 */
function realCanonicalPath(path: string): string {
  try {
    return canonicalizePath(Deno.realPathSync(path));
  } catch {
    return path;
  }
}

/** A row that holds a usable type for its source. */
function isIndexedRow(row: ExtensionTypeRow): boolean {
  return (row.state ?? "Indexed") !== "Tombstoned" &&
    row.type_normalized.length > 0;
}

/**
 * Indexed catalog rows whose source path is outside the loader's spelling
 * of the repo root, keyed by symlink-resolved path. Built on the first
 * lookup of a cold catalog pass and shared across its directories.
 */
interface OtherSpellingRows {
  rows?: Map<string, ExtensionTypeRow>;
}

export function extractExtensionNameFromPath(
  absolutePath: string,
  repoDir: string | null,
): string | undefined {
  if (!repoDir) return undefined;

  const cheapRepoDir = resolve(repoDir);
  const pulledRoots = [
    join(cheapRepoDir, SWAMP_DATA_DIR, "pulled-extensions"),
    join(cheapRepoDir, SWAMP_DATA_DIR, "config", "pulled-extensions"),
  ];
  const cheapResolved = resolve(absolutePath);

  let relative: string;
  const matchedCheap = pulledRoots.find((r) =>
    cheapResolved.startsWith(r + SEPARATOR)
  );
  if (matchedCheap) {
    relative = cheapResolved.slice(matchedCheap.length + 1);
  } else {
    let realRepoDir: string;
    try {
      realRepoDir = Deno.realPathSync(repoDir);
    } catch {
      return undefined;
    }
    if (realRepoDir === cheapRepoDir) return undefined;
    const realPulledRoots = [
      join(realRepoDir, SWAMP_DATA_DIR, "pulled-extensions"),
      join(realRepoDir, SWAMP_DATA_DIR, "config", "pulled-extensions"),
    ];
    let realResolved: string;
    try {
      realResolved = Deno.realPathSync(absolutePath);
    } catch {
      return undefined;
    }
    const matchedReal = realPulledRoots.find((r) =>
      realResolved.startsWith(r + SEPARATOR)
    );
    if (!matchedReal) return undefined;
    relative = realResolved.slice(matchedReal.length + 1);
  }

  const segments = relative.split(SEPARATOR);
  if (segments.length < 2) return undefined;
  let name: string;
  if (segments[0].startsWith("@") && segments.length >= 3) {
    name = `${segments[0]}/${segments[1]}`;
  } else {
    name = segments[0];
  }
  if (name.includes("..") || name.includes("\0")) return undefined;
  return name;
}

/**
 * Row states of a source that exists but could not be bundled, validated
 * or read. Unlike `CATALOG_FAILURE_STATES`, this includes
 * `ValidationFailed` and leaves out `OrphanedBundleOnly`, whose source is
 * gone.
 */
const LOCAL_OVERRIDE_FAILURE_STATES: ReadonlySet<string> = new Set([
  "ValidationFailed",
  "BundleBuildFailed",
  "EntryPointUnreadable",
]);

export class ExtensionLoader {
  private readonly denoRuntime: DenoRuntime;
  private readonly repoDir: string | null;
  /** Symlink-resolved canonical repo root, resolved on first use. */
  private realRepoDir?: string;
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

  /**
   * Discovered files without the kind's export are helper modules imported
   * by entry points (e.g. `models/foo/lib/*.ts`). Skipping them is expected,
   * so the message says what the file is rather than implying a failure.
   */
  private logHelperModuleSkip(file: string): void {
    const kind = this.adapter.kind;
    this.logger
      .debug`Treating ${file} as a helper module (no ${kind} export, so not a ${kind} entry point)`;
  }

  /**
   * Reusing a pulled extension's existing bundle is the normal fast path,
   * not a failure, so it is logged at debug. A failed rebundle is already
   * reported by `bundleWithCache` itself.
   */
  private logTrustedPulledBundle(bundled: BundleResult, file: string): void {
    if (bundled.fromCache && bundled.cacheReason === "trusted-pulled") {
      this.logger.debug`Using existing bundle for pulled extension ${file}`;
    }
  }

  /**
   * Returns true when the caller listed this source as already handled.
   * The check runs before the source is read, so a skipped file costs no
   * read, bundle or import (swamp-club#2355).
   */
  private isSkippedSource(
    baseDir: string,
    file: string,
    skipSourcePaths: ReadonlySet<string> | undefined,
  ): boolean {
    if (!skipSourcePaths || skipSourcePaths.size === 0) return false;
    if (!skipSourcePaths.has(canonicalizePath(resolve(baseDir, file)))) {
      return false;
    }
    this.logger
      .debug`Skipping ${file}: its ${this.adapter.kind} type is already registered`;
    return true;
  }

  async load(
    dir: string,
    options?: {
      skipAlreadyRegistered?: boolean;
      additionalDirs?: string[];
      indexOnly?: boolean;
      /**
       * Canonical absolute source paths to skip without reading, bundling
       * or importing them. The caller must only pass sources whose types
       * are already registered: no type check runs for these paths.
       */
      skipSourcePaths?: ReadonlySet<string>;
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
    const additionalSet = new Set(options?.additionalDirs ?? []);
    for (const d of [dir, ...additionalSet]) {
      try {
        await Deno.stat(d);
      } catch {
        continue;
      }
      const files = await this.discoverFiles(
        d,
        "",
        additionalSet.has(d),
      );
      for (const file of files) {
        allFiles.push({ file, baseDir: d });
      }
    }

    if (options?.indexOnly) {
      for (const { file, baseDir } of allFiles) {
        if (this.isSkippedSource(baseDir, file, options.skipSourcePaths)) {
          continue;
        }
        try {
          const absolutePath = resolve(baseDir, file);
          const source = await Deno.readTextFile(absolutePath);
          if (!this.adapter.exportRegex.test(source)) {
            this.logHelperModuleSkip(file);
            continue;
          }

          const bundled = await this.bundleWithCache(
            absolutePath,
            file,
            denoPath,
            baseDir,
            { trustPulledCache: true },
          );
          this.logTrustedPulledBundle(bundled, file);
          result.loaded.push(file);
        } catch (error) {
          result.failed.push({
            file,
            error: String(error),
            originalError: error,
            baseDir,
          });
        }
      }
      return result;
    }

    const primaryFiles: Array<{
      file: string;
      module: Record<string, unknown>;
      absolutePath: string;
      baseDir: string;
    }> = [];
    const secondaryFiles: Array<{
      file: string;
      module: Record<string, unknown>;
      baseDir: string;
    }> = [];

    for (const { file, baseDir } of allFiles) {
      if (this.isSkippedSource(baseDir, file, options?.skipSourcePaths)) {
        continue;
      }
      try {
        const absolutePath = resolve(baseDir, file);
        const source = await Deno.readTextFile(absolutePath);
        if (!this.adapter.exportRegex.test(source)) {
          this.logHelperModuleSkip(file);
          continue;
        }

        const bundled = await this.bundleWithCache(
          absolutePath,
          file,
          denoPath,
          baseDir,
          { trustPulledCache: true },
        );
        this.logTrustedPulledBundle(bundled, file);
        const module = await this.importBundle(bundled.js, file, baseDir);

        if (module[this.adapter.primaryExportKey]) {
          primaryFiles.push({ file, module, absolutePath, baseDir });
        } else if (
          this.adapter.secondaryExportKey &&
          module[this.adapter.secondaryExportKey]
        ) {
          secondaryFiles.push({ file, module, baseDir });
        }
      } catch (error) {
        result.failed.push({
          file,
          error: String(error),
          originalError: error,
          baseDir,
        });
      }
    }

    const ctx: RegistrationContext = {
      absolutePath: "",
      denoPath,
      denoRuntime: this.denoRuntime,
      repoDir: this.repoDir,
    };

    for (const { file, module, absolutePath, baseDir } of primaryFiles) {
      try {
        const exported = module[this.adapter.primaryExportKey];
        const parsed = this.adapter.validatePrimaryExport(exported);
        if (!parsed.success) {
          const bundlePath = this.getBundlePath(file, dir);
          result.failed.push({
            file,
            error: this.adapter.formatValidationError(parsed.error),
            originalError: new ValidationError(
              this.adapter.formatValidationError(parsed.error),
              bundlePath,
              "",
            ),
            baseDir,
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
            result.failed.push({ file, error: namespaceError, baseDir });
            continue;
          }
        }

        if (this.adapter.hasType(typeNormalized)) {
          if (options?.skipAlreadyRegistered) continue;
          result.failed.push({
            file,
            error:
              `${this.adapter.kind} type '${typeNormalized}' already registered`,
            baseDir,
          });
          continue;
        }

        let fingerprint: string | undefined;
        try {
          fingerprint = await computeSourceFingerprint(absolutePath, baseDir);
        } catch {
          // Non-fatal — fingerprint is best-effort on cold load
        }

        this.adapter.register(
          typeNormalized,
          validated,
          module,
          {
            ...ctx,
            absolutePath,
            extensionName: extractExtensionNameFromPath(
              absolutePath,
              this.repoDir,
            ),
            sourceFingerprint: fingerprint,
          },
        );
        result.loaded.push(file);
      } catch (error) {
        result.failed.push({
          file,
          error: String(error),
          originalError: error,
          baseDir,
        });
      }
    }

    if (this.adapter.processSecondaryExport) {
      // Attach the likely winner first; the outcome does not depend on this
      // order (swamp-club#2562).
      const ranked = secondaryFiles
        .map((f) => ({
          ...f,
          contributor: this.contributorFor(resolve(f.baseDir, f.file)),
        }))
        .sort((a, b) =>
          compareExtensionPrecedence(a.contributor, b.contributor)
        );
      // Extension files in one package often share helper modules.
      const fingerprintCache = createFreshnessCache();
      for (const { file, module, baseDir, contributor } of ranked) {
        let fingerprint: string | undefined;
        try {
          fingerprint = await computeSourceFingerprint(
            resolve(baseDir, file),
            baseDir,
            fingerprintCache,
          );
        } catch {
          // Non-fatal — without a fingerprint the file is not marked
          // attached, so a later attach pass re-imports it.
        }
        try {
          this.adapter.processSecondaryExport(
            file,
            module[this.adapter.secondaryExportKey!],
            result,
            contributor,
            fingerprint === undefined ? undefined : {
              sourcePath: canonicalizePath(resolve(baseDir, file)),
              fingerprint,
            },
          );
        } catch (error) {
          result.failed.push({ file, error: String(error), baseDir });
        }
      }
    }

    return result;
  }

  async buildIndex(
    dir: string,
    options?: { additionalDirs?: string[]; indexOnly?: boolean },
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
        .debug`Catalog invalidated for ${this.adapter.kind} rescan: ${guard.reason}`;
      catalog.invalidate(this.adapter.kind);

      if (guard.reason === "layout-version-mismatch") {
        await this.evictStaleBundles();
      }
    }

    if (catalog.isPopulated(this.adapter.kind)) {
      const scan = await this.scanFreshness(
        dir,
        catalog,
        options?.additionalDirs,
      );
      const staleFiles = scan.stale;
      evictRemovedBundles(scan.removed, catalog);
      // Read after the scan: its own removals may have reset the marker.
      const healPending = !catalog.isTypelessHealDone(
        this.adapter.catalogKinds[0],
      );
      const heal = healPending && !this.hasLiveLocalFailure(catalog);

      if (staleFiles.length === 0 && (!heal || scan.typeless.length === 0)) {
        if (this.repoDir) this.settleTypeConflicts(catalog);
        if (heal) catalog.markTypelessHealDone(this.adapter.catalogKinds[0]);
        this.registerLazyFromCatalog(catalog);
        return result;
      }

      const extensions = repository.loadAll();
      const sourcePathIndex = new Map<string, number>();
      for (let i = 0; i < extensions.length; i++) {
        for (const [loc] of extensions[i].sources) {
          sourcePathIndex.set(loc.canonicalPath, i);
        }
      }

      const kindDir = extensionKindToKindDir(this.adapter.kind);
      const typesNeedingExtensionAttach = new Set<string>();
      // Rows written typeless in this pass: the row that outranked one may
      // give its type up later in the same pass, and they are not in
      // `scan.typeless`, which holds only rows that were already fresh.
      const outrankedRows: TypelessRow[] = [];
      for (const { absolutePath, relativePath, baseDir } of staleFiles) {
        try {
          const { registeredType, extensionTarget, outranked } = await this
            .rebundleAndUpdateCatalog(
              absolutePath,
              relativePath,
              denoPath,
              baseDir,
              catalog,
            );
          if (registeredType) {
            typesNeedingExtensionAttach.add(registeredType);
          }
          if (extensionTarget) {
            typesNeedingExtensionAttach.add(extensionTarget);
          }
          if (outranked) outrankedRows.push(outranked);
          result.loaded.push(relativePath);
        } catch (error) {
          result.failed.push({ file: relativePath, error: String(error) });

          if (this.repoDir) {
            const loc = makeSourceLocation(absolutePath, this.repoDir);
            const extIdx = sourcePathIndex.get(loc.canonicalPath);
            if (extIdx !== undefined) {
              const ext = extensions[extIdx];
              const existingSource = findSourceByPath(
                ext,
                loc.canonicalPath,
              );
              let failFp: string;
              try {
                failFp = await computeSourceFingerprint(absolutePath, baseDir);
              } catch {
                failFp = "";
              }
              const stat = await Deno.stat(absolutePath).catch(() => null);
              const sourceMtime = stat?.mtime?.toISOString() ?? "";
              const failResult = recordSourceFailure({
                extension: ext,
                location: existingSource?.id ?? loc,
                kindDir,
                error,
                existingSource,
                fingerprint: failFp,
                sourceMtime,
              });
              extensions[extIdx] = failResult.extension;
              repository.saveAll([failResult.extension]);
            }
          }
        }
      }

      if (this.repoDir) {
        this.settleTypeConflicts(catalog);
      }

      // Checked again: a rebundle in this pass may have just recorded a
      // local failure, fixed the one that blocked the heal above, or
      // re-armed the heal by changing the type a row claims.
      if (
        !catalog.isTypelessHealDone(this.adapter.catalogKinds[0]) &&
        !this.hasLiveLocalFailure(catalog)
      ) {
        await this.healTypelessRows(catalog, [
          ...scan.typeless,
          ...outrankedRows,
        ]);
        catalog.markTypelessHealDone(this.adapter.catalogKinds[0]);
      }

      if (this.adapter.attachPendingExtensionsForType) {
        for (const type of typesNeedingExtensionAttach) {
          await this.adapter.attachPendingExtensionsForType(
            type,
            catalog,
            (paths) => this.importBundleByPath(paths),
            (sourcePath) => this.contributorFor(sourcePath),
          );
        }
      }

      this.registerLazyFromCatalog(catalog);
      return result;
    }

    const fullResult = await this.load(dir, {
      additionalDirs: options?.additionalDirs,
      skipAlreadyRegistered: true,
      indexOnly: options?.indexOnly,
    });

    if (fullResult.failed.length > 0 && this.repoDir) {
      const coldExtensions = repository.loadAll();
      const coldIndex = new Map<string, number>();
      for (let i = 0; i < coldExtensions.length; i++) {
        for (const [loc] of coldExtensions[i].sources) {
          coldIndex.set(loc.canonicalPath, i);
        }
      }

      let localFallback: import("./extension.ts").Extension | undefined;
      const kindDir = extensionKindToKindDir(this.adapter.kind);
      for (const failure of fullResult.failed) {
        const resolveDir = failure.baseDir ?? dir;
        const absolutePath = resolve(resolveDir, failure.file);
        const loc = makeSourceLocation(absolutePath, this.repoDir);
        const extIdx = coldIndex.get(loc.canonicalPath);
        let ext = extIdx !== undefined ? coldExtensions[extIdx] : undefined;

        if (!ext) {
          localFallback ??= makeLocalExtension({
            repoRoot: this.repoDir,
            basename: this.adapter.kind,
          });
          ext = localFallback;
        }

        const existingSource = findSourceByPath(ext, loc.canonicalPath);
        if (
          existingSource &&
          existingSource.state.tag !== "Indexed" &&
          existingSource.state.tag !== "Bundled"
        ) {
          continue;
        }

        let failFp: string;
        try {
          failFp = await computeSourceFingerprint(absolutePath, resolveDir);
        } catch {
          failFp = "";
        }
        const stat = await Deno.stat(absolutePath).catch(() => null);
        const sourceMtime = stat?.mtime?.toISOString() ?? "";

        const failResult = recordSourceFailure({
          extension: ext,
          location: existingSource?.id ?? loc,
          kindDir,
          error: failure.originalError ?? new Error(failure.error),
          existingSource,
          fingerprint: failFp,
          sourceMtime,
        });

        if (extIdx !== undefined) {
          coldExtensions[extIdx] = failResult.extension;
        } else {
          localFallback = failResult.extension;
        }
      }

      const toSave = [
        ...new Map(
          coldExtensions.map((e) => [`${e.name}::${e.version}`, e]),
        ).values(),
      ];
      if (localFallback) toSave.push(localFallback);
      if (toSave.length > 0) {
        repository.saveAll(toSave);
      }
    }

    await this.populateCatalogFromRegistry(
      catalog,
      dir,
      options?.additionalDirs,
    );
    // The same unseen-row removal the warm path applies, so rows the
    // scan no longer reaches (an old pulled root, an extension that is
    // no longer installed) do not outlive a cold pass (swamp-club#2490).
    const additionalSet = new Set(options?.additionalDirs ?? []);
    const seen = await collectSeenSources(
      [dir, ...(options?.additionalDirs ?? [])],
      (d) => this.discoverFiles(d, "", additionalSet.has(d)),
    );
    const removedUnseen = removeUnseenCatalogRows(
      catalog,
      this.adapter.catalogKinds.flatMap((k) => catalog.findByKind(k)),
      seen,
    );
    evictRemovedBundles(removedUnseen, catalog);
    if (this.repoDir) {
      this.settleTypeConflicts(catalog);
    }
    if (options?.indexOnly) {
      this.registerLazyFromCatalog(catalog);
    }
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

  async loadSingleType(
    typeNormalized: string,
    lazyEntry?: {
      bundlePath: string;
      sourcePath: string;
      sourceFingerprint?: string;
    },
  ): Promise<void> {
    const catalog = this.requireRepository("loadSingleType").getCatalogStore();
    installZodGlobal();

    const kind = this.adapter.catalogKinds[0];
    // Use the in-memory lazy entry when available — avoids a SQLite read
    // that contends under concurrent process startups.
    let entry:
      | {
        type_normalized: string;
        bundle_path: string;
        source_path: string;
        source_fingerprint?: string;
      }
      | undefined = lazyEntry
        ? {
          type_normalized: typeNormalized,
          bundle_path: lazyEntry.bundlePath,
          source_path: lazyEntry.sourcePath,
          source_fingerprint: lazyEntry.sourceFingerprint,
        }
        : catalog.findByType(typeNormalized, kind);
    if (!entry) {
      throw new Error(
        `No catalog entry for ${this.adapter.kind} type: ${typeNormalized}`,
      );
    }

    // A row whose source is gone must never be imported: its bundle, if
    // any, is old code, and rebuilding a missing bundle fails with ENOENT
    // (swamp-club#2490). Drop such rows until a live one turns up; with
    // none left, return so the registry reports the type as not found.
    // Bounded by the rows claiming the type, so a delete that silently
    // fails cannot loop forever. They are counted only once a source is
    // missing, so the common case adds no SQLite read to a lazy load.
    let remaining: number | undefined;
    while (!this.sourceExistsOnDisk(entry.source_path)) {
      remaining ??= catalog.findAllByType(typeNormalized, kind).length + 1;
      this.logger
        .debug`Dropping catalog row for ${typeNormalized}: source ${entry.source_path} is missing`;
      catalog.removeByRawSourcePath(entry.source_path);
      evictRemovedBundles([entry], catalog);
      entry = --remaining > 0
        ? catalog.findByType(typeNormalized, kind)
        : undefined;
      if (!entry) return;
    }

    await this.importAndRegisterBundle(entry);

    if (!this.adapter.isFullyLoaded(typeNormalized)) {
      catalog.removeBySourcePath(entry.source_path);
      return;
    }

    if (this.adapter.findExtensionsForType) {
      const extensions = this.adapter.findExtensionsForType(
        catalog,
        typeNormalized,
      )
        .map((ext) => ({
          ext,
          contributor: this.contributorFor(ext.source_path),
        }))
        .sort((a, b) =>
          compareExtensionPrecedence(a.contributor, b.contributor)
        );
      for (const { ext, contributor } of extensions) {
        if (this.adapter.importAndExtendBundle) {
          // One extension that fails to import must not take down its base
          // type or the extensions after it (swamp-club#2557).
          try {
            await this.adapter.importAndExtendBundle(
              ext,
              (paths) => this.importBundleByPath(paths),
              { loaded: [], extended: [], failed: [] },
              contributor,
            );
          } catch (error) {
            this.logger
              .warn`Skipping extension ${ext.source_path} for ${typeNormalized}: ${error}`;
          }
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
      (sourcePath) => this.contributorFor(sourcePath),
    );
  }

  /**
   * Ranks an extension source for member-collision resolution
   * (swamp-club#2562). Pulled means under one of this repo's
   * pulled-extension roots; the rule needs only the repo root, so every
   * loader instance — cold start, hot load, serve reload — ranks a file
   * the same way.
   */
  private contributorFor(sourcePath: string): ExtensionContributor {
    const canonical = canonicalizePath(sourcePath);
    // Identity is the symlink-resolved path, so one file reached under two
    // spellings of the repo root (`/tmp/r` from catalog rows, `/private/tmp/r`
    // from a directory walk on macOS) is one contributor, not two that
    // collide with each other.
    const real = realCanonicalPath(canonical);
    return {
      sourcePath: real,
      pulled: this.repoDir !== null && this.isPulledSource(canonical, real),
    };
  }

  /**
   * A source is pulled when either spelling of it sits under either
   * spelling of the repo root's pulled roots. Mirrors the realpath fallback
   * in {@link extractExtensionNameFromPath}.
   */
  private isPulledSource(canonical: string, real: string): boolean {
    const repoDir = this.repoDir!;
    const roots = [canonicalizePath(repoDir)];
    this.realRepoDir ??= realCanonicalPath(roots[0]);
    if (this.realRepoDir !== roots[0]) roots.push(this.realRepoDir);
    return roots.some((root) =>
      isPulledExtensionPath(canonical, root) ||
      isPulledExtensionPath(real, root)
    );
  }

  public async bundleAndIndexOne(args: {
    absolutePath: string;
    relativePath: string;
    baseDir: string;
    trustPulledCache?: boolean;
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
      { trustPulledCache: args.trustPulledCache },
    );
    const fingerprint = await computeSourceFingerprint(
      args.absolutePath,
      args.baseDir,
    );
    const module = await this.importBundle(
      js,
      args.relativePath,
      args.baseDir,
      fingerprint,
    );

    if (module[this.adapter.primaryExportKey]) {
      const parsed = this.adapter.validatePrimaryExport(
        module[this.adapter.primaryExportKey],
      );
      if (!parsed.success) {
        throw new ValidationError(
          this.adapter.formatValidationError(parsed.error),
          this.getBundlePath(args.relativePath, args.baseDir),
          fingerprint,
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
        throw new ValidationError(
          parsed.error.message,
          this.getBundlePath(args.relativePath, args.baseDir),
          fingerprint,
        );
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
      source_fingerprint?: string;
    },
  ): Promise<void> {
    if (this.adapter.isFullyLoaded(entry.type_normalized)) return;

    const module = await this.importBundleByPath({
      bundlePath: entry.bundle_path,
      sourcePath: entry.source_path,
      sourceFingerprint: entry.source_fingerprint || undefined,
    });

    const exportKey = this.adapter.primaryExportKey;
    if (!module[exportKey]) {
      this.logger
        .warn`Skipping bundle with no ${exportKey} export: ${entry.bundle_path}`;
      return;
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
        extensionName: extractExtensionNameFromPath(
          entry.source_path,
          this.repoDir,
        ),
        sourceFingerprint: entry.source_fingerprint || undefined,
      },
    );
  }

  async importBundleByPath(
    paths: {
      bundlePath: string;
      sourcePath: string;
      sourceFingerprint?: string;
    },
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
    const importUrl = await bundleImportUrl(
      paths.bundlePath,
      js,
      paths.sourceFingerprint,
    );
    return await import(importUrl);
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
      env: this.denoRuntime.getDenoEnv(),
    });
    await Deno.mkdir(dirname(paths.bundlePath), { recursive: true });
    await Deno.writeTextFile(paths.bundlePath, js);
    this.logger
      .info`Recovered missing bundle for ${paths.sourcePath} on demand`;
    return js;
  }

  /**
   * True when another live row already claims `typeNormalized` and wins
   * it over `sourcePath`: local outranks pulled, a pulled row that already
   * holds the type keeps it against another pulled row, and two locals
   * fall back to the smaller path.
   */
  private isOutrankedForType(
    catalog: ExtensionCatalogStore,
    typeNormalized: string,
    sourcePath: string,
  ): boolean {
    const self = this.contributorFor(sourcePath);
    return catalog.findAllByType(typeNormalized, this.adapter.catalogKinds[0])
      .some((row) => {
        if ((row.state ?? "Indexed") === "Tombstoned") return false;
        const other = this.contributorFor(row.source_path);
        if (other.sourcePath === self.sourcePath) return false;
        // The incumbent keeps it, so pulling another extension that
        // provides the same type never takes it away.
        if (self.pulled && other.pulled) return true;
        return compareExtensionPrecedence(other, self) < 0;
      });
  }

  /**
   * Settles every type conflict the loader's own catalog writes can
   * leave: pulled-vs-pulled first, keeping the earliest-indexed row, then
   * pulled-vs-local, where local wins. In that order a local override
   * always ends up the only claimant, however many pulled rows were typed
   * the same (swamp-club#2490). Two different pulled extensions claiming
   * one type are reported, since that choice is made silently here.
   */
  private settleTypeConflicts(catalog: ExtensionCatalogStore): void {
    if (!this.repoDir) return;
    for (
      const { winner, winnerName, loserName } of catalog
        .settlePulledTypeConflicts(this.repoDir)
    ) {
      // Without both names there is no extension to tell the user to rm.
      if (winnerName && loserName && winnerName !== loserName) {
        this.logger
          .warn`Extensions ${winnerName} and ${loserName} both provide ${winner.kind} type ${winner.type_normalized}; keeping ${winnerName}, which provided it first. To use ${loserName} instead, run 'swamp extension rm ${winnerName}'`;
      }
    }
    catalog.resolveOriginConflicts(this.repoDir);
  }

  /**
   * Restores the type of Indexed rows that claim none (swamp-club#2490).
   * A row's type is cleared while another row claims it; once that row is
   * gone the type is never re-derived, because the row's fingerprint still
   * matches. Each row's EXISTING bundle is imported to learn its exported
   * type (this works for wrapped exports, which source-text extraction
   * misses), and the type is written back only when no row claims it,
   * for at most one row per type, chosen by
   * {@link compareExtensionPrecedence}: a local row before a pulled one,
   * then the smallest canonical path, the Extension aggregate's I2
   * tie-break.
   *
   * Catalog-only: nothing is registered here, so a pulled row can never
   * take a type from a local override in the registry, and a failure
   * leaves the row as it was.
   *
   * Callers skip the heal, leaving its marker unset, while
   * {@link hasLiveLocalFailure} holds: a failed row claims no type, so a
   * broken local override would otherwise hand its type to the pulled
   * row it shadows.
   */
  private async healTypelessRows(
    catalog: ExtensionCatalogStore,
    typeless: readonly TypelessRow[],
  ): Promise<void> {
    const kind = this.adapter.catalogKinds[0];
    const candidates = new Map<string, string[]>();
    for (const { absolutePath, row } of typeless) {
      if (!row.bundle_path) continue;
      let typeNormalized: string;
      try {
        const module = await this.importBundleByPath({
          bundlePath: row.bundle_path,
          sourcePath: absolutePath,
          sourceFingerprint: row.source_fingerprint || undefined,
        });
        const exported = module[this.adapter.primaryExportKey];
        if (!exported) continue;
        const parsed = this.adapter.validatePrimaryExport(exported);
        if (!parsed.success) continue;
        typeNormalized = this.adapter.normalizeType(
          parsed.data as Record<string, unknown>,
        );
      } catch (error) {
        this.logger
          .debug`Could not revalidate typeless catalog row ${row.source_path}: ${error}`;
        continue;
      }
      const rows = candidates.get(typeNormalized);
      if (rows) rows.push(row.source_path);
      else candidates.set(typeNormalized, [row.source_path]);
    }

    for (const [typeNormalized, sourcePaths] of candidates) {
      const [{ sourcePath: winner }] = sourcePaths
        .map((sourcePath) => ({
          sourcePath,
          contributor: this.contributorFor(sourcePath),
        }))
        .sort((a, b) =>
          compareExtensionPrecedence(a.contributor, b.contributor)
        );
      // Check and write together, so two processes cannot each restore
      // a different candidate.
      catalog.runInTransaction(() => {
        if (catalog.findByType(typeNormalized, kind)) return;
        catalog.setTypeNormalized(winner, typeNormalized);
      });
    }
  }

  /**
   * True when a local row of this kind is in a failed state and its source
   * still exists. Its type is unknown — failed rows claim none — so it may
   * be the override of any typeless pulled row, and the typeless-row heal
   * must wait until it is fixed or removed (swamp-club#2490).
   */
  private hasLiveLocalFailure(catalog: ExtensionCatalogStore): boolean {
    return catalog.findByKind(this.adapter.catalogKinds[0]).some((row) =>
      LOCAL_OVERRIDE_FAILURE_STATES.has(row.state ?? "Indexed") &&
      !this.contributorFor(row.source_path).pulled &&
      this.sourceExistsOnDisk(row.source_path)
    );
  }

  private registerLazyFromCatalog(catalog: ExtensionCatalogStore): void {
    const skippedExtensions = new Set<string>();
    for (const kind of this.adapter.catalogKinds) {
      if (kind !== this.adapter.catalogKinds[0]) continue;
      const entries = catalog.findByKind(kind);
      for (const entry of entries) {
        if (
          entry.state === "ValidationFailed" ||
          entry.state === "BundleBuildFailed"
        ) {
          if (!this.sourceExistsOnDisk(entry.source_path)) continue;
          const name = entry.extension_name || entry.type_normalized;
          if (name && !skippedExtensions.has(name)) {
            skippedExtensions.add(name);
          }
          continue;
        }
        if (!entry.type_normalized) continue;
        this.adapter.registerLazy(entry);
      }
    }
    for (const name of skippedExtensions) {
      this.logger
        .warn`Extension ${name} has broken bundles and is not available. Run 'swamp doctor extensions --repair' or 'swamp extension pull ${name} --force' to fix.`;
    }
  }

  private sourceExistsOnDisk(sourcePath: string): boolean {
    try {
      Deno.statSync(sourcePath);
      return true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) return true;
      return false;
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
    const additionalSet = new Set(additionalDirs ?? []);
    const otherSpellings: OtherSpellingRows = {};

    const dirs = [dir, ...additionalSet];
    for (const d of dirs) {
      try {
        await this.populateCatalogFromDir(
          d,
          bundleBaseDir,
          catalog,
          cache,
          otherSpellings,
          additionalSet.has(d),
        );
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
    otherSpellings: OtherSpellingRows,
    includeTestFiles = false,
  ): Promise<void> {
    const files = this.discoverFilesSync(dir, "", includeTestFiles);
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

        // A fingerprint failure must not hide the extraction warning below,
        // so it only disables the indexed-row shortcut.
        const sourceFingerprint = await computeSourceFingerprint(
          absolutePath,
          dir,
          cache,
        ).catch(() => undefined);

        // Startup reconcile indexes sources by importing their bundles, so
        // a row it wrote holds the export's real type — including exports
        // the static extractor cannot read, such as a wrapped
        // `export const extension = withOptions(definition)`. Keep an
        // up-to-date row's type instead of re-deriving it from source text
        // (swamp-club#2562). The bundle location can still have moved (a
        // layout or datastore change), so refresh that. The row may have
        // been written under another spelling of the repo root (`/tmp/r`
        // vs `/private/tmp/r` on macOS), which changes the source-dirs
        // fingerprint and forces this rebuild (swamp-club#2570). An exact
        // row without a usable type (tombstoned, or cleared by origin
        // conflict resolution) does not hide one under the other spelling.
        const sourcePath = canonicalizePath(absolutePath);
        const exact = catalog.findBySourcePath(absolutePath);
        const existing = exact !== undefined && isIndexedRow(exact)
          ? exact
          : this.findRowUnderOtherSpelling(
            catalog,
            sourcePath,
            otherSpellings,
          ) ?? exact;
        const indexed = existing !== undefined && isIndexedRow(existing);
        if (
          indexed && sourceFingerprint !== undefined &&
          existing.source_fingerprint === sourceFingerprint
        ) {
          if (existing.source_path !== sourcePath) {
            // Move the row to this spelling, as the next warm scan would
            // when it drops rows for paths it no longer sees. Moving it
            // keeps one row per file, so no second row claims its type.
            const moved = {
              ...existing,
              source_path: sourcePath,
              bundle_path: bundlePath,
              source_mtime: sourceStat.mtime?.toISOString() ?? "",
              extension_name: existing.extension_name ?? "",
              extension_version: existing.extension_version ?? "",
            };
            catalog.runInTransaction(() => {
              catalog.removeByRawSourcePath(existing.source_path);
              catalog.upsertWithIdentity(moved);
            });
            // A second spelling of the file later in this pass must match
            // the moved row, not the one just removed.
            otherSpellings.rows?.set(realCanonicalPath(sourcePath), moved);
          } else if (existing.bundle_path !== bundlePath) {
            catalog.upsert({
              ...existing,
              bundle_path: bundlePath,
              source_mtime: sourceStat.mtime?.toISOString() ?? "",
            });
          }
          continue;
        }

        const extracted = this.adapter.extractTypeFromSource(source);
        if (!extracted) {
          // A stale indexed row is refreshed by the next stale-file scan,
          // which imports the bundle; only warn when nothing indexed it.
          if (!indexed) {
            emitTypeExtractionFailure(absolutePath, this.adapter.kind);
          }
          continue;
        }
        // As before, a file whose fingerprint cannot be computed is not
        // indexed from source text.
        if (sourceFingerprint === undefined) continue;

        catalog.upsert({
          type_normalized: extracted.typeNormalized,
          kind: extracted.kind,
          bundle_path: bundlePath,
          source_path: sourcePath,
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

  /**
   * The indexed row for `sourcePath` written under another spelling of the
   * same file, matched on the symlink-resolved path in either direction.
   * Rows under the loader's own spelling of the repo root are left out:
   * the exact lookup already covers them, so a catalog with no other
   * spelling costs no realpath calls.
   */
  private findRowUnderOtherSpelling(
    catalog: ExtensionCatalogStore,
    sourcePath: string,
    otherSpellings: OtherSpellingRows,
  ): ExtensionTypeRow | undefined {
    if (!this.repoDir) return undefined;
    if (!otherSpellings.rows) {
      const root = canonicalizePath(resolve(this.repoDir));
      const prefix = root.endsWith("/") ? root : root + "/";
      const kinds = new Set<string>(this.adapter.catalogKinds);
      otherSpellings.rows = new Map();
      for (const row of catalog.findAll()) {
        if (!kinds.has(row.kind) || !isIndexedRow(row)) continue;
        const canonical = canonicalizePath(row.source_path);
        if (canonical.startsWith(prefix)) continue;
        otherSpellings.rows.set(realCanonicalPath(canonical), row);
      }
    }
    if (otherSpellings.rows.size === 0) return undefined;
    return otherSpellings.rows.get(realCanonicalPath(sourcePath));
  }

  private async rebundleAndUpdateCatalog(
    absolutePath: string,
    relativePath: string,
    denoPath: string,
    baseDir: string,
    catalog: ExtensionCatalogStore,
  ): Promise<
    {
      registeredType?: string;
      extensionTarget?: string;
      outranked?: TypelessRow;
    }
  > {
    const source = await Deno.readTextFile(absolutePath);
    if (!this.adapter.exportRegex.test(source)) {
      return {};
    }

    const bundled = await this.bundleWithCache(
      absolutePath,
      relativePath,
      denoPath,
      baseDir,
    );
    const { js } = bundled;

    const stat = await Deno.stat(absolutePath);
    const sourceMtime = stat.mtime?.toISOString() ?? "";
    const sourceFingerprint = await computeSourceFingerprint(
      absolutePath,
      baseDir,
    );

    let effectiveFingerprint = sourceFingerprint;
    if (bundled.fromCache) {
      const existing = catalog.findBySourcePath(absolutePath);
      if (existing?.source_fingerprint) {
        if (existing.source_fingerprint !== sourceFingerprint) {
          // An unexpected rebundle failure was already warned about, with
          // its error, inside bundleWithCache. An expected one was only
          // logged at debug there, so this is its one warning.
          if (
            bundled.cacheReason === "rebundle-failed" &&
            bundled.expectedFailure
          ) {
            this.logger
              .warn`Bundle could not be regenerated for ${relativePath} — source fingerprint preserved, will retry on next command`;
          } else if (bundled.cacheReason === "rebundle-failed") {
            this.logger
              .debug`Bundle could not be regenerated for ${relativePath} — source fingerprint preserved, will retry on next command`;
          } else {
            this.logger
              .debug`Using trusted bundle for pulled extension ${relativePath} — source fingerprint preserved`;
          }
        }
        effectiveFingerprint = existing.source_fingerprint;
      }
    }

    const module = await this.importBundle(
      js,
      relativePath,
      baseDir,
      effectiveFingerprint,
    );

    const exportKey = this.adapter.primaryExportKey;

    if (module[exportKey]) {
      const bundlePath = this.getBundlePath(relativePath, baseDir);
      const parsed = this.adapter.validatePrimaryExport(module[exportKey]);
      if (!parsed.success) {
        throw new ValidationError(
          this.adapter.formatValidationError(parsed.error),
          bundlePath,
          effectiveFingerprint,
        );
      }
      const validated = parsed.data as Record<string, unknown>;
      const typeNormalized = this.adapter.normalizeType(validated);
      // Never write a type another row outranks this one for: two pulled
      // rows sharing a type would make every later save fail I-Repo-1
      // before the settle step runs (swamp-club#2490).
      const outranked = this.isOutrankedForType(
        catalog,
        typeNormalized,
        absolutePath,
      );

      catalog.upsert({
        type_normalized: outranked ? "" : typeNormalized,
        kind: this.adapter.catalogKinds[0],
        bundle_path: bundlePath,
        source_path: canonicalizePath(absolutePath),
        version: String(validated.version ?? ""),
        description: String(validated.description ?? ""),
        extends_type: "",
        source_mtime: sourceMtime,
        source_fingerprint: effectiveFingerprint,
        state: "Indexed",
      });

      if (outranked) {
        return {
          outranked: {
            absolutePath,
            relativePath,
            baseDir,
            row: {
              source_path: canonicalizePath(absolutePath),
              bundle_path: bundlePath,
              source_fingerprint: effectiveFingerprint,
              type_normalized: "",
            },
          },
        };
      }
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
            extensionName: extractExtensionNameFromPath(
              absolutePath,
              this.repoDir,
            ),
            sourceFingerprint: effectiveFingerprint,
          },
        );
      } else if (this.adapter.updateSourceFingerprint) {
        this.adapter.updateSourceFingerprint(
          typeNormalized,
          effectiveFingerprint,
        );
      }

      return { registeredType: typeNormalized };
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
        throw new ValidationError(
          parsed.error.message,
          bundlePath,
          effectiveFingerprint,
        );
      }
      const validated = parsed.data as Record<string, unknown>;
      const typeNormalized = this.adapter.normalizeType(validated);

      catalog.upsert({
        type_normalized: typeNormalized,
        kind: this.adapter.catalogKinds[1] ?? this.adapter.catalogKinds[0],
        bundle_path: bundlePath,
        source_path: canonicalizePath(absolutePath),
        version: "",
        description: "",
        extends_type: typeNormalized,
        source_mtime: sourceMtime,
        source_fingerprint: effectiveFingerprint,
        state: "Indexed",
      });

      return { extensionTarget: typeNormalized };
    }

    return {};
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

  private async evictStaleBundles(): Promise<void> {
    const bundleDir = this.resolveBundlePath();
    if (!bundleDir) return;
    try {
      await Deno.remove(bundleDir, { recursive: true });
      this.logger
        .info`Evicted stale bundles for ${this.adapter.kind}: ${bundleDir}`;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        this.logger
          .warn`Failed to evict stale bundles for ${this.adapter.kind}: ${error}`;
      }
    }
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
    options?: { trustPulledCache?: boolean },
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

      const resolvedBoundary = resolve(boundaryDir);
      const isPulled = this.repoDir && (
        resolvedBoundary.startsWith(
          join(resolve(this.repoDir), SWAMP_DATA_DIR, "pulled-extensions") +
            SEPARATOR,
        ) || resolvedBoundary.startsWith(
          join(
            resolve(this.repoDir),
            SWAMP_DATA_DIR,
            "config",
            "pulled-extensions",
          ) + SEPARATOR,
        )
      );
      if (
        bundleExists && isPulled &&
        (options?.trustPulledCache ||
          isExpectedBundleFailure(absolutePath, this.repoDir))
      ) {
        return {
          js: await Deno.readTextFile(bundlePath),
          fromCache: true,
          cacheReason: "trusted-pulled",
        };
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
          env: this.denoRuntime.getDenoEnv(),
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
            return {
              js: cached,
              fromCache: true,
              cacheReason: "rebundle-failed",
              expectedFailure: expected,
            };
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
      env: this.denoRuntime.getDenoEnv(),
    });
    return { js, fromCache: false };
  }

  private async importBundle(
    js: string,
    relativePath: string,
    baseDir?: string,
    sourceFingerprint?: string,
  ): Promise<Record<string, unknown>> {
    const rewritten = fixCjsEsmInterop(rewriteZodImports(js));

    if (this.repoDir) {
      const ns = baseDir ? bundleNamespace(baseDir, this.repoDir) : "";
      const segments = ns
        ? [ns, relativePath.replace(/\.ts$/, ".js")]
        : [relativePath.replace(/\.ts$/, ".js")];
      const bundlePath = this.resolveBundlePath(...segments);

      let importUrl: string | undefined;
      try {
        await Deno.stat(bundlePath);
        let cachedJs = await Deno.readTextFile(bundlePath);
        const fixed = fixCjsEsmInterop(rewriteZodImports(cachedJs));
        if (fixed !== cachedJs) {
          cachedJs = fixed;
          await Deno.writeTextFile(bundlePath, cachedJs);
        }
        importUrl = await bundleImportUrl(
          bundlePath,
          cachedJs,
          sourceFingerprint,
        );
      } catch (error) {
        this.logger.debug`Bundle file not available for ${relativePath}: ${
          String(error).substring(0, 200)
        }`;
      }

      if (importUrl) {
        return await import(importUrl);
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

  private async scanFreshness(
    dir: string,
    catalog: ExtensionCatalogStore,
    additionalDirs?: string[],
  ): Promise<FreshnessScan> {
    const additionalSet = new Set(additionalDirs ?? []);
    return await scanCatalogFreshness({
      modelsDir: dir,
      additionalDirs,
      catalog,
      discoverFiles: (d) => this.discoverFiles(d, "", additionalSet.has(d)),
      kinds: [...this.adapter.catalogKinds],
    });
  }

  private discoverFilesSync(
    dir: string,
    prefix = "",
    includeTestFiles = false,
  ): string[] {
    const files: string[] = [];
    for (const entry of Deno.readDirSync(dir)) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory) {
        if (entry.name.startsWith("_")) continue;
        files.push(
          ...this.discoverFilesSync(
            join(dir, entry.name),
            relativePath,
            includeTestFiles,
          ),
        );
      } else if (
        entry.isFile && entry.name.endsWith(".ts") &&
        (includeTestFiles || !entry.name.endsWith("_test.ts"))
      ) {
        files.push(relativePath);
      }
    }
    return files.sort();
  }

  private async discoverFiles(
    dir: string,
    prefix = "",
    includeTestFiles = false,
  ): Promise<string[]> {
    const files: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory) {
        if (entry.name.startsWith("_")) continue;
        const nested = await this.discoverFiles(
          join(dir, entry.name),
          relativePath,
          includeTestFiles,
        );
        files.push(...nested);
      } else if (
        entry.isFile && entry.name.endsWith(".ts") &&
        (includeTestFiles || !entry.name.endsWith("_test.ts"))
      ) {
        files.push(relativePath);
      }
    }
    return files.sort();
  }
}
