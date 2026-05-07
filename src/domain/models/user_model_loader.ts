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
} from "./bundle.ts";
import {
  type BundleResult,
  computeSourceFingerprint,
  createFreshnessCache,
  findStaleFiles as findStaleFilesShared,
  type FreshnessCache,
  markCatalogValidationFailed,
} from "../extensions/bundle_freshness.ts";
import { ModelType } from "./model_type.ts";
import { CalVer } from "./calver.ts";
import {
  type CheckDefinition,
  type CheckResult,
  type DataHandle,
  FileOutputSpecSchema,
  type MethodContext,
  type MethodDefinition,
  type MethodKind,
  type MethodResult,
  type ModelDefinition,
  modelRegistry,
  ResourceOutputSpecSchema,
  type VersionUpgrade,
} from "./model.ts";
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
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";
import { assertSafePath } from "../../infrastructure/persistence/safe_path.ts";
import { emitTypeExtractionFailure } from "../../infrastructure/logging/extension_load_warnings.ts";
import type { DatastorePathResolver } from "../datastore/datastore_path_resolver.ts";

const logger = getLogger(["swamp", "models", "loader"]);

/**
 * Bundle layout version. Stored in the catalog's bundle_meta table.
 * When this doesn't match, the catalog is invalidated to force a full
 * rescan. Bump when bundle cache keys or source layout conventions
 * change so stale entries don't leak across the migration boundary.
 * History: "namespaced-v1" (per-source-dir hash) →
 * "per-extension-v2" (each pulled extension owns its own bundle
 * namespace via its per-extension models dir).
 */
// BUNDLE_LAYOUT_VERSION is now hoisted to extension_catalog_store.ts so
// all 5 loaders share one source of truth (W1b — closes the audit's
// 4-vs-1 cold-start guard gap). Imported below.

/**
 * Plain object result returned by user methods before conversion.
 * User models must use context.writeResource() / context.createFileWriter() to produce data.
 */
interface UserMethodResult {
  /**
   * Handles for data written via context.writeResource() / context.createFileWriter() during execution.
   */
  dataHandles?: DataHandle[];
  [key: string]: unknown;
}

/**
 * User method execute function type.
 * User models receive pre-validated args and context.
 */
type UserExecuteFn = (
  args: Record<string, unknown>,
  context: MethodContext,
) => Promise<UserMethodResult>;

/**
 * Schema for validating user method exports.
 */
const MethodKindSchema = z.enum([
  "create",
  "read",
  "update",
  "delete",
  "list",
  "action",
]);

const UserMethodSchema = z.object({
  description: z.string(),
  kind: MethodKindSchema.optional(),
  // Duck-typed schema check so user extensions can bring their own zod
  // instance without failing the `instanceof` equality against swamp's zod.
  arguments: z.custom<z.ZodTypeAny>(isZodSchemaLike),
  execute: z.custom<UserExecuteFn>((val) => typeof val === "function"),
}).passthrough();

/**
 * Schema for validating a user-supplied upgrade step.
 */
const UserUpgradeSchema = z.object({
  toVersion: z.string().refine(CalVer.isValid, {
    message: "toVersion must be valid CalVer (YYYY.MM.DD.MICRO)",
  }),
  description: z.string(),
  upgradeAttributes: z.custom<
    (old: Record<string, unknown>) => Record<string, unknown>
  >((val) => typeof val === "function"),
});

/**
 * Schema for validating user model exports.
 */
const UserCheckSchema = z.object({
  description: z.string(),
  labels: z.array(z.string()).optional(),
  appliesTo: z.array(z.string()).optional(),
  execute: z.custom<(context: MethodContext) => Promise<CheckResult>>(
    (val) => typeof val === "function",
  ),
});

const UserModelSchema = z.object({
  type: z.string(),
  version: z.string().refine(CalVer.isValid, {
    message: "version must be valid CalVer (YYYY.MM.DD.MICRO)",
  }),
  globalArguments: z.custom<z.ZodTypeAny>(isZodSchemaLike).optional(),
  resources: z.record(z.string(), ResourceOutputSpecSchema).optional(),
  files: z.record(z.string(), FileOutputSpecSchema).optional(),
  methods: z.record(z.string(), UserMethodSchema),
  checks: z.record(z.string(), UserCheckSchema).optional(),
  upgrades: z.array(UserUpgradeSchema).optional(),
  reports: z.array(z.string()).optional(),
});

/**
 * Formats a Zod error into a clear, actionable message.
 */
function formatUserModelError(error: z.ZodError): string {
  const issues = error.issues;

  // Check for missing dataOutputSpecs
  const dataOutputSpecsIssue = issues.find(
    (i) => i.path[0] === "dataOutputSpecs" && i.code === "invalid_type",
  );
  if (dataOutputSpecsIssue) {
    return (
      "Missing required 'dataOutputSpecs' field. " +
      "Add dataOutputSpecs to declare what data your model produces.\n\n" +
      "Example:\n" +
      "  dataOutputSpecs: {\n" +
      "    result: {\n" +
      '      specType: "result",\n' +
      '      contentType: "application/json",\n' +
      '      lifetime: { type: "persistent" },\n' +
      '      garbageCollection: { type: "keep_latest", count: 10 },\n' +
      "      tags: {},\n" +
      "    },\n" +
      "  },"
    );
  }

  // Check for missing method arguments schema
  const methodArgsIssue = issues.find(
    (i) => i.path[0] === "methods" && String(i.path[2]) === "arguments",
  );
  if (methodArgsIssue) {
    return (
      "Missing or invalid 'arguments' on method definition. " +
      "Add a Zod schema to validate method arguments.\n\n" +
      "Example:\n" +
      "  arguments: z.object({\n" +
      '    name: z.string().describe("Resource name"),\n' +
      "  }),"
    );
  }

  // Check for missing type
  const typeIssue = issues.find((i) => i.path[0] === "type");
  if (typeIssue) {
    return (
      "Missing required 'type' field. " +
      "Add a namespaced type identifier.\n\n" +
      "Example:\n" +
      '  type: "@myorg/my-model",'
    );
  }

  // Check for missing version
  const versionIssue = issues.find((i) => i.path[0] === "version");
  if (versionIssue) {
    return (
      "Missing or invalid 'version' field. " +
      "Use CalVer format: YYYY.MM.DD.MICRO.\n\n" +
      "Example:\n" +
      '  version: "2026.02.10.1",'
    );
  }

  // Check for missing methods
  const methodsIssue = issues.find((i) => i.path[0] === "methods");
  if (methodsIssue) {
    return (
      "Missing required 'methods' field. " +
      "Add at least one method to your model.\n\n" +
      "Example:\n" +
      "  methods: {\n" +
      "    run: {\n" +
      '      description: "Execute the model",\n' +
      "      arguments: z.object({}),\n" +
      "      execute: async (args, context) => {\n" +
      "        // Your logic here\n" +
      "        return { dataHandles: [] };\n" +
      "      },\n" +
      "    },\n" +
      "  },"
    );
  }

  // Fallback: format all issues concisely
  return issues
    .map((i) => {
      const path = i.path.join(".");
      return `${path}: ${i.message}`;
    })
    .join("; ");
}

