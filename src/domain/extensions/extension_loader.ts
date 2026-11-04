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
  StaleLockfileError,
  uint8ArrayToBase64,
} from "../models/bundle.ts";
import {
  configuredLockPath,
  frozenLockPath,
} from "./dependency_resolution/extension_project.ts";
import { computeChecksum } from "../models/checksum.ts";
import { declaresExport } from "./export_declaration.ts";
import {
  type BundleResult,
  collectSeenSources,
  computeSourceFingerprint,
  createFreshnessCache,
  type FreshnessCache,
  type FreshnessScan,
  MAX_SOURCE_MODULES,
  removeUnseenCatalogRows,
  scanCatalogFreshness,
  type SourceModuleLookup,
  type TypelessRow,
} from "./bundle_freshness.ts";
import {
  captureSourceSnapshot,
  type SourceSnapshot,
} from "./source_snapshot.ts";
import type { ModuleGraphReaderFactory } from "./extension_source_graph.ts";
import { resolveLocalImports } from "../models/local_import_resolver.ts";
import {
  BUNDLE_LAYOUT_VERSION,
  type ExtensionCatalogStore,
  type ExtensionTypeRow,
  sourceDirsFingerprint,
  warnPulledTypeConflicts,
} from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import {
  bundleNamespace,
  SWAMP_DATA_DIR,
} from "../../infrastructure/persistence/paths.ts";
import { assertSafePath } from "../../infrastructure/persistence/safe_path.ts";
import { emitTypeExtractionFailure } from "../../infrastructure/logging/extension_load_warnings.ts";
import {
  canonicalizePath,
  realCanonicalPath,
} from "../../infrastructure/persistence/canonicalize_path.ts";
import { evictRemovedBundles } from "./bundle_eviction.ts";
import type { DatastorePathResolver } from "../datastore/datastore_path_resolver.ts";
import {
  type BundleIndexResult,
  type ExtensionLoadResult,
  type KindAdapter,
  primaryExport,
  primaryExportNames,
  type RegistrationContext,
} from "./kind_adapter.ts";
import { ValidationError } from "./validation_error.ts";
import {
  type BundleProber,
  type BundleProbeResult,
  describeProbeFailure,
  ProbeFailedError,
} from "./bundle_prober.ts";
import { DuplicateTypeUserError } from "./duplicate_type_user_error.ts";
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
import { isStagingEntryName } from "./install_journal.ts";
import { markErrorPaths } from "../errors.ts";

/**
 * the ES module registry never evicts modules, so identical bundle bytes map to
 * one URL: an unchanged bundle reuses the cached module, a changed one gets a
 * new URL; bundleJs must be the on-disk text
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

function isIndexedRow(row: ExtensionTypeRow): boolean {
  return (row.state ?? "Indexed") !== "Tombstoned" &&
    row.type_normalized.length > 0;
}

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
 * unlike CATALOG_FAILURE_STATES this includes ValidationFailed and leaves out
 * OrphanedBundleOnly, whose source is gone
 */
const LOCAL_OVERRIDE_FAILURE_STATES: ReadonlySet<string> = new Set([
  "ValidationFailed",
  "BundleBuildFailed",
  "EntryPointUnreadable",
]);

/** local directories are scanned like the primary directory, without test files */
function testFileDirsOf(
  additionalDirs: readonly string[] | undefined,
  localDirs: readonly string[],
): ReadonlySet<string> {
  const local = new Set(localDirs);
  return new Set((additionalDirs ?? []).filter((d) => !local.has(d)));
}

const NO_RECORDED_SOURCE_MODULES: SourceModuleLookup = {
  findSourceModules: () => undefined,
};

export interface RefreshedSource {
  sourcePath: string;
  previousType?: string;
  type?: string;
  extendsType?: string;
}

export interface FailedRefreshSource {
  sourcePath: string;
  previousType?: string;
  extendsType?: string;
  error: string;
}

export interface RemovedRefreshSource {
  sourcePath: string;
  kind?: string;
  type?: string;
}

export interface SourceRefreshChanges {
  rebundled: RefreshedSource[];
  failed: FailedRefreshSource[];
  removed: RemovedRefreshSource[];
}

export class ExtensionLoader {
  private readonly denoRuntime: DenoRuntime;
  private readonly repoDir: string | null;
  private realRepoDir?: string;
  private mountPrefixes?: readonly (readonly string[])[];
  private readonly datastoreResolver?: DatastorePathResolver;
  private readonly repository?: ExtensionRepository;
  private readonly adapter: KindAdapter;
  private readonly logger;
  /**
   * when set, indexing probes a bundle in isolation and registers its type
   * lazy, so nothing a source does at import runs in this isolate until used;
   * without it the loader imports in-process
   */
  private readonly bundleProber: BundleProber | undefined;
  /**
   * lets a fingerprint cover every local module the bundle includes; without
   * one, the relative imports within the kind's directory stand in
   */
  private readonly moduleGraphReader: ModuleGraphReaderFactory | undefined;

  /** Catalog source state last applied by this loader, not by another CLI. */
  private appliedSourceRows = new Map<string, ExtensionTypeRow>();

  constructor(
    denoRuntime: DenoRuntime,
    adapter: KindAdapter,
    repoDir: string | null = null,
    datastoreResolver?: DatastorePathResolver,
    repository?: ExtensionRepository,
    bundleProber?: BundleProber,
    moduleGraphReader?: ModuleGraphReaderFactory,
  ) {
    this.bundleProber = bundleProber;
    this.moduleGraphReader = moduleGraphReader;
    this.denoRuntime = denoRuntime;
    this.adapter = adapter;
    this.repoDir = repoDir;
    this.datastoreResolver = datastoreResolver;
    this.repository = repository;
    this.logger = getLogger(["swamp", adapter.kind, "loader"]);
    this.appliedSourceRows = this.localSourceRows();
  }

  private sourceModules(): SourceModuleLookup {
    return this.repository?.getCatalogStore() ?? NO_RECORDED_SOURCE_MODULES;
  }

  /**
   * lets a long-lived process tell when the source changed under it; undefined
   * when the files cannot be read
   */
  private async sourceSnapshot(
    absolutePath: string,
    modules: SourceModuleLookup = this.sourceModules(),
  ): Promise<SourceSnapshot | undefined> {
    try {
      return await captureSourceSnapshot(absolutePath, modules);
    } catch {
      return undefined;
    }
  }