/**
 * Schema for validating user extension exports.
 */
const UserExtensionSchema = z.object({
  type: z.string(),
  methods: z.array(z.record(z.string(), UserMethodSchema)),
  checks: z.array(z.record(z.string(), UserCheckSchema)).optional(),
});

/**
 * Result of loading user models from a directory.
 */
export interface LoadResult {
  loaded: string[];
  extended: string[];
  failed: Array<{ file: string; error: string }>;
}

/**
 * Loader for user-defined TypeScript models and extensions.
 *
 * Users export a plain `model` object to define new types, or an `extension`
 * object to add methods to existing types.
 * This loader validates the structure and registers/extends models with the global registry.
 */
export class UserModelLoader {
  private readonly denoRuntime: DenoRuntime;
  private readonly repoDir: string | null;
  private readonly datastoreResolver?: DatastorePathResolver;
  private readonly repository?: ExtensionRepository;
  /**
   * Per-loader cache from an extension's manifest directory to its
   * `additionalFiles` root. Pulled extensions always return
   * `<manifestDir>/files`; source-loaded extensions return
   * `<manifestDir>` (authors put assets next to the manifest). Caching
   * here means multiple models in the same extension share a single
   * walk-up and manifest stat.
   */
  private readonly extensionFilesRootCache = new Map<string, string>();

  /**
   * @param denoRuntime - Runtime manager for obtaining a deno binary path
   * @param repoDir - Repository root for writing bundles to .swamp/bundles/
   *                   (pass null to skip bundle caching)
   * @param datastoreResolver - Optional resolver for routing bundle paths
   *                            through the configured datastore tier
   * @param repository - W1b ExtensionRepository wrapping the catalog. Held
   *                     as a long-lived field per ADV-V2-1's option (a-2);
   *                     buildIndex / loadSingleType /
   *                     attachPendingExtensionsForType drop their per-call
   *                     catalog/repository params and read from this field.
   *                     Optional during the W1b transition to keep
   *                     loadModels() (which doesn't touch the catalog)
   *                     constructable in test paths that haven't migrated.
   *                     Required for buildIndex / loadSingleType /
   *                     attachPendingExtensionsForType — those throw if
   *                     the repository wasn't supplied.
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

  /**
   * Returns the held repository. Throws a clear error if the loader was
   * constructed without one and a catalog-touching method was invoked.
   * The optional-but-required-for-some-methods shape preserves test
   * paths that only exercise loadModels().
   */
  private requireRepository(method: string): ExtensionRepository {
    if (!this.repository) {
      throw new Error(
        `UserModelLoader.${method} requires an ExtensionRepository to be passed at construction time (W1b/(a-2) wiring).`,
      );
    }
    return this.repository;
  }

  /**
   * Resolves a bundle path through the datastore resolver when available,
   * falling back to the local .swamp/bundles/ path otherwise.
   */
  private resolveBundlePath(...segments: string[]): string {
    if (!this.repoDir) return "";
    if (this.datastoreResolver) {
      return this.datastoreResolver.resolvePath(
        SWAMP_SUBDIRS.bundles,
        ...segments,
      );
    }
    return join(
      this.repoDir,
      SWAMP_DATA_DIR,
      SWAMP_SUBDIRS.bundles,
      ...segments,
    );
  }