  /**
   * an unreadable graph is retried once (the fallback marks the source stale
   * for the next warm scan unless this bundle was the retry); a catalog error
   * forgets the recorded list instead of failing the good bundle
   */
  private async recordSourceModules(
    absolutePath: string,
    boundaryDir: string,
    denoPath: string,
    denoConfigPath: string | undefined,
    graphRetry: boolean,
  ): Promise<void> {
    const catalog = this.repository?.getCatalogStore();
    if (!catalog) return;
    try {
      let modules: string[] | undefined;
      let graphPending = false;
      if (this.moduleGraphReader) {
        try {
          const graph = await this.moduleGraphReader(
            denoPath,
            this.denoRuntime.getDenoEnv(),
          ).read(absolutePath, { denoConfigPath });
          modules = [
            ...graph.modules.map((m) => m.path),
            ...graph.missing.map((m) => m.path),
            ...(denoConfigPath
              ? [denoConfigPath, ...await this.lockPathFor(denoConfigPath)]
              : []),
          ];
          if (modules.length > MAX_SOURCE_MODULES) {
            this.logger
              .debug`The module graph of ${absolutePath} names ${modules.length} modules, over ${MAX_SOURCE_MODULES}`;
            modules = undefined;
          }
        } catch (error) {
          graphPending = !graphRetry;
          if (graphPending) {
            this.logger
              .debug`Could not read the module graph of ${absolutePath}, retrying on the next scan: ${error}`;
          } else {
            this.logger
              .debug`Could not read the module graph of ${absolutePath} on retry, keeping the relative imports: ${error}`;
          }
        }
      }
      modules ??=
        (await resolveLocalImports([absolutePath], boundaryDir)).resolvedFiles;
      if (modules.length > MAX_SOURCE_MODULES) {
        this.logger
          .debug`Not recording the ${modules.length} modules of ${absolutePath}, over ${MAX_SOURCE_MODULES}`;
        return;
      }
      catalog.recordSourceModules(absolutePath, modules, { graphPending });
    } catch (error) {
      this.logger
        .debug`Could not record the modules of ${absolutePath}, forgetting the recorded ones: ${error}`;
      catalog.deleteSourceModules(absolutePath);
    }
  }

  /**
   * recorded before it exists: a missing lock hashes to a placeholder, so a
   * lock that is created, updated or pulled rebuilds the bundle
   */
  private async lockPathFor(denoConfigPath: string): Promise<string[]> {
    const project = { denoConfigPath };
    const lockPath = await configuredLockPath(project) ??
      await frozenLockPath(project);
    return lockPath ? [lockPath] : [];
  }