  /**
   * Loads all user models and extensions from the specified directory.
   * Uses two-pass loading: models first, then extensions.
   *
   * @param modelsDir - The directory containing user model/extension files
   * @returns Result containing lists of loaded, extended, and failed files
   */
  async loadModels(
    modelsDir: string,
    options?: {
      skipAlreadyRegistered?: boolean;
      /** Additional directories to scan (e.g. pulled extensions). */
      additionalDirs?: string[];
    },
  ): Promise<LoadResult> {
    const result: LoadResult = { loaded: [], extended: [], failed: [] };

    // Ensure swamp's Zod is available on globalThis before importing bundles.
    // This prevents dual-instance issues in the compiled binary.
    installZodGlobal();

    // Ensure deno is available before bundling
    const denoPath = await this.denoRuntime.ensureDeno();

    // Discover files from primary dir and any additional dirs, merging into
    // a single list of { file (relative), baseDir (absolute root) } tuples.
    // Primary dir files come first so user extensions take precedence.
    const allFiles: Array<{ file: string; baseDir: string }> = [];
    for (
      const dir of [modelsDir, ...(options?.additionalDirs ?? [])]
    ) {
      try {
        await Deno.stat(dir);
      } catch {
        continue; // Directory doesn't exist — skip
      }
      const files = await this.discoverFiles(dir);
      for (const file of files) {
        allFiles.push({ file, baseDir: dir });
      }
    }

    // Import all files and classify by export name
    const modelFiles: Array<{
      file: string;
      module: Record<string, unknown>;
      absolutePath: string;
    }> = [];
    const extensionFiles: Array<{
      file: string;
      module: Record<string, unknown>;
    }> = [];

    for (const { file, baseDir } of allFiles) {
      try {
        const absolutePath = resolve(baseDir, file);

        // Pre-check: only bundle files that declare a model or extension export.
        // This avoids attempting to bundle helper scripts with unbundleable
        // dependencies (e.g., native modules used via Deno.Command subprocess).
        const source = await Deno.readTextFile(absolutePath);
        if (!/export\s+const\s+(model|extension)\s*[=:]/.test(source)) {
          logger.debug`Skipping ${file} (no model/extension export found)`;
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

        if (module.model) {
          modelFiles.push({ file, module, absolutePath });
        } else if (module.extension) {
          extensionFiles.push({ file, module });
        }
        // Files with neither export are silently skipped (utility files)
      } catch (error) {
        result.failed.push({ file, error: String(error) });
      }
    }

    // Pass 1: Process all model exports (register new types)
    for (const { file, module, absolutePath } of modelFiles) {
      try {
        const parsed = UserModelSchema.safeParse(module.model);
        if (!parsed.success) {
          result.failed.push({
            file,
            error: formatUserModelError(parsed.error),
          });
          continue;
        }

        const userModel = parsed.data;

        // Validate namespace before registration
        const namespaceError = this.validateUserCollective(userModel.type);
        if (namespaceError) {
          result.failed.push({ file, error: namespaceError });
          continue;
        }

        const modelDef = this.convertToModelDefinition(userModel);
        modelDef.extensionFilesRoot = this.resolveExtensionFilesRoot(
          absolutePath,
        );

        // Defer self-contained bundling to first out-of-process execution (e.g. Docker).
        // Memoized so multiple executions in one process only bundle once.
        // Uses promise-based memoization to avoid duplicate work under concurrent calls.
        let bundlePromise: Promise<string> | undefined;
        modelDef.bundleSourceFactory = () => {
          bundlePromise ??= bundleExtension(
            absolutePath,
            denoPath,
            { selfContained: true },
          ).catch((error) => {
            bundlePromise = undefined;
            logger
              .warn`Failed to create self-contained bundle for ${file}: ${error}`;
            throw error;
          });
          return bundlePromise;
        };

        if (!modelRegistry.has(modelDef.type)) {
          modelRegistry.register(modelDef);
          result.loaded.push(file);
        } else if (options?.skipAlreadyRegistered) {
          // Silently skip — used during hot-load after auto-resolution
          continue;
        } else {
          result.failed.push({
            file,
            error: `Model type '${userModel.type}' already registered`,
          });
        }
      } catch (error) {
        result.failed.push({ file, error: String(error) });
      }
    }

    // Pass 2: Process all extension exports (extend existing types)
    for (const { file, module } of extensionFiles) {
      try {
        this.processExtension(file, module.extension, result);
      } catch (error) {
        result.failed.push({ file, error: String(error) });
      }
    }

    return result;
  }

  /**
   * Builds the bundle type index: discovers files, checks mtimes against catalog,
   * bundles only changed files, and populates the catalog with metadata.
   * Registers lazy entries in the model registry for all known types.
   *
   * This is the "index-only" mode — no bundles are imported into the runtime.
   * Types are registered as lazy entries that will be imported on demand.
   *
   * @param modelsDir - Primary directory containing model/extension files
   * @param options - Additional directories to scan
   */
  async buildIndex(
    modelsDir: string,
    options?: { additionalDirs?: string[] },
  ): Promise<LoadResult> {
    const repository = this.requireRepository("buildIndex");
    const catalog = repository.legacyStore;
    const result: LoadResult = { loaded: [], extended: [], failed: [] };

    installZodGlobal();
    const denoPath = await this.denoRuntime.ensureDeno();

    // Cold-start invalidation guards: layout-version, datastore-base-path,
    // and per-kind source-dirs-fingerprint, plus the populated-flag
    // check. Replaces the three hand-rolled guard blocks (and the legacy
    // global source_dirs_fingerprint key — W1b migrates this loader to
    // the per-kind key by passing kind="model" through invalidationGuards).
    const currentBasePath = this.resolveBundlePath();
    const currentSourceFingerprint = sourceDirsFingerprint(
      modelsDir,
      options?.additionalDirs,
    );
    const guard = repository.invalidationGuards({
      kind: "model",
      expectedLayoutVersion: BUNDLE_LAYOUT_VERSION,
      expectedDatastoreBasePath: currentBasePath,
      expectedSourceDirsFingerprint: currentSourceFingerprint,
    });
    if (guard.shouldInvalidate && guard.reason !== "not-populated") {
      logger
        .warn`Catalog invalidated for "model" rescan: ${guard.reason}`;
      catalog.invalidate("model");
    }

    // If catalog is already populated, register lazy entries from it
    // and do a lightweight mtime check for staleness.
    if (catalog.isPopulated("model")) {
      const staleFiles = await this.findStaleFiles(
        modelsDir,
        catalog,
        options?.additionalDirs,
      );

      if (staleFiles.length === 0) {
        // All fresh — register lazy entries from catalog and return
        this.registerLazyFromCatalog(catalog);
        return result;
      }

      // Some files are stale — rebundle and reimport just those.
      // Track type names registered by the model branch of
      // rebundleAndUpdateCatalog so we can attach catalog-recorded
      // extensions after the loop completes. Doing the attach inside the
      // loop would be order-dependent: if a model file is processed
      // before its extension file, the catalog row for the extension
      // doesn't exist yet and the attach finds nothing. Post-loop, every
      // extension row has been written.
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

      // Attach catalog-recorded extensions for any type that got
      // eagerly-registered during the loop. rebundleAndUpdateCatalog's
      // model branch calls modelRegistry.register() directly, which
      // bypasses the loadSingleType/importAndExtendBundle flow that
      // otherwise attaches extensions. Without this retry, user
      // extensions targeting a base whose source file just rebundled
      // (e.g. after `swamp extension pull --force`) would stay detached.
      for (const type of eagerlyRegisteredTypes) {
        if (!modelRegistry.get(type)) continue;
        await this.attachPendingExtensionsForType(type);
      }

      // Register lazy entries from the now-updated catalog
      this.registerLazyFromCatalog(catalog);
      return result;
    }

    // Catalog not populated — full import to bootstrap.
    // skipAlreadyRegistered avoids failures when a user extension
    // shadows a built-in type name during first-run bootstrap.
    const fullResult = await this.loadModels(modelsDir, {
      additionalDirs: options?.additionalDirs,
      skipAlreadyRegistered: true,
    });

    // Populate catalog from the now-loaded registry
    await this.populateCatalogFromRegistry(
      catalog,
      modelsDir,
      options?.additionalDirs,
    );
    catalog.markPopulated("model");
    catalog.setLayoutVersion(BUNDLE_LAYOUT_VERSION);
    catalog.setDatastoreBasePath(currentBasePath, "model");
    // Per-kind fingerprint key (W1b migration from the legacy global
    // key per ADV-9 / plan step 11). The legacy global codepath in
    // ExtensionCatalogStore.getSourceDirsFingerprint(undefined) stays
    // for one-version backward-compat with catalogs written before this
    // PR — a follow-up issue removes it after a release window.
    catalog.setSourceDirsFingerprint(currentSourceFingerprint, "model");

    // Migrate old flat-layout bundle files into namespaced subdirectories.
    if (this.repoDir) {
      this.migrateOldFlatBundles(options?.additionalDirs);
    }

    return fullResult;
  }

  /**
   * Migrates old flat-layout bundle files into namespaced subdirectories.
   * The old layout stored bundles at `.swamp/bundles/foo.js`. The new layout
   * uses `.swamp/bundles/<hash>/foo.js`. Moving (not deleting) preserves
   * pre-built bundles from pulled extensions that can't be rebundled locally.
   *
   * @param additionalDirs - The additional directories (sources + pulled)
   *   used to determine which hash namespace to move flat files into.
   *   Falls back to a "_migrated" namespace if no pulled dir is available.
   */
  private migrateOldFlatBundles(additionalDirs?: string[]): void {
    if (!this.repoDir) return;
    const bundlesDir = join(
      this.repoDir,
      SWAMP_DATA_DIR,
      SWAMP_SUBDIRS.bundles,
    );

    // Determine target namespace: use the pulled models dir if available,
    // otherwise use a fixed migration namespace.
    const pulledDir = additionalDirs?.find((d) =>
      d.includes("pulled-extensions")
    );
    const targetNs = pulledDir
      ? bundleNamespace(pulledDir, this.repoDir)
      : "_migrated";

    try {
      let migrated = 0;
      for (const entry of Deno.readDirSync(bundlesDir)) {
        if (entry.isFile && entry.name.endsWith(".js")) {
          const srcPath = join(bundlesDir, entry.name);
          const destDir = join(bundlesDir, targetNs);
          const destPath = join(destDir, entry.name);
          try {
            Deno.mkdirSync(destDir, { recursive: true });
            Deno.renameSync(srcPath, destPath);
            migrated++;
          } catch {
            // Best-effort — if move fails, leave the flat file
          }
        }
      }
      if (migrated > 0) {
        logger
          .warn`Migrated ${migrated} bundle file(s) to namespaced layout`;
      }
    } catch {
      // Bundles directory doesn't exist — nothing to migrate
    }
  }

  /**
   * Loads a single model type by its normalized type name.
   * Looks up the bundle path and any extensions from the catalog,
   * imports only those bundles, and registers/extends the type.
   *
   * @param typeNormalized - The normalized type name to load
   */
  async loadSingleType(typeNormalized: string): Promise<void> {
    const catalog = this.requireRepository("loadSingleType").legacyStore;
    installZodGlobal();

    // Load the base type bundle
    const entry = catalog.findByType(typeNormalized, "model");
    if (!entry) {
      throw new Error(`No catalog entry for type: ${typeNormalized}`);
    }

    await this.importAndRegisterBundle(entry);

    // Load all extensions targeting this type
    const extensions = catalog.findExtensionsForType(typeNormalized);
    for (const ext of extensions) {
      await this.importAndExtendBundle(ext);
    }
  }

  /**
   * Imports a single bundle and registers it as a model type.
   */
  private async importAndRegisterBundle(
    entry: ExtensionTypeRow,
  ): Promise<void> {
    if (modelRegistry.get(entry.type_normalized)) return; // Already loaded

    // Import directly via file URL for the cached bundle
    const module = await this.importBundleByPath({
      bundlePath: entry.bundle_path,
      sourcePath: entry.source_path,
    });

    if (!module.model) {
      throw new Error(`Bundle has no model export: ${entry.bundle_path}`);
    }

    const parsed = UserModelSchema.safeParse(module.model);
    if (!parsed.success) {
      throw new Error(formatUserModelError(parsed.error));
    }

    const modelDef = this.convertToModelDefinition(parsed.data);
    modelDef.extensionFilesRoot = this.resolveExtensionFilesRoot(
      entry.source_path,
    );

    // Set up self-contained bundle factory for out-of-process execution
    const denoPath = await this.denoRuntime.ensureDeno();
    let bundlePromise: Promise<string> | undefined;
    modelDef.bundleSourceFactory = () => {
      bundlePromise ??= bundleExtension(
        entry.source_path,
        denoPath,
        { selfContained: true },
      ).catch((error) => {
        bundlePromise = undefined;
        logger
          .warn`Failed to create self-contained bundle for ${entry.source_path}: ${error}`;
        throw error;
      });
      return bundlePromise;
    };

    modelRegistry.promoteFromLazy(modelDef);
  }

  /**
   * Attaches any catalog-recorded user extensions targeting the given base
   * type. Idempotent: if every method an extension defines is already on
   * the base, that extension is skipped silently.
   *
   * Precondition: the base type must be FULLY loaded in modelRegistry, not
   * merely lazy. Per PR #1116, modelRegistry.get returns undefined for lazy
   * entries, so callers guard with `!!modelRegistry.get(type)` before
   * invoking this method. When the base is not fully loaded, this method
   * no-ops (returns without attaching or throwing).
   *
   * This is the shared primitive used by call sites that register a base
   * via modelRegistry.register() directly, bypassing the
   * loadSingleType/importAndExtendBundle flow that would otherwise attach
   * extensions. Today those sites are hotLoadModels (after auto-resolve
   * installs a new extension) and buildIndex's stale-files loop (after
   * rebundleAndUpdateCatalog eagerly-registers a model).
   */
  async attachPendingExtensionsForType(
    typeNormalized: string,
  ): Promise<void> {
    const catalog = this.requireRepository("attachPendingExtensionsForType")
      .legacyStore;
    const base = modelRegistry.get(typeNormalized);
    if (!base) return;

    const extensions = catalog.findExtensionsForType(typeNormalized);
    for (const entry of extensions) {
      if (await this.allExtensionMethodsAttached(entry, base)) continue;
      await this.importAndExtendBundle(entry);
    }
  }

  /**
   * Returns true when every method AND check name declared by the extension
   * bundle is already present on the base. Used as the idempotency check so
   * re-attach over a fully-extended base stays silent. Checks must be
   * included in the comparison because ModelRegistry.extend throws on
   * duplicate check names too (model.ts:918-927) — skipping on method
   * overlap alone would silently miss a newly-added check. Failures to
   * import or parse the bundle return false so importAndExtendBundle can
   * surface the problem via its usual warn path.
   */
  private async allExtensionMethodsAttached(
    entry: ExtensionTypeRow,
    base: ModelDefinition,
  ): Promise<boolean> {
    let module: Record<string, unknown>;
    try {
      module = await this.importBundleByPath({
        bundlePath: entry.bundle_path,
        sourcePath: entry.source_path,
      });
    } catch {
      return false;
    }
    if (!module.extension) return false;

    const parsed = UserExtensionSchema.safeParse(module.extension);
    if (!parsed.success) return false;

    const methodNames = new Set<string>();
    for (const record of parsed.data.methods) {
      for (const name of Object.keys(record)) {
        methodNames.add(name);
      }
    }
    const checkNames = new Set<string>();
    for (const record of parsed.data.checks ?? []) {
      for (const name of Object.keys(record)) {
        checkNames.add(name);
      }
    }
    if (methodNames.size === 0 && checkNames.size === 0) return true;

    for (const name of methodNames) {
      if (base.methods[name] === undefined) return false;
    }
    for (const name of checkNames) {
      if (base.checks?.[name] === undefined) return false;
    }
    return true;
  }

  /**
   * Imports a single bundle and extends an existing model type.
   * Logs warnings for any failures during extension processing.
   */
  private async importAndExtendBundle(entry: ExtensionTypeRow): Promise<void> {
    const module = await this.importBundleByPath({
      bundlePath: entry.bundle_path,
      sourcePath: entry.source_path,
    });

    if (!module.extension) {
      throw new Error(`Bundle has no extension export: ${entry.bundle_path}`);
    }

    const result: LoadResult = { loaded: [], extended: [], failed: [] };
    this.processExtension(entry.source_path, module.extension, result);

    for (const failure of result.failed) {
      logger
        .warn`Failed to extend model from ${failure.file}: ${failure.error}`;
    }
  }

  /**
   * Imports a cached bundle directly by its file path.
   * Fixes zod imports and CJS/ESM interop before importing.
   *
   * Recovers from a missing bundle file (manual rm, partial GC, failed
   * previous bundle attempt, concurrent rm) by rebundling from source —
   * defense-in-depth alongside the freshness-gate check in
   * bundle_freshness.findStaleFiles. This catch covers paths that bypass
   * freshness, notably attachPendingExtensionsForType (called from
   * hotLoadModels after `swamp extension pull`) which iterates catalog
   * rows directly. swamp-club#212.
   *
   * Caller contract: this method is called at most once per `bundlePath`
   * per process. Deno caches imports by URL, so a second call for the same
   * path in one process would serve a pre-rebundle module from cache.
   */
  private async importBundleByPath(
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

  /**
   * Rebundles from source and writes to bundlePath. Used by the
   * importBundleByPath ENOENT fallback. Errors propagate — if rebundle
   * itself fails, the caller sees the rebundle failure rather than the
   * original ENOENT, which is more actionable.
   */
  private async recoverMissingBundle(
    paths: { bundlePath: string; sourcePath: string },
  ): Promise<string> {
    const denoPath = await this.denoRuntime.ensureDeno();
    const denoConfigPath = this.findNearestDenoConfig(paths.sourcePath);
    const js = await bundleExtension(paths.sourcePath, denoPath, {
      denoConfigPath,
    });
    await Deno.mkdir(dirname(paths.bundlePath), { recursive: true });
    await Deno.writeTextFile(paths.bundlePath, js);
    logger
      .warn`Recovered missing bundle for ${paths.sourcePath} on demand`;
    return js;
  }

  /**
   * Registers lazy entries for all model types in the catalog.
   * Only registers "model" kind entries — "extension" kind entries are not
   * standalone types but augment base types via modelRegistry.extend().
   * Extensions are loaded alongside their base type in loadSingleType().
   */
  private registerLazyFromCatalog(catalog: ExtensionCatalogStore): void {
    const entries = catalog.findByKind("model");
    for (const entry of entries) {
      // Skip ValidationFailed rows: their source content is fresh (the
      // fingerprint stops findStaleFiles from re-bundling) but the
      // module's schema is invalid, so the type is not safe to register
      // (swamp-club#209). Migrated to read `state` instead of
      // `validation_failed` per W1a (issue swamp-club#211).
      if (entry.state === "ValidationFailed") continue;
      modelRegistry.registerLazy({
        type: ModelType.create(entry.type_normalized),
        bundlePath: entry.bundle_path,
        sourcePath: entry.source_path,
        version: entry.version,
      });
    }
  }

  /**
   * Populates the catalog from the currently loaded registry.
   * Used on first run to bootstrap the catalog from a full import.
   */
  private async populateCatalogFromRegistry(
    catalog: ExtensionCatalogStore,
    modelsDir: string,
    additionalDirs?: string[],
  ): Promise<void> {
    // We can only populate entries that have bundle files on disk
    if (!this.repoDir) return;

    const bundleBaseDir = this.resolveBundlePath();
    // One cache per populate pass so shared deps (e.g. files in a
    // pulled extension's _lib/) are hashed once, not once per entry.
    const cache = createFreshnessCache();

    // Scan all directories for .ts files and write catalog entries for
    // those that have corresponding cached bundles
    const dirs = [modelsDir, ...(additionalDirs ?? [])];
    for (const dir of dirs) {
      try {
        await this.populateCatalogFromDir(dir, bundleBaseDir, catalog, cache);
      } catch {
        // Directory doesn't exist — skip
      }
    }
  }

  /**
   * Populates catalog entries from a single directory. Async because
   * source_fingerprint is computed via crypto.subtle.digest.
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
        Deno.statSync(bundlePath); // Ensure bundle exists

        // Read source to determine if model or extension and extract type
        const source = Deno.readTextFileSync(absolutePath);
        const modelMatch = /export\s+const\s+model\s*[=:]/.test(source);
        const extensionMatch = /export\s+const\s+extension\s*[=:]/.test(
          source,
        );

        if (!modelMatch && !extensionMatch) continue;

        // Extract the type name from the export const model/extension
        // object literal. The regex anchors on the export statement to
        // avoid matching unrelated `type: "..."` properties elsewhere
        // in the file (e.g., inside helper function calls or schemas).
        const typeMatch = source.match(
          /export\s+const\s+(?:model|extension)\s*=\s*\{[\s\S]*?type\s*:\s*["']([^"']+)["']/,
        );
        if (!typeMatch) {
          // The file has `export const model =` (or extension) but type
          // is not a string literal we can extract — emit a warning
          // instead of silently skipping.
          emitTypeExtractionFailure(
            absolutePath,
            extensionMatch ? "extension" : "model",
          );
          continue;
        }

        const typeNormalized = ModelType.create(typeMatch[1]).normalized;

        // Extract version from the same export block (anchored like type)
        const versionMatch = source.match(
          /export\s+const\s+(?:model|extension)\s*=\s*\{[\s\S]*?version\s*:\s*["']([^"']+)["']/,
        );

        const sourceFingerprint = await computeSourceFingerprint(
          absolutePath,
          dir,
          cache,
        );

        catalog.upsert({
          type_normalized: typeNormalized,
          kind: extensionMatch ? "extension" : "model",
          bundle_path: bundlePath,
          source_path: absolutePath,
          version: versionMatch?.[1] ?? "",
          description: "",
          extends_type: extensionMatch ? typeNormalized : "",
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
    modelsDir: string,
    catalog: ExtensionCatalogStore,
    additionalDirs?: string[],
  ): Promise<
    Array<{ absolutePath: string; relativePath: string; baseDir: string }>
  > {
    return await findStaleFilesShared({
      modelsDir,
      additionalDirs,
      catalog,
      discoverFiles: (dir) => this.discoverFiles(dir),
      kinds: ["model", "extension"],
    });
  }

  /**
   * Bundles a single source file and extracts its registered type metadata
   * WITHOUT writing to the catalog or registering at runtime. Returns
   * `{ kind, typeNormalized, bundlePath, fingerprint }` for model and
   * extension files, or `null` for files that aren't model/extensions.
   *
   * **W2 contract — load-bearing for I-Repo-1.** The lifecycle services
   * (InstallExtensionService etc.) call this to build the Extension
   * aggregate's Sources at install time, then call
   * `repository.save(extension)` to commit. If this method ever calls
   * `catalog.upsert` directly, I-Repo-1 silently stops firing at install
   * time — the unit test
   * `bundleAndIndexOne does not write catalog rows` is the regression
   * net for that class of bug.
   *
   * @throws Error on bundle build failure or schema validation failure.
   */
  public async bundleAndIndexOne(args: {
    absolutePath: string;
    relativePath: string;
    baseDir: string;
  }): Promise<
    | {
      kind: "model" | "extension";
      typeNormalized: string;
      bundlePath: string;
      fingerprint: string;
      fromCache: boolean;
    }
    | null
  > {
    const source = await Deno.readTextFile(args.absolutePath);
    if (!/export\s+const\s+(model|extension)\s*[=:]/.test(source)) {
      return null;
    }

    // Ensure swamp's Zod is available on globalThis before importing
    // bundles — same precondition as loadModels / buildIndex.
    installZodGlobal();
    const denoPath = await this.denoRuntime.ensureDeno();
    const { js, fromCache } = await this.bundleWithCache(
      args.absolutePath,
      args.relativePath,
      denoPath,
      args.baseDir,
    );
    const module = await this.importBundle(js, args.relativePath, args.baseDir);
    const fingerprint = await computeSourceFingerprint(
      args.absolutePath,
      args.baseDir,
    );

    if (module.model) {
      const parsed = UserModelSchema.safeParse(module.model);
      if (!parsed.success) {
        throw new Error(formatUserModelError(parsed.error));
      }
      return {
        kind: "model",
        typeNormalized: ModelType.create(parsed.data.type).normalized,
        bundlePath: this.getBundlePath(args.relativePath, args.baseDir),
        fingerprint,
        fromCache,
      };
    }

    if (module.extension) {
      const parsed = UserExtensionSchema.safeParse(module.extension);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      return {
        kind: "extension",
        typeNormalized: ModelType.create(parsed.data.type).normalized,
        bundlePath: this.getBundlePath(args.relativePath, args.baseDir),
        fingerprint,
        fromCache,
      };
    }

    return null;
  }

  /**
   * Rebundles a single file and updates the catalog entry.
   */
  /**
   * Returns the normalized type of the file when the model branch executes,
   * whether or not register() fires (a prior boot may have left the type
   * registered). buildIndex uses this to know which types to attach pending
   * extensions to AFTER the stale-files loop — see the post-loop block in
   * buildIndex. Returns undefined for extension files (their attachment is
   * deferred to loadSingleType via the catalog row written here) and for
   * non-model/extension files.
   */
  private async rebundleAndUpdateCatalog(
    absolutePath: string,
    relativePath: string,
    denoPath: string,
    baseDir: string,
    catalog: ExtensionCatalogStore,
  ): Promise<string | undefined> {
    const source = await Deno.readTextFile(absolutePath);
    if (!/export\s+const\s+(model|extension)\s*[=:]/.test(source)) {
      return undefined; // Not a model/extension file
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

    if (module.model) {
      const bundlePath = this.getBundlePath(relativePath, baseDir);
      const parsed = UserModelSchema.safeParse(module.model);
      if (!parsed.success) {
        markCatalogValidationFailed({
          catalog,
          sourcePath: absolutePath,
          kind: "model",
          bundlePath,
          sourceMtime,
          sourceFingerprint: effectiveFingerprint,
        });
        throw new Error(formatUserModelError(parsed.error));
      }
      const typeNormalized = ModelType.create(parsed.data.type).normalized;

      catalog.upsert({
        type_normalized: typeNormalized,
        kind: "model",
        bundle_path: bundlePath,
        source_path: absolutePath,
        version: parsed.data.version,
        description: "",
        extends_type: "",
        source_mtime: sourceMtime,
        source_fingerprint: effectiveFingerprint,
      });

      // Also register the full definition since we already imported it
      const modelDef = this.convertToModelDefinition(parsed.data);
      modelDef.extensionFilesRoot = this.resolveExtensionFilesRoot(
        absolutePath,
      );
      const denoPathForBundle = denoPath;
      let bundlePromise: Promise<string> | undefined;
      modelDef.bundleSourceFactory = () => {
        bundlePromise ??= bundleExtension(
          absolutePath,
          denoPathForBundle,
          { selfContained: true },
        ).catch((error) => {
          bundlePromise = undefined;
          throw error;
        });
        return bundlePromise;
      };

      if (!modelRegistry.has(modelDef.type)) {
        modelRegistry.register(modelDef);
      }

      return typeNormalized;
    } else if (module.extension) {
      const bundlePath = this.getBundlePath(relativePath, baseDir);
      const parsed = UserExtensionSchema.safeParse(module.extension);
      if (!parsed.success) {
        markCatalogValidationFailed({
          catalog,
          sourcePath: absolutePath,
          kind: "extension",
          bundlePath,
          sourceMtime,
          sourceFingerprint: effectiveFingerprint,
        });
        throw new Error(parsed.error.message);
      }
      const typeNormalized = ModelType.create(parsed.data.type).normalized;

      catalog.upsert({
        type_normalized: typeNormalized,
        kind: "extension",
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

  /**
   * Returns the bundle cache path for a relative source path, namespaced
   * by a hash of the base directory to prevent collisions between sources.
   */
  private getBundlePath(relativePath: string, baseDir: string): string {
    if (!this.repoDir) return "";
    return this.resolveBundlePath(
      bundleNamespace(baseDir, this.repoDir),
      relativePath.replace(/\.ts$/, ".js"),
    );
  }

  /**
   * Walks up from a source file to find the nearest deno.json or deno.jsonc.
   * Returns the absolute path to the config file, or undefined if none found.
   * Stops at the filesystem root or at the consumer repo root to avoid
   * picking up an unrelated project's config.
   */
  private findNearestDenoConfig(absolutePath: string): string | undefined {
    let dir = dirname(absolutePath);
    const root = resolve("/");
    while (dir !== root) {
      // Stop at the consumer repo boundary
      if (this.repoDir && resolve(dir) === resolve(this.repoDir)) break;

      for (const name of ["deno.json", "deno.jsonc"]) {
        const candidate = join(dir, name);
        try {
          Deno.statSync(candidate);
          return candidate;
        } catch {
          // Not found — keep walking up
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  }

  /**
   * Bundles an extension file, using cached bundle from .swamp/bundles/ when possible.
   * Writes the bundle to disk for future caching and potential publishing.
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
      // cached bundle anyway. Skipping the rebundle attempt cuts cold
      // startup on large pulled trees (106 spawns → 0 on @swamp/aws/ec2).
      //
      // Only for pulled extensions — user-developed extensions (locals
      // and source-mounted) must always attempt the build so edits take
      // effect and failures surface visibly (swamp-club#274).
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
        // Discover the nearest deno.json for import map resolution.
        // This is essential for source extensions that live in a separate
        // directory tree with their own deno.json.
        const denoConfigPath = this.findNearestDenoConfig(absolutePath);
        if (denoConfigPath) {
          logger
            .warn`Using discovered deno config for ${relativePath}: ${denoConfigPath}`;
        }
        const js = await bundleExtension(absolutePath, denoPath, {
          denoConfigPath,
        });
        const bundleBoundary = this.resolveBundlePath();
        await assertSafePath(bundlePath, bundleBoundary);
        await Deno.mkdir(dirname(bundlePath), { recursive: true });
        await Deno.writeTextFile(bundlePath, js);
        logger.debug`Wrote bundle cache: ${bundlePath}`;
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
              // Do NOT touch the cache mtime — the next run should retry
              // bundling so the user sees the error again until fixed.
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
    const denoConfigPath = this.findNearestDenoConfig(absolutePath);
    if (denoConfigPath) {
      logger
        .warn`Using discovered deno config for ${absolutePath}: ${denoConfigPath}`;
    }
    const js = await bundleExtension(absolutePath, denoPath, {
      denoConfigPath,
    });
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
    // Rewrite zod imports and fix CJS/ESM interop at import-time — catches
    // old cached bundles. Both rewrites are idempotent.
    const rewritten = fixCjsEsmInterop(rewriteZodImports(js));

    if (this.repoDir) {
      const ns = baseDir ? bundleNamespace(baseDir, this.repoDir) : "";
      const segments = ns
        ? [ns, relativePath.replace(/\.ts$/, ".js")]
        : [relativePath.replace(/\.ts$/, ".js")];
      const bundlePath = this.resolveBundlePath(...segments);

      try {
        await Deno.stat(bundlePath);
        // Fix zod imports and CJS/ESM interop in the cached file on disk
        // so old cached bundles get fixed permanently.
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
   * Validates that a user-defined model type follows the required collective conventions.
   *
   * Requirements:
   * - Must have at least 2 segments (e.g., "@myorg/echo" or "myorg/echo")
   *
   * @param rawType - The raw type string from the user model
   * @returns Error message if validation fails, undefined if valid
   */
  private validateUserCollective(rawType: string): string | undefined {
    const normalized = ModelType.create(rawType).normalized;

    // Must have at least 2 segments
    const segmentCount = ModelType.getSegmentCount(normalized);
    if (segmentCount < 2) {
      return `Model type '${rawType}' must have at least 2 segments. Expected format: @<collective>/<name> or <collective>/<name> (e.g., @myorg/my-model or myorg/my-model)`;
    }

    return undefined;
  }

  /**
   * Processes an extension export and extends the target model type.
   */
  private processExtension(
    file: string,
    extensionExport: unknown,
    result: LoadResult,
  ): void {
    const parsed = UserExtensionSchema.safeParse(extensionExport);
    if (!parsed.success) {
      result.failed.push({ file, error: parsed.error.message });
      return;
    }

    const ext = parsed.data;

    // Flatten methods array into a single record, checking for duplicate names
    const flatMethods: Record<
      string,
      z.infer<typeof UserMethodSchema>
    > = {};
    for (const methodRecord of ext.methods) {
      for (const [name, method] of Object.entries(methodRecord)) {
        if (flatMethods[name]) {
          result.failed.push({
            file,
            error:
              `Duplicate method name '${name}' within extension methods array`,
          });
          return;
        }
        flatMethods[name] = method;
      }
    }

    // Get the target model for extension
    const targetModel = modelRegistry.get(ext.type);
    if (!targetModel) {
      result.failed.push({
        file,
        error: `Cannot extend unregistered model type: ${ext.type}`,
      });
      return;
    }

    // Convert extension methods using wrapUserExecute
    const methods: Record<string, MethodDefinition> = {};
    for (const [name, method] of Object.entries(flatMethods)) {
      methods[name] = {
        description: method.description,
        ...(method.kind ? { kind: method.kind as MethodKind } : {}),
        arguments: method.arguments,
        execute: this.wrapUserExecute(method.execute),
      };
    }

    // Flatten checks array into a single record (if provided)
    let checks: Record<string, CheckDefinition> | undefined;
    if (ext.checks && ext.checks.length > 0) {
      const flatChecks: Record<string, z.infer<typeof UserCheckSchema>> = {};
      for (const checkRecord of ext.checks) {
        for (const [name, check] of Object.entries(checkRecord)) {
          if (flatChecks[name]) {
            result.failed.push({
              file,
              error:
                `Duplicate check name '${name}' within extension checks array`,
            });
            return;
          }
          flatChecks[name] = check;
        }
      }
      checks = Object.fromEntries(
        Object.entries(flatChecks).map(([name, check]) => [
          name,
          {
            description: check.description,
            labels: check.labels,
            appliesTo: check.appliesTo,
            execute: check.execute,
          },
        ]),
      );
    }

    // Extend the model
    try {
      modelRegistry.extend(ext.type, methods, checks);
      result.extended.push(file);
    } catch (error) {
      result.failed.push({ file, error: String(error) });
    }
  }

  /**
   * Wraps a user execute function to pass through dataHandles from the result.
   * User models write data via context.writeResource() / context.createFileWriter() and return handles.
   */
  private wrapUserExecute(
    userExecuteFn: UserExecuteFn,
  ): (
    args: Record<string, unknown>,
    context: MethodContext,
  ) => Promise<MethodResult> {
    return async (args, context): Promise<MethodResult> => {
      const userResult = await userExecuteFn(args, context);

      return { dataHandles: userResult.dataHandles };
    };
  }

  /**
   * Resolve the extension-files root for a model loaded from `sourcePath`.
   * Walks up looking for `manifest.yaml`, stopping at filesystem root.
   * Returns `<manifestDir>/files` for pulled extensions,
   * `<manifestDir>` for source-loaded extensions, or undefined when no
   * manifest is found (built-in types, direct-content source layout
   * without a manifest, loose source dirs).
   */
  private resolveExtensionFilesRoot(
    sourcePath: string,
  ): string | undefined {
    let currentDir = dirname(sourcePath);
    // Walk up, stopping at root (dirname of root === root).
    while (true) {
      const cached = this.extensionFilesRootCache.get(currentDir);
      if (cached !== undefined) return cached;

      const manifestPath = join(currentDir, "manifest.yaml");
      try {
        Deno.lstatSync(manifestPath);
        // Found. Pulled extensions live under .swamp/pulled-extensions/
        // and extract additionalFiles into a `files/` subdir on pull;
        // source-loaded extensions resolve relative to the manifest dir.
        const normalized = currentDir.replace(/\\/g, "/");
        const pulledMarker = `/${SWAMP_DATA_DIR}/pulled-extensions/`;
        const root = normalized.includes(pulledMarker)
          ? join(currentDir, "files")
          : currentDir;
        this.extensionFilesRootCache.set(currentDir, root);
        return root;
      } catch {
        // Not here; walk up.
      }

      const parent = dirname(currentDir);
      if (parent === currentDir) return undefined;
      currentDir = parent;
    }
  }

  /**
   * Converts a user model export to a proper ModelDefinition.
   */
  private convertToModelDefinition(
    userModel: z.infer<typeof UserModelSchema>,
  ): ModelDefinition {
    const modelType = ModelType.create(userModel.type);

    // Wrap user's execute functions to convert plain objects to proper entities
    const methods: Record<string, MethodDefinition> = {};
    for (const [name, method] of Object.entries(userModel.methods)) {
      methods[name] = {
        description: method.description,
        ...(method.kind ? { kind: method.kind as MethodKind } : {}),
        arguments: method.arguments,
        execute: this.wrapUserExecute(method.execute),
      };
    }

    // Convert user upgrades to VersionUpgrade[]
    const upgrades: VersionUpgrade[] | undefined = userModel.upgrades?.map(
      (u) => ({
        toVersion: u.toVersion,
        description: u.description,
        upgradeAttributes: u.upgradeAttributes,
      }),
    );

    // Pass through checks directly (no wrapping needed)
    const checks: Record<string, CheckDefinition> | undefined = userModel.checks
      ? Object.fromEntries(
        Object.entries(userModel.checks).map(([name, check]) => [
          name,
          {
            description: check.description,
            labels: check.labels,
            appliesTo: check.appliesTo,
            execute: check.execute,
          },
        ]),
      )
      : undefined;

    return {
      type: modelType,
      version: userModel.version,
      globalArguments: userModel.globalArguments,
      resources: userModel.resources,
      files: userModel.files,
      methods,
      ...(checks ? { checks } : {}),
      ...(upgrades && upgrades.length > 0 ? { upgrades } : {}),
      ...(userModel.reports ? { reports: userModel.reports } : {}),
    };
  }

  /**
   * Recursively discovers TypeScript files in the given directory.
   * Returns relative paths (e.g., "aws/ec2_start.ts", "echo_audit.ts").
   * Excludes test files.
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