  /**
   * so the warm scan does not treat the source as unrecorded and retry it on
   * every command
   */
  private async recordFallbackSourceModules(
    absolutePath: string,
    boundaryDir: string,
  ): Promise<void> {
    const catalog = this.repository?.getCatalogStore();
    if (!catalog || catalog.findSourceModules(absolutePath)) return;
    const { resolvedFiles } = await resolveLocalImports(
      [absolutePath],
      boundaryDir,
    );
    catalog.recordSourceModules(absolutePath, resolvedFiles);
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
   * files without the kind's export are helper modules; skipping them is
   * expected, so the message says what the file is rather than implying a
   * failure
   */
  private logHelperModuleSkip(file: string): void {
    const kind = this.adapter.kind;
    this.logger
      .debug`Treating ${file} as a helper module (no ${kind} export, so not a ${kind} entry point)`;
  }

  /**
   * reusing a pulled extension's bundle is the normal fast path, logged at
   * debug; a failed rebundle is reported by bundleWithCache
   */
  private logTrustedPulledBundle(bundled: BundleResult, file: string): void {
    if (bundled.fromCache && bundled.cacheReason === "trusted-pulled") {
      this.logger.debug`Using existing bundle for pulled extension ${file}`;
    }
  }

  /**
   * checked before the source is read, so a skipped file costs no read, bundle
   * or import
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

  /**
   * both directories are local so neither outranks the other: the catalog would
   * keep the smaller path and silently drop the other; types are read from
   * source text like the catalog's extraction
   */
  private async assertNoLocalTypeCollisions(
    dir: string,
    localDirs: readonly string[],
  ): Promise<void> {
    if (localDirs.length === 0) return;
    const primaryKind = this.adapter.catalogKinds[0];
    const typesIn = async (d: string): Promise<Map<string, string>> => {
      const types = new Map<string, string>();
      let files: string[];
      try {
        files = await this.discoverFiles(d);
      } catch {
        return types;
      }
      for (const file of files) {
        const absolutePath = resolve(d, file);
        let source: string;
        try {
          source = await Deno.readTextFile(absolutePath);
        } catch {
          continue;
        }
        if (!this.adapter.exportRegex.test(source)) continue;
        // A malformed type (one that normalizes to nothing) is skipped here,
        // as the catalog's own extraction skips it, rather than aborting the
        // whole load; the file's own load reports the problem.
        let extracted: ReturnType<typeof this.adapter.extractTypeFromSource>;
        try {
          extracted = this.adapter.extractTypeFromSource(source);
        } catch {
          continue;
        }
        if (!extracted || extracted.kind !== primaryKind) continue;
        if (!types.has(extracted.typeNormalized)) {
          types.set(extracted.typeNormalized, canonicalizePath(absolutePath));
        }
      }
      return types;
    };
    const localTypes = [];
    for (const d of localDirs) {
      const types = await typesIn(d);
      if (types.size > 0) localTypes.push(types);
    }
    if (localTypes.length === 0) return;
    const primaryTypes = await typesIn(dir);
    for (const types of localTypes) {
      for (const [type, path] of types) {
        const existing = primaryTypes.get(type);
        if (existing === undefined) continue;
        throw new DuplicateTypeUserError({
          kind: this.adapter.kind,
          typeNormalized: type,
          existing: {
            extensionName: "",
            extensionVersion: "",
            canonicalPath: existing,
          },
          conflicting: {
            extensionName: "",
            extensionVersion: "",
            canonicalPath: path,
          },
          origin: "local-directories",
        });
      }
    }
  }

  async load(
    dir: string,
    options?: {
      skipAlreadyRegistered?: boolean;
      additionalDirs?: string[];
      /**
       * scanned right after dir, without test files; a type both dir and one of
       * these declare is refused
       */
      localDirs?: string[];
      indexOnly?: boolean;
      /**
       * the caller must pass only sources whose types are already registered:
       * no type check runs for these paths
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

    const localDirs = options?.localDirs ?? [];
    await this.assertNoLocalTypeCollisions(dir, localDirs);

    const allFiles: Array<{ file: string; baseDir: string }> = [];
    const additionalSet = new Set(options?.additionalDirs ?? []);
    const testFileDirs = testFileDirsOf(options?.additionalDirs, localDirs);
    for (const d of [dir, ...localDirs, ...additionalSet]) {
      try {
        await Deno.stat(d);
      } catch {
        continue;
      }
      const files = await this.discoverFiles(
        d,
        "",
        testFileDirs.has(d),
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
            { trustPulledCache: true, reuseFreshIndexed: true },
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
      snapshot: SourceSnapshot | undefined;
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

        // taken before bundling, so an edit landing meanwhile reads as a change
        // rather than as the code that was loaded
        const snapshot = await this.sourceSnapshot(absolutePath);
        const bundled = await this.bundleWithCache(
          absolutePath,
          file,
          denoPath,
          baseDir,
          { trustPulledCache: true, reuseFreshIndexed: true },
        );
        this.logTrustedPulledBundle(bundled, file);
        const module = await this.importBundle(bundled.js, file, baseDir);

        if (primaryExport(module, this.adapter)) {
          primaryFiles.push({ file, module, absolutePath, baseDir, snapshot });
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

    for (
      const { file, module, absolutePath, baseDir, snapshot } of primaryFiles
    ) {
      try {
        const exported = primaryExport(module, this.adapter);
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
          fingerprint = await computeSourceFingerprint(
            absolutePath,
            baseDir,
            this.sourceModules(),
          );
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
            pulled: this.isPulledBoundary(baseDir),
            extensionName: extractExtensionNameFromPath(
              absolutePath,
              this.repoDir,
            ),
            sourceFingerprint: fingerprint,
            sourceSnapshot: snapshot,
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
      // attach the likely winner first; the outcome does not depend on this
      // order
      const ranked = secondaryFiles
        .map((f) => ({
          ...f,
          contributor: this.contributorFor(resolve(f.baseDir, f.file)),
        }))
        .sort((a, b) =>
          compareExtensionPrecedence(a.contributor, b.contributor)
        );
      const fingerprintCache = createFreshnessCache();
      for (const { file, module, baseDir, contributor } of ranked) {
        let fingerprint: string | undefined;
        try {
          fingerprint = await computeSourceFingerprint(
            resolve(baseDir, file),
            baseDir,
            this.sourceModules(),
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
    options?: {
      additionalDirs?: string[];
      localDirs?: string[];
      indexOnly?: boolean;
    },
  ): Promise<ExtensionLoadResult> {
    try {
      const result = await this.buildIndexPass(dir, options);
      this.appliedSourceRows = this.localSourceRows();
      return result;
    } finally {
      // No probe outlives the pass that asked for it.
      await this.bundleProber?.release();
    }
  }

  private async buildIndexPass(
    dir: string,
    options?: {
      additionalDirs?: string[];
      localDirs?: string[];
      indexOnly?: boolean;
    },
  ): Promise<ExtensionLoadResult> {
    const repository = this.requireRepository("buildIndex");
    const catalog = repository.getCatalogStore();

    const localDirs = options?.localDirs ?? [];
    await this.assertNoLocalTypeCollisions(dir, localDirs);
    // every directory past dir, local ones first; only the non-local ones
    // contribute test files
    const extraDirs = localDirs.length > 0
      ? [...localDirs, ...(options?.additionalDirs ?? [])]
      : options?.additionalDirs;
    const testFileDirs = testFileDirsOf(options?.additionalDirs, localDirs);

    installZodGlobal();
    const denoPath = await this.denoRuntime.ensureDeno();

    const currentBasePath = this.resolveBundlePath();
    const currentSourceFingerprint = sourceDirsFingerprint(
      dir,
      extraDirs,
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
      return await this.refreshWarm(
        dir,
        repository,
        denoPath,
        extraDirs,
        testFileDirs,
      );
    }

    const fullResult = await this.load(dir, {
      additionalDirs: options?.additionalDirs,
      ...(localDirs.length > 0 ? { localDirs } : {}),
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
          failFp = await computeSourceFingerprint(
            absolutePath,
            resolveDir,
            catalog,
          );
        } catch {
          failFp = "";
        }
        const stat = await Deno.stat(absolutePath).catch(() => null);
        const sourceMtime = stat?.mtime?.toISOString() ?? "";

        const failResult = recordSourceFailure({
          extension: ext,
          location: existingSource?.id ?? loc,
          kindDir,
          error: failure.originalError ??
            markErrorPaths(new Error(failure.error), [
              failure.file,
              absolutePath,
            ]),
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
      extraDirs,
      testFileDirs,
    );
    // the same unseen-row removal as the warm path, so rows the scan does not
    // reach do not outlive a cold pass
    const seen = await collectSeenSources(
      [dir, ...(extraDirs ?? [])],
      (d) => this.discoverFiles(d, "", testFileDirs.has(d)),
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

  /**
   * never invalidates the catalog and does not warn about broken rows, which
   * every run would repeat; a registered definition is not replaced, only the
   * stale source's row and bundle are updated
   */
  async refreshStaleSources(
    dir: string,
    options?: {
      additionalDirs?: string[];
      localDirs?: string[];
    },
  ): Promise<SourceRefreshChanges | null> {
    const repository = this.requireRepository("refreshStaleSources");
    if (!repository.getCatalogStore().isPopulated(this.adapter.kind)) {
      return null;
    }
    const localDirs = options?.localDirs ?? [];
    await this.assertNoLocalTypeCollisions(dir, localDirs);
    const extraDirs = localDirs.length > 0
      ? [...localDirs, ...(options?.additionalDirs ?? [])]
      : options?.additionalDirs;
    installZodGlobal();
    const denoPath = await this.denoRuntime.ensureDeno();
    const changes: SourceRefreshChanges = {
      rebundled: [],
      failed: [],
      removed: [],
    };
    try {
      await this.refreshWarm(
        dir,
        repository,
        denoPath,
        extraDirs,
        testFileDirsOf(options?.additionalDirs, localDirs),
        changes,
      );
    } finally {
      await this.bundleProber?.release();
    }
    this.includePreviouslyIndexedChanges(changes);
    return changes;
  }

  /** A shared catalog describes disk, not what this process registered. */
  private localSourceRows(): Map<string, ExtensionTypeRow> {
    const catalog = this.repository?.getCatalogStore();
    if (!catalog) return new Map();
    return new Map(
      this.adapter.catalogKinds.flatMap((kind) =>
        catalog.findByKind(kind).filter((row) =>
          !this.isPulledSourcePath(row.source_path)
        ).map((row) => [row.source_path, row] as const)
      ),
    );
  }

  private includePreviouslyIndexedChanges(changes: SourceRefreshChanges): void {
    const current = this.localSourceRows();
    const primaryKind = this.adapter.catalogKinds[0];
    const signature = (row: ExtensionTypeRow) =>
      JSON.stringify([
        row.kind,
        row.type_normalized,
        row.extends_type,
        row.version,
        row.source_fingerprint,
        row.state,
        row.bundle_path,
      ]);
    for (const [path, previous] of this.appliedSourceRows) {
      const next = current.get(path);
      if (next && signature(next) === signature(previous)) continue;
      // Clear the old provider even if another process removed or renamed it,
      // or retargeted an add-on, before this process scanned the catalog.
      changes.removed.push({
        sourcePath: path,
        kind: previous.kind,
        type: previous.kind === primaryKind
          ? previous.type_normalized || undefined
          : previous.extends_type || previous.type_normalized || undefined,
      });
    }
    for (const [path, row] of current) {
      const previous = this.appliedSourceRows.get(path);
      if (previous && signature(row) === signature(previous)) continue;
      if (row.state === "Tombstoned") continue;
      if (LOCAL_OVERRIDE_FAILURE_STATES.has(row.state ?? "Indexed")) {
        if (
          changes.failed.some((failure) =>
            canonicalizePath(failure.sourcePath) === path
          )
        ) {
          continue;
        }
        changes.failed.push({
          sourcePath: path,
          previousType: previous?.kind === primaryKind
            ? previous.type_normalized || undefined
            : undefined,
          extendsType: previous?.extends_type || undefined,
          error: row.last_error ||
            "Source indexed as unavailable by another process",
        });
      } else {
        changes.rebundled.push({
          sourcePath: path,
          previousType: previous?.kind === primaryKind
            ? previous.type_normalized || undefined
            : undefined,
          type: row.kind === primaryKind
            ? row.type_normalized || undefined
            : undefined,
          extendsType: row.extends_type || undefined,
        });
      }
    }
    this.appliedSourceRows = current;
  }

  isPulledSourcePath(sourcePath: string): boolean {
    return this.contributorFor(sourcePath).pulled;
  }

  /**
   * broken rows are skipped without the startup warning, which a refresh on
   * every run would repeat
   */
  registerFromCatalog(): void {
    this.registerLazyFromCatalog(
      this.requireRepository("registerFromCatalog").getCatalogStore(),
      false,
    );
  }

  private async refreshWarm(
    dir: string,
    repository: ExtensionRepository,
    denoPath: string,
    extraDirs: string[] | undefined,
    testFileDirs: ReadonlySet<string>,
    changes?: SourceRefreshChanges,
  ): Promise<ExtensionLoadResult> {
    const catalog = repository.getCatalogStore();
    const result: ExtensionLoadResult = {
      loaded: [],
      extended: [],
      failed: [],
    };
    const scan = await this.scanFreshness(
      dir,
      catalog,
      extraDirs,
      testFileDirs,
    );
    const staleFiles = scan.stale;
    evictRemovedBundles(scan.removed, catalog);
    for (const row of scan.removed) {
      changes?.removed.push({
        sourcePath: row.source_path,
        kind: row.kind,
        type: row.type_normalized || undefined,
      });
    }
    // Read after the scan: its own removals may have reset the marker.
    const healPending = !catalog.isTypelessHealDone(
      this.adapter.catalogKinds[0],
    );
    const heal = healPending && !this.hasLiveLocalFailure(catalog);

    if (staleFiles.length === 0 && (!heal || scan.typeless.length === 0)) {
      if (this.repoDir) this.settleTypeConflicts(catalog);
      if (heal) catalog.markTypelessHealDone(this.adapter.catalogKinds[0]);
      this.registerLazyFromCatalog(catalog, changes === undefined);
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
      const prior = changes ? catalog.findBySourcePath(absolutePath) : null;
      // Only a primary row provides its type: an add-on row names the type
      // it extends, which a failed add-on must not take down.
      const previousType = prior?.kind === this.adapter.catalogKinds[0]
        ? prior.type_normalized || undefined
        : undefined;
      const previousExtendsType = prior?.extends_type || undefined;
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
        changes?.rebundled.push({
          sourcePath: absolutePath,
          previousType,
          type: registeredType,
          extendsType: extensionTarget ?? previousExtendsType,
        });
      } catch (error) {
        result.failed.push({ file: relativePath, error: String(error) });
        changes?.failed.push({
          sourcePath: absolutePath,
          previousType,
          extendsType: previousExtendsType,
          error: String(error),
        });

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
              failFp = await computeSourceFingerprint(
                absolutePath,
                baseDir,
                catalog,
              );
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
          } else if (error instanceof ProbeFailedError) {
            // a source no aggregate knows has no row, so it would be stale and
            // probed to its timeout on every command; the row pins the failure
            // to this fingerprint and has no owner, derived on load
            const stat = await Deno.stat(absolutePath).catch(() => null);
            catalog.upsert({
              type_normalized: "",
              kind: this.adapter.catalogKinds[0],
              bundle_path: error.bundlePath,
              source_path: canonicalizePath(absolutePath),
              version: "",
              description: "",
              extends_type: "",
              source_mtime: stat?.mtime?.toISOString() ?? "",
              source_fingerprint: error.fingerprint,
              state: "ValidationFailed",
              last_error: error.message,
            });
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

    // a probed pass imports nothing here: a lazy base type attaches its
    // extensions when loaded, and a registered one attaches them through the
    // registry's attacher on first use
    if (this.adapter.attachPendingExtensionsForType && !this.bundleProber) {
      for (const type of typesNeedingExtensionAttach) {
        await this.adapter.attachPendingExtensionsForType(
          type,
          catalog,
          (paths) => this.importBundleByPath(paths),
          (sourcePath) => this.contributorFor(sourcePath),
        );
      }
    }

    this.registerLazyFromCatalog(catalog, changes === undefined);
    return result;
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

    // a row whose source is gone is never imported: drop such rows until a live
    // one turns up, bounded by the rows claiming the type so a failed delete
    // cannot loop; counted only when a source is missing
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
          // one extension that fails to import must not take down its base type
          // or the extensions after it
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
   * pulled means under this repo's pulled-extension roots; the rule needs only
   * the repo root, so every loader instance ranks a file the same way
   */
  private contributorFor(sourcePath: string): ExtensionContributor {
    const canonical = canonicalizePath(sourcePath);
    // Identity is the symlink-resolved path, so one file reached under two
    // spellings of the repo root (`/tmp/r` from catalog rows, `/private/tmp/r`
    // from a directory walk on macOS) is one contributor, not two that
    // collide with each other.
    const real = realCanonicalPath(canonical);
    const pulled = this.repoDir !== null &&
      this.isPulledSource(canonical, real);
    const mountIndex = pulled ? -1 : this.mountIndexOf(canonical, real);
    return mountIndex < 0
      ? { sourcePath: real, pulled }
      : { sourcePath: real, pulled, mountIndex };
  }

  private mountIndexOf(canonical: string, real: string): number {
    this.mountPrefixes ??= (this.repository?.mountedSourceDirs ?? []).map(
      (dir) => {
        const resolved = realCanonicalPath(dir);
        return (resolved === dir ? [dir] : [dir, resolved]).map((d) =>
          d.endsWith("/") ? d : `${d}/`
        );
      },
    );
    return this.mountPrefixes.findIndex((prefixes) =>
      prefixes.some((m) => canonical.startsWith(m) || real.startsWith(m))
    );
  }

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

  /**
   * checkBundle sees a freshly built bundle before it is imported or probed and
   * may throw to stop it; a reused on-disk bundle is not passed to it
   */
  public async bundleAndIndexOne(args: {
    absolutePath: string;
    relativePath: string;
    baseDir: string;
    trustPulledCache?: boolean;
    checkBundle?: (js: string, bundlePath: string) => void | Promise<void>;
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
    if (args.checkBundle && !fromCache) {
      await args.checkBundle(
        js,
        this.getBundlePath(args.relativePath, args.baseDir),
      );
    }
    const fingerprint = await computeSourceFingerprint(
      args.absolutePath,
      args.baseDir,
      this.sourceModules(),
    );
    if (this.bundleProber) {
      const bundlePath = this.getBundlePath(args.relativePath, args.baseDir);
      const probed = await this.probeBundle(
        this.bundleProber,
        await this.bundleImportTarget(
          js,
          args.relativePath,
          args.baseDir,
          fingerprint,
        ),
        { sourcePath: args.absolutePath, bundlePath, fingerprint },
      );
      if (probed.tag === "no-export") return null;
      return {
        kind: probed.tag === "primary"
          ? this.adapter.catalogKinds[0]
          : this.adapter.catalogKinds[1] ?? this.adapter.catalogKinds[0],
        typeNormalized: probed.typeNormalized,
        bundlePath,
        fingerprint,
        fromCache,
      };
    }

    const module = await this.importBundle(
      js,
      args.relativePath,
      args.baseDir,
      fingerprint,
    );

    const exported = primaryExport(module, this.adapter);
    if (exported) {
      const parsed = this.adapter.validatePrimaryExport(exported);
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

    // taken before the import, so an edit landing meanwhile reads as a change
    // rather than as the code that was loaded
    const snapshot = await this.sourceSnapshot(entry.source_path);
    const module = await this.importBundleByPath({
      bundlePath: entry.bundle_path,
      sourcePath: entry.source_path,
      sourceFingerprint: entry.source_fingerprint || undefined,
    });

    const exported = primaryExport(module, this.adapter);
    if (!exported) {
      const exportNames = primaryExportNames(this.adapter).join(" or ");
      this.logger
        .warn`Skipping bundle with no ${exportNames} export: ${entry.bundle_path}`;
      return;
    }

    const parsed = this.adapter.validatePrimaryExport(exported);
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
        pulled: this.isPulledBoundary(entry.source_path),
        extensionName: extractExtensionNameFromPath(
          entry.source_path,
          this.repoDir,
        ),
        sourceFingerprint: entry.source_fingerprint || undefined,
        sourceSnapshot: snapshot,
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
    return await import(await this.bundleImportTargetByPath(paths));
  }

  private async bundleImportTargetByPath(
    paths: {
      bundlePath: string;
      sourcePath: string;
      sourceFingerprint?: string;
    },
  ): Promise<string> {
    let js: string;
    try {
      js = await Deno.readTextFile(paths.bundlePath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      js = await this.recoverMissingBundle(paths);
    }
    const fixed = fixCjsEsmInterop(
      rewriteZodImports(js, paths.bundlePath),
    );
    if (fixed !== js) {
      js = fixed;
      await Deno.writeTextFile(paths.bundlePath, js);
    }
    return await bundleImportUrl(
      paths.bundlePath,
      js,
      paths.sourceFingerprint,
    );
  }

  /**
   * bundles without writing the lockfile: --frozen against the lock the project
   * has, --no-lock when none; a stale lock warns and bundles --no-lock, leaving
   * the lock for the author to update
   */
  private async bundleLocal(
    absolutePath: string,
    denoPath: string,
    denoConfigPath: string | undefined,
    noConfig = false,
  ): Promise<string> {
    const env = this.denoRuntime.getDenoEnv();
    const lockPath = denoConfigPath
      ? await frozenLockPath({ denoConfigPath })
      : undefined;
    try {
      return await bundleExtension(absolutePath, denoPath, {
        denoConfigPath,
        env,
        readOnlyLock: lockPath ? { lockPath } : {},
        noConfig,
      });
    } catch (error) {
      if (!(error instanceof StaleLockfileError)) throw error;
      this.logger
        .warn`${error.lockPath} is out of date with ${error.projectFile}, so ${absolutePath} is loaded without it and the lock is left unchanged. Run \`deno install --entrypoint ${absolutePath}\` in ${error.projectDir} to update it`;
      return await bundleExtension(absolutePath, denoPath, {
        denoConfigPath,
        env,
        readOnlyLock: {},
        noConfig,
      });
    }
  }

  private async recoverMissingBundle(
    paths: { bundlePath: string; sourcePath: string },
  ): Promise<string> {
    const denoPath = await this.denoRuntime.ensureDeno();
    // pulled source reads no Deno config
    const pulled = this.isPulledBoundary(paths.sourcePath);
    let denoConfigPath: string | undefined;
    if (this.adapter.resolveDenoConfig && !pulled) {
      denoConfigPath = this.adapter.resolveDenoConfig(
        paths.sourcePath,
        this.repoDir,
      );
    }
    const js = await this.bundleLocal(
      paths.sourcePath,
      denoPath,
      denoConfigPath,
      pulled,
    );
    await Deno.mkdir(dirname(paths.bundlePath), { recursive: true });
    await Deno.writeTextFile(paths.bundlePath, js);
    this.logger
      .info`Recovered missing bundle for ${paths.sourcePath} on demand`;
    return js;
  }

  /**
   * local outranks pulled, a pulled row already holding the type keeps it
   * against another pulled row, and two locals fall back to the smaller path
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
   * order matters: pulled-vs-pulled (earliest-indexed wins), then
   * source-mounted, then pulled-vs-local, so a local override ends up the only
   * claimant; two different pulled claimants are reported
   */
  private settleTypeConflicts(catalog: ExtensionCatalogStore): void {
    if (!this.repoDir) return;
    warnPulledTypeConflicts(
      this.logger,
      catalog.settlePulledTypeConflicts(this.repoDir),
    );
    const mounted = this.repository?.settleMountedTypeConflicts() ?? [];
    if (mounted.length > 0) {
      this.logger
        .debug`Cleared the type on ${mounted.length} source-mounted catalog row(s) a higher-precedence row also claims`;
    }
    catalog.resolveOriginConflicts(this.repoDir);
  }

  /**
   * restores a type cleared while another row claimed it, by importing the
   * existing bundle, for one row per type by precedence; catalog-only, so a
   * pulled row never takes a type from a local override
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
        const paths = {
          bundlePath: row.bundle_path,
          sourcePath: absolutePath,
          sourceFingerprint: row.source_fingerprint || undefined,
        };
        if (this.bundleProber) {
          const probed = await this.bundleProber.probe({
            importUrl: await this.bundleImportTargetByPath(paths),
            kind: this.adapter.kind,
          });
          if (probed.tag !== "primary") continue;
          typeNormalized = probed.typeNormalized;
        } else {
          const module = await this.importBundleByPath(paths);
          const exported = primaryExport(module, this.adapter);
          if (!exported) continue;
          const parsed = this.adapter.validatePrimaryExport(exported);
          if (!parsed.success) continue;
          typeNormalized = this.adapter.normalizeType(
            parsed.data as Record<string, unknown>,
          );
        }
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
        const holders = catalog.findAllByType(typeNormalized, kind);
        // a local override that an older binary indexed typeless while a
        // source-mounted row held its type takes the type back; any other
        // holder keeps it
        const winnerContributor = this.contributorFor(winner);
        const displaced = holders.filter((row) => {
          const holder = this.contributorFor(row.source_path);
          return holder.mountIndex !== undefined &&
            compareExtensionPrecedence(winnerContributor, holder) < 0;
        });
        if (displaced.length !== holders.length) return;
        for (const row of displaced) {
          catalog.setTypeNormalized(row.source_path, "");
        }
        catalog.setTypeNormalized(winner, typeNormalized);
      });
    }
  }

  /**
   * failed rows claim no type, so a live local failure may be the override of
   * any typeless pulled row; the heal must wait until it is fixed or removed
   */
  private hasLiveLocalFailure(catalog: ExtensionCatalogStore): boolean {
    const failed = catalog.findByKind(this.adapter.catalogKinds[0]).find((
      row,
    ) =>
      LOCAL_OVERRIDE_FAILURE_STATES.has(row.state ?? "Indexed") &&
      !this.contributorFor(row.source_path).pulled &&
      this.sourceExistsOnDisk(row.source_path)
    );
    if (failed) {
      this.logger
        .debug`Deferring the typeless-row heal while local source ${failed.source_path} is ${failed.state}`;
    }
    return failed !== undefined;
  }

  private registerLazyFromCatalog(
    catalog: ExtensionCatalogStore,
    warnBroken = true,
  ): void {
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
    if (!warnBroken) return;
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
    testFileDirs: ReadonlySet<string> = new Set(additionalDirs ?? []),
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
          testFileDirs.has(d),
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
          catalog,
          cache,
        ).catch(() => undefined);

        // reconcile indexes by importing bundles, so an up-to-date row holds
        // the real type, even for exports static extraction cannot read: keep
        // it and refresh only the bundle location
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
            // move the row to this spelling, as the next warm scan would; one
            // row per file means no second row claims its type
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
          // a stale indexed row is refreshed by the next stale-file scan, so
          // warn only when nothing indexed it; export text only inside a string
          // or comment, as in a test fixture, is not an entry point
          if (!indexed && declaresExport(source, this.adapter.exportRegex)) {
            emitTypeExtractionFailure(absolutePath, this.adapter.kind);
          }
          continue;
        }
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
   * rows under the loader's own spelling of the repo root are left out, since
   * the exact lookup covers them; a catalog with no other spelling costs no
   * realpath calls
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
    // a graph-pending source is stale for its one retry; use the retry up
    // before anything that can return or throw, so a source leaving by any path
    // is not stale again for it
    const graphRetry = catalog.takeSourceGraphPending(absolutePath);
    const source = await Deno.readTextFile(absolutePath);
    if (!this.adapter.exportRegex.test(source)) {
      // A row with no recorded modules is stale on every scan; record the
      // relative imports so it settles. A source with no row gets none, as
      // nothing would remove them.
      if (catalog.findBySourcePath(absolutePath) !== undefined) {
        await this.recordFallbackSourceModules(absolutePath, baseDir)
          .catch((error) => {
            this.logger
              .debug`Could not record the modules of ${absolutePath}: ${error}`;
          });
      }
      return {};
    }
    // a source with no row is stale on every scan; when an import at this
    // fingerprint already found no export, bundling again would find nothing on
    // every command
    if (catalog.findBySourcePath(absolutePath) === undefined) {
      const fingerprint = await computeSourceFingerprint(
        absolutePath,
        baseDir,
        catalog,
      ).catch(() => "");
      if (
        catalog.isKnownNoExport(this.adapter.kind, absolutePath, fingerprint)
      ) {
        return {};
      }
    }

    // taken before bundling, so an edit landing meanwhile reads as a change
    // rather than as the code that was loaded
    const snapshot = await this.sourceSnapshot(absolutePath, catalog);
    const bundled = await this.bundleWithCache(
      absolutePath,
      relativePath,
      denoPath,
      baseDir,
      { graphRetry },
    );
    const { js } = bundled;

    const stat = await Deno.stat(absolutePath);
    const sourceMtime = stat.mtime?.toISOString() ?? "";
    const sourceFingerprint = await computeSourceFingerprint(
      absolutePath,
      baseDir,
      catalog,
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

    if (this.bundleProber) {
      return await this.probeAndUpdateCatalog(this.bundleProber, catalog, {
        absolutePath,
        relativePath,
        baseDir,
        js,
        sourceMtime,
        sourceFingerprint,
        effectiveFingerprint,
        fromCache: bundled.fromCache,
      });
    }

    const module = await this.importBundle(
      js,
      relativePath,
      baseDir,
      effectiveFingerprint,
    );

    const exported = primaryExport(module, this.adapter);

    if (exported) {
      const bundlePath = this.getBundlePath(relativePath, baseDir);
      const parsed = this.adapter.validatePrimaryExport(exported);
      if (!parsed.success) {
        throw new ValidationError(
          this.adapter.formatValidationError(parsed.error),
          bundlePath,
          effectiveFingerprint,
        );
      }
      const validated = parsed.data as Record<string, unknown>;
      const typeNormalized = this.adapter.normalizeType(validated);
      // never write a type another row outranks this one for: two pulled rows
      // sharing a type would fail every later save on I-Repo-1 before the
      // settle step runs
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
            pulled: this.isPulledBoundary(baseDir),
            extensionName: extractExtensionNameFromPath(
              absolutePath,
              this.repoDir,
            ),
            sourceFingerprint: effectiveFingerprint,
            sourceSnapshot: snapshot,
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

    // Only a bundle built from the current source speaks for this
    // fingerprint; a cached one may predate an export added since.
    if (!bundled.fromCache) {
      catalog.recordNoExport(
        this.adapter.kind,
        absolutePath,
        sourceFingerprint,
      );
    }
    return {};
  }

  /**
   * the probing counterpart of the in-process half of rebundleAndUpdateCatalog:
   * same catalog writes from a probe result; nothing is registered here, the
   * type becomes a lazy entry at buildIndex
   */
  private async probeAndUpdateCatalog(
    prober: BundleProber,
    catalog: ExtensionCatalogStore,
    args: {
      absolutePath: string;
      relativePath: string;
      baseDir: string;
      js: string;
      sourceMtime: string;
      sourceFingerprint: string;
      effectiveFingerprint: string;
      fromCache: boolean;
    },
  ): Promise<
    {
      registeredType?: string;
      extensionTarget?: string;
      outranked?: TypelessRow;
    }
  > {
    const { absolutePath, relativePath, baseDir, effectiveFingerprint } = args;
    const bundlePath = this.getBundlePath(relativePath, baseDir);
    const probed = await this.probeBundle(
      prober,
      await this.bundleImportTarget(
        args.js,
        relativePath,
        baseDir,
        effectiveFingerprint,
      ),
      {
        sourcePath: absolutePath,
        bundlePath,
        fingerprint: effectiveFingerprint,
      },
    );

    if (probed.tag === "primary") {
      const { typeNormalized } = probed;
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
        version: probed.version,
        description: probed.description,
        extends_type: "",
        source_mtime: args.sourceMtime,
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
      if (
        this.adapter.hasType(typeNormalized) &&
        this.adapter.updateSourceFingerprint
      ) {
        this.adapter.updateSourceFingerprint(
          typeNormalized,
          effectiveFingerprint,
        );
      }
      return { registeredType: typeNormalized };
    }

    if (probed.tag === "secondary") {
      catalog.upsert({
        type_normalized: probed.typeNormalized,
        kind: this.adapter.catalogKinds[1] ?? this.adapter.catalogKinds[0],
        bundle_path: bundlePath,
        source_path: canonicalizePath(absolutePath),
        version: "",
        description: "",
        extends_type: probed.typeNormalized,
        source_mtime: args.sourceMtime,
        source_fingerprint: effectiveFingerprint,
        state: "Indexed",
      });
      return { extensionTarget: probed.typeNormalized };
    }

    if (!args.fromCache) {
      catalog.recordNoExport(
        this.adapter.kind,
        absolutePath,
        args.sourceFingerprint,
      );
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
      // every entry but install staging, which belongs to an install in flight
      // or to its crash recovery
      for await (const entry of Deno.readDir(bundleDir)) {
        if (isStagingEntryName(entry.name)) continue;
        try {
          await Deno.remove(join(bundleDir, entry.name), { recursive: true });
        } catch (error) {
          // Moved or removed since the listing (an install's swap):
          // nothing left to evict, and the rest still are.
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
      this.logger
        .info`Evicted stale bundles for ${this.adapter.kind}: ${bundleDir}`;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        this.logger
          .warn`Failed to evict stale bundles for ${this.adapter.kind}: ${error}`;
      }
    }
  }

  getBundlePath(relativePath: string, baseDir: string): string {
    if (!this.repoDir) return "";
    return this.resolveBundlePath(
      bundleNamespace(baseDir, this.repoDir),
      relativePath.replace(/\.ts$/, ".js"),
    );
  }

  private isPulledBoundary(boundaryDir: string): boolean {
    if (!this.repoDir) return false;
    const resolvedBoundary = resolve(boundaryDir);
    return resolvedBoundary.startsWith(
      join(resolve(this.repoDir), SWAMP_DATA_DIR, "pulled-extensions") +
        SEPARATOR,
    ) || resolvedBoundary.startsWith(
      join(
        resolve(this.repoDir),
        SWAMP_DATA_DIR,
        "config",
        "pulled-extensions",
      ) + SEPARATOR,
    );
  }

  /**
   * startup reconcile writes such a row before the first full load of a kind,
   * so that load reuses its bundle instead of building it again
   */
  private async isFreshIndexedBundle(
    absolutePath: string,
    boundaryDir: string,
    bundlePath: string,
  ): Promise<boolean> {
    const catalog = this.repository?.getCatalogStore();
    if (!catalog) return false;
    const row = catalog.findBySourcePath(absolutePath);
    if (
      !row || !isIndexedRow(row) || !row.source_fingerprint ||
      !this.adapter.catalogKinds.includes(row.kind) ||
      // Reconcile records the bundle path canonicalized (lowercased, `/` on
      // Windows), so compare the canonical spellings.
      canonicalizePath(row.bundle_path) !== canonicalizePath(bundlePath) ||
      catalog.findSourceModules(absolutePath) === undefined ||
      catalog.isSourceGraphPending(absolutePath)
    ) {
      return false;
    }
    const fingerprint = await computeSourceFingerprint(
      absolutePath,
      boundaryDir,
      catalog,
    ).catch(() => undefined);
    return fingerprint === row.source_fingerprint;
  }

  private async bundleWithCache(
    absolutePath: string,
    relativePath: string,
    denoPath: string,
    boundaryDir: string,
    options?: {
      trustPulledCache?: boolean;
      graphRetry?: boolean;
      reuseFreshIndexed?: boolean;
    },
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

      const isPulled = this.isPulledBoundary(boundaryDir);
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
      if (
        bundleExists && !isPulled && options?.reuseFreshIndexed &&
        await this.isFreshIndexedBundle(absolutePath, boundaryDir, bundlePath)
      ) {
        return {
          js: await Deno.readTextFile(bundlePath),
          fromCache: true,
          cacheReason: "fresh-indexed",
        };
      }

      let denoConfigPath: string | undefined;
      let js: string;
      try {
        if (this.adapter.resolveDenoConfig && !isPulled) {
          denoConfigPath = this.adapter.resolveDenoConfig(
            absolutePath,
            this.repoDir,
          );
          if (denoConfigPath) {
            this.logger
              .debug`Using discovered deno config for ${relativePath}: ${denoConfigPath}`;
          }
        }
        // pulled source never reads a Deno config
        js = await this.bundleLocal(
          absolutePath,
          denoPath,
          denoConfigPath,
          isPulled,
        );
        const bundleBoundary = this.resolveBundlePath();
        await assertSafePath(bundlePath, bundleBoundary);
        await Deno.mkdir(dirname(bundlePath), { recursive: true });
        await Deno.writeTextFile(bundlePath, js);
        this.logger.debug`Wrote bundle cache: ${bundlePath}`;
      } catch (bundleError) {
        // A catalog error here must not replace the bundle error.
        await this.recordFallbackSourceModules(absolutePath, boundaryDir)
          .catch((error) => {
            this.logger
              .debug`Could not record the modules of ${absolutePath}: ${error}`;
          });
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
      await this.recordSourceModules(
        absolutePath,
        boundaryDir,
        denoPath,
        denoConfigPath,
        options?.graphRetry ?? false,
      );
      return { js, fromCache: false };
    }

    let denoConfigPath: string | undefined;
    if (this.adapter.resolveDenoConfig) {
      denoConfigPath = this.adapter.resolveDenoConfig(
        absolutePath,
        this.repoDir,
      );
      if (denoConfigPath) {
        this.logger
          .debug`Using discovered deno config for ${absolutePath}: ${denoConfigPath}`;
      }
    }
    const js = await this.bundleLocal(absolutePath, denoPath, denoConfigPath);
    return { js, fromCache: false };
  }

  private async bundleImportTarget(
    js: string,
    relativePath: string,
    baseDir?: string,
    sourceFingerprint?: string,
  ): Promise<string> {
    if (this.repoDir) {
      const ns = baseDir ? bundleNamespace(baseDir, this.repoDir) : "";
      const segments = ns
        ? [ns, relativePath.replace(/\.ts$/, ".js")]
        : [relativePath.replace(/\.ts$/, ".js")];
      const bundlePath = this.resolveBundlePath(...segments);

      try {
        await Deno.stat(bundlePath);
        let cachedJs = await Deno.readTextFile(bundlePath);
        const fixed = fixCjsEsmInterop(
          rewriteZodImports(cachedJs, bundlePath),
        );
        if (fixed !== cachedJs) {
          cachedJs = fixed;
          await Deno.writeTextFile(bundlePath, cachedJs);
        }
        return await bundleImportUrl(
          bundlePath,
          cachedJs,
          sourceFingerprint,
        );
      } catch (error) {
        this.logger.debug`Bundle file not available for ${relativePath}: ${
          String(error).substring(0, 200)
        }`;
      }
    }

    const rewritten = fixCjsEsmInterop(rewriteZodImports(js, relativePath));
    const encoded = uint8ArrayToBase64(new TextEncoder().encode(rewritten));
    return `data:application/javascript;base64,${encoded}`;
  }

  private async importBundle(
    js: string,
    relativePath: string,
    baseDir?: string,
    sourceFingerprint?: string,
  ): Promise<Record<string, unknown>> {
    const importUrl = await this.bundleImportTarget(
      js,
      relativePath,
      baseDir,
      sourceFingerprint,
    );
    if (!importUrl.startsWith("data:")) {
      return await import(importUrl);
    }
    try {
      return await import(importUrl);
    } catch (error) {
      throw new Error(sanitizeDataUrlError(error));
    }
  }

  /**
   * a failed probe maps onto the errors an in-process import and validation
   * would throw, so callers record the same source states
   */
  private async probeBundle(
    prober: BundleProber,
    importUrl: string,
    source: { sourcePath: string; bundlePath: string; fingerprint: string },
  ): Promise<
    Extract<BundleProbeResult, { tag: "primary" | "secondary" | "no-export" }>
  > {
    const result = await prober.probe({ importUrl, kind: this.adapter.kind });
    switch (result.tag) {
      case "primary":
      case "secondary":
      case "no-export":
        return result;
      case "validation-failed":
        throw new ValidationError(
          result.message,
          source.bundlePath,
          source.fingerprint,
        );
      case "import-failed":
        throw new Error(
          importUrl.startsWith("data:")
            ? sanitizeDataUrlError(result.message)
            : result.message,
        );
      case "timed-out":
      case "exited": {
        throw new ProbeFailedError(
          describeProbeFailure(result, {
            sourcePath: source.sourcePath,
            pulled: this.contributorFor(source.sourcePath).pulled,
          }),
          source.bundlePath,
          source.fingerprint,
        );
      }
    }
  }

  private async scanFreshness(
    dir: string,
    catalog: ExtensionCatalogStore,
    additionalDirs?: string[],
    testFileDirs: ReadonlySet<string> = new Set(additionalDirs ?? []),
  ): Promise<FreshnessScan> {
    return await scanCatalogFreshness({
      modelsDir: dir,
      additionalDirs,
      catalog,
      discoverFiles: (d) => this.discoverFiles(d, "", testFileDirs.has(d)),
      kinds: [...this.adapter.catalogKinds],
      repoDir: this.repoDir ?? undefined,
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
