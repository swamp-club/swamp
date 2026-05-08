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

import { getLogger } from "@logtape/logtape";
import { basename as pathBasename, join, relative, resolve } from "@std/path";
import {
  type Extension,
  makeExtension,
  makeLocalExtension,
  markSourceMissing,
  observeFreshSource,
  recordBundleBuildFailed,
  recordBundled,
  recordEntryPointUnreadable,
  tombstoneAll,
} from "../../domain/extensions/extension.ts";
import type { LocalManifestIdentity } from "../../infrastructure/persistence/local_manifest_reader.ts";
import { makeSource } from "../../domain/extensions/source.ts";
import { makeSourceLocation } from "../../domain/extensions/source_location.ts";
import { makeBundleLocation } from "../../domain/extensions/bundle_location.ts";
import {
  computeSourceFingerprint,
  createFreshnessCache,
  type FreshnessCache,
} from "../../domain/extensions/bundle_freshness.ts";
import type { RowStateTag } from "../../domain/extensions/row_state.ts";
import type { SourceLocation } from "../../domain/extensions/source_location.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import type {
  ExtensionKind,
} from "../../infrastructure/persistence/extension_catalog_store.ts";
import { BUNDLE_LAYOUT_VERSION } from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { ExtensionLoader } from "../../domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../../domain/extensions/model_kind_adapter.ts";
import { vaultKindAdapter } from "../../domain/extensions/vault_kind_adapter.ts";
import { driverKindAdapter } from "../../domain/extensions/driver_kind_adapter.ts";
import { datastoreKindAdapter } from "../../domain/extensions/datastore_kind_adapter.ts";
import { reportKindAdapter } from "../../domain/extensions/report_kind_adapter.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import {
  collectDirsForKind,
  expandSourcePaths,
  readSwampSources,
  resolveSourceExtensionDirs,
} from "../../infrastructure/persistence/swamp_sources_repository.ts";

const logger = getLogger(["swamp", "extensions", "reconcile"]);

/** Subdirectories of a per-extension subtree, paired with their kind. */
const KIND_DIRS = [
  "models",
  "vaults",
  "drivers",
  "datastores",
  "reports",
] as const;

type KindDir = typeof KIND_DIRS[number];

/**
 * A single state transition produced by reconcile. Structured value —
 * W6's `swamp doctor extensions` renders this directly.
 */
export interface ReconcileTransition {
  readonly source: SourceLocation;
  readonly fromState: RowStateTag | null;
  readonly toState: RowStateTag;
  readonly reason: string;
}

/**
 * Result of a reconcile run.
 */
export interface ReconcileResult {
  readonly transitions: readonly ReconcileTransition[];
  readonly applied: boolean;
}

/**
 * W3 application service — reconciles on-disk extension state against
 * the persisted catalog aggregate state.
 *
 * Walks the on-disk source tree across all three origin types (locals,
 * pulled, source-mounted), loads the current aggregate state via
 * {@link ExtensionRepository.loadAll}, diffs the two, and emits
 * {@link ReconcileTransition} records.
 *
 * Delegates to per-loader `bundleAndIndexOne` for type extraction —
 * NOT {@link InstallExtensionService}. The source is already on disk
 * and the lockfile already exists; reconcile is post-hoc state repair,
 * not a fresh install.
 *
 * **Trigger points:** cold-start (when `anyKindNeedsInvalidation()`
 * returns true) + explicit `swamp doctor extensions` call. NOT on
 * every command.
 *
 * **dryRun mode:** when `dryRun: true`, collects transitions without
 * calling `repository.saveAll()`. Returns the same structured result
 * either way.
 *
 * **Transition-count guardrail:** if any single run would transition
 * > 50% of existing rows, the run aborts and returns the transitions
 * without applying them. Catches mass-tombstone bugs before they
 * destroy legitimate rows.
 */
export class ReconcileFromDiskService {
  private readonly denoRuntime: DenoRuntime;
  private readonly repository: ExtensionRepository;
  private readonly lockfileRepository: LockfileRepository;
  private readonly repoDir: string;
  private readonly localManifestIdentity: LocalManifestIdentity | null;

  constructor(args: {
    denoRuntime: DenoRuntime;
    repository: ExtensionRepository;
    lockfileRepository: LockfileRepository;
    repoDir: string;
    localManifestIdentity?: LocalManifestIdentity | null;
  }) {
    this.denoRuntime = args.denoRuntime;
    this.repository = args.repository;
    this.lockfileRepository = args.lockfileRepository;
    this.repoDir = resolve(args.repoDir);
    this.localManifestIdentity = args.localManifestIdentity ?? null;
  }

  async execute(
    options?: { dryRun?: boolean },
  ): Promise<ReconcileResult> {
    const dryRun = options?.dryRun ?? false;
    const transitions: ReconcileTransition[] = [];

    const existingExtensions = this.repository.loadAll();
    const totalExistingRows = countSources(existingExtensions);

    const { extensions: reconciledExtensions, migrationTransitions } =
      await this.reconcileAll(
        existingExtensions,
        transitions,
      );

    // Identity-migration tombstones are expected mass-transitions, not
    // repair anomalies. Exclude them from the guardrail ratio so a
    // version bump in a repo with ≥10 local sources doesn't permanently
    // block the migration.
    const repairCount = transitions.length - migrationTransitions;
    const GUARDRAIL_MIN_ROWS = 10;
    if (
      repairCount > 0 && totalExistingRows >= GUARDRAIL_MIN_ROWS
    ) {
      const ratio = repairCount / totalExistingRows;
      if (ratio > 0.5) {
        if (!dryRun) this.markKindsPopulated();
        logger
          .warn`Skipped catalog repair: too many entries would change (${repairCount}/${totalExistingRows}). Run ${"swamp doctor extensions"} to inspect.`;
        return { transitions, applied: false };
      }
    }

    if (!dryRun && transitions.length > 0) {
      this.repository.saveAll(reconciledExtensions);
      this.markAllKindsPopulated();
      logger
        .info`Extension catalog updated: ${transitions.length} ${
        transitions.length === 1 ? "entry" : "entries"
      } repaired`;
    } else if (!dryRun && totalExistingRows === 0) {
      this.markAllKindsPopulated();
    } else if (transitions.length === 0) {
      logger.debug`Reconcile complete: no transitions`;
    }

    return { transitions, applied: !dryRun && transitions.length > 0 };
  }

  private async reconcileAll(
    existingExtensions: Extension[],
    transitions: ReconcileTransition[],
  ): Promise<{ extensions: Extension[]; migrationTransitions: number }> {
    const cache = createFreshnessCache();
    const result: Extension[] = [];
    let migrationTransitions = 0;

    // Gather ALL local + source-mounted on-disk sources into one map,
    // then reconcile the @local/<repo> aggregate once. Prevents the
    // duplicate-extension bug where reconcileLocals and
    // reconcileSourceMounted each build separate @local/<repo>
    // aggregates that conflict on saveAll.
    const localExt = await this.reconcileLocalAndSourceMounted(
      existingExtensions,
      transitions,
      cache,
    );

    // Pulled extensions next. Processed BEFORE the local aggregate in
    // the result array so saveAll DELETEs pulled-orphan rows before
    // local INSERTs. Prevents the manifest-deletion case from losing
    // data: old manifest-named rows are inferred as "pulled" after the
    // manifest is removed, orphan-tombstoned, and their DELETEs must
    // not clobber the new @local/ rows at the same source_path.
    const pulledExts = await this.reconcilePulled(
      existingExtensions,
      transitions,
      cache,
    );
    result.push(...pulledExts);

    // Atomic identity migration: tombstone stale local-origin aggregates
    // BEFORE the new aggregate. saveAll processes in array order —
    // tombstones must come first so removeBySourcePath deletes old rows
    // before upsertWithIdentity writes new ones at the same paths.
    if (localExt) {
      for (const existing of existingExtensions) {
        if (existing.origin !== "local") continue;
        if (
          existing.name === localExt.name &&
          existing.version === localExt.version
        ) continue;
        const reason =
          `identity migration: ${existing.name}@${existing.version} → ${localExt.name}@${localExt.version}`;
        for (const [loc, source] of existing.sources) {
          if (source.state.tag === "Tombstoned") continue;
          transitions.push({
            source: loc,
            fromState: source.state.tag,
            toState: "Tombstoned",
            reason,
          });
          migrationTransitions++;
        }
        result.push(tombstoneAll(existing));
      }
      result.push(localExt);
    }

    return { extensions: result, migrationTransitions };
  }

  private async reconcileLocalAndSourceMounted(
    existingExtensions: Extension[],
    transitions: ReconcileTransition[],
    cache: FreshnessCache,
  ): Promise<Extension | null> {
    const manifest = this.localManifestIdentity;
    const basename = pathBasename(this.repoDir) || "unknown";
    const localName = manifest ? manifest.name : `@local/${basename}`;
    const localVersion = manifest ? manifest.version : "0.0.0";

    // Look for an existing aggregate matching the canonical identity.
    const existing = existingExtensions.find(
      (e) => e.name === localName && e.origin === "local",
    );

    // Gather ALL local + source-mounted on-disk sources into one map.
    const onDiskSources = new Map<string, { kind: KindDir; baseDir: string }>();

    // Local extensions under extensions/<kind>/
    for (const kindDir of KIND_DIRS) {
      const dir = join(this.repoDir, "extensions", kindDir);
      const files = await collectTsFiles(dir);
      for (const absolutePath of files) {
        onDiskSources.set(absolutePath, { kind: kindDir, baseDir: dir });
      }
    }

    // Source-mounted extensions from .swamp-sources.yaml
    const config = await readSwampSources(this.repoDir);
    if (config) {
      const expanded = await expandSourcePaths(config, this.repoDir);
      const resolved = await resolveSourceExtensionDirs(expanded);
      for (const sourceDirs of resolved) {
        for (const kindDir of KIND_DIRS) {
          const dirs = collectDirsForKind([sourceDirs], kindDir);
          for (const dir of dirs) {
            const files = await collectTsFiles(dir);
            for (const absolutePath of files) {
              onDiskSources.set(absolutePath, { kind: kindDir, baseDir: dir });
            }
          }
        }
      }
    }

    let ext: Extension;
    if (existing && existing.version !== localVersion) {
      ext = makeExtension({
        name: localName,
        version: localVersion,
        origin: "local",
        extensionRoot: this.repoDir,
        sources: existing.sources.values(),
      });
      logger
        .info`Local extension ${localName} version migrated: ${existing.version} → ${localVersion}`;
    } else if (existing) {
      ext = existing;
    } else if (manifest) {
      ext = makeExtension({
        name: localName,
        version: localVersion,
        origin: "local",
        extensionRoot: this.repoDir,
        sources: [],
      });
    } else {
      ext = makeLocalExtension({ repoRoot: this.repoDir, basename });
    }

    ext = await this.reconcileExtension(
      ext,
      onDiskSources,
      transitions,
      cache,
      "local",
    );

    if (ext.sources.size === 0 && !existing) return null;
    return ext;
  }

  private async reconcilePulled(
    existingExtensions: Extension[],
    transitions: ReconcileTransition[],
    cache: FreshnessCache,
  ): Promise<Extension[]> {
    const pulledRoot = swampPath(this.repoDir, "pulled-extensions");
    const result: Extension[] = [];
    const lockfileEntries = this.lockfileRepository.getAllEntries();

    for (const extensionName of Object.keys(lockfileEntries)) {
      const extRoot = join(pulledRoot, extensionName);
      const version = this.lockfileRepository.getLockedVersion(extensionName) ??
        "";
      const existing = existingExtensions.find(
        (e) => e.name === extensionName && e.version === version,
      );

      const onDiskSources = new Map<
        string,
        { kind: KindDir; baseDir: string }
      >();
      for (const kindDir of KIND_DIRS) {
        const dir = join(extRoot, kindDir);
        const files = await collectTsFiles(dir);
        for (const absolutePath of files) {
          onDiskSources.set(absolutePath, { kind: kindDir, baseDir: dir });
        }
      }

      let ext = existing ?? makeExtension({
        name: extensionName,
        version,
        origin: "pulled",
        extensionRoot: extRoot,
        sources: [],
      });

      ext = await this.reconcileExtension(
        ext,
        onDiskSources,
        transitions,
        cache,
        "pulled",
      );

      result.push(ext);
    }

    // Handle orphaned pulled extensions: in catalog but not in lockfile.
    for (const existing of existingExtensions) {
      if (existing.origin !== "pulled") continue;
      if (lockfileEntries[existing.name]) continue;
      let ext = existing;
      for (const [loc, source] of ext.sources) {
        if (source.state.tag === "Tombstoned") continue;
        transitions.push({
          source: loc,
          fromState: source.state.tag,
          toState: "Tombstoned",
          reason: "orphan: no lockfile entry",
        });
        ext = markSourceMissing(ext, { location: loc, bundleOnDisk: null });
      }
      result.push(ext);
    }

    return result;
  }

  private async reconcileExtension(
    extension: Extension,
    onDiskSources: Map<string, { kind: KindDir; baseDir: string }>,
    transitions: ReconcileTransition[],
    cache: FreshnessCache,
    originType: "local" | "pulled",
  ): Promise<Extension> {
    let ext = extension;

    // Phase 1: Sources on disk — ensure they're in the aggregate.
    for (const [absolutePath, { kind, baseDir }] of onDiskSources) {
      const loc = makeSourceLocation(absolutePath, ext.extensionRoot);
      const existingSource = findSourceByPath(ext, loc.canonicalPath);
      // Use the existing source's id for aggregate operations (Map key
      // equality is by reference). For new sources, use the fresh loc.
      const effectiveLoc = existingSource?.id ?? loc;

      if (existingSource && existingSource.state.tag === "Indexed") {
        try {
          const fp = await computeSourceFingerprint(
            absolutePath,
            baseDir,
            cache,
          );
          if (fp === existingSource.fingerprint) continue;
        } catch {
          // Fingerprint failed — fall through to re-bundle.
        }
      }

      const loader = this.makeLoaderForKind(kind);
      const relativePath = relative(baseDir, absolutePath);
      try {
        const out = await loader.bundleAndIndexOne({
          absolutePath,
          relativePath,
          baseDir,
        });
        if (!out) continue;

        const fp = await computeSourceFingerprint(
          absolutePath,
          baseDir,
          cache,
        );
        const bundle = makeBundleLocation(out.bundlePath, fp);
        const fromState = existingSource?.state.tag ?? null;

        ext = observeFreshSource(ext, {
          location: effectiveLoc,
          kind: out.kind,
          fingerprint: fp,
          type: out.typeNormalized,
          bundle,
        });

        ext = recordBundled(ext, {
          location: effectiveLoc,
          type: out.typeNormalized,
          bundle,
        });

        if (fromState !== "Indexed") {
          transitions.push({
            source: effectiveLoc,
            fromState,
            toState: "Indexed",
            reason: fromState === null
              ? "new source discovered on disk"
              : `re-indexed from ${fromState}`,
          });
        }
      } catch (error) {
        const fromState = existingSource?.state.tag ?? null;
        const errorMsg = error instanceof Error ? error.message : String(error);

        if (existingSource) {
          ext = recordBundleBuildFailed(ext, {
            location: effectiveLoc,
            lastError: errorMsg,
          });
        } else {
          ext = makeExtensionWithNewSource(ext, effectiveLoc, kind, {
            tag: "BundleBuildFailed",
            lastError: errorMsg,
          });
        }

        if (fromState !== "BundleBuildFailed") {
          transitions.push({
            source: effectiveLoc,
            fromState,
            toState: "BundleBuildFailed",
            reason: `bundle build failed: ${errorMsg}`,
          });
        }
      }
    }

    // Phase 2: Sources in aggregate but NOT on disk → transition.
    for (const [loc, source] of ext.sources) {
      if (source.state.tag === "Tombstoned") continue;
      if (onDiskSources.has(loc.canonicalPath)) continue;

      const fromState = source.state.tag;

      if (originType === "pulled") {
        // Pulled: lockfile is canonical. Source missing but lockfile
        // entry present → EntryPointUnreadable (re-fetch is W4).
        // This path only fires if the lockfile has the entry —
        // orphan handling (no lockfile entry) is in reconcilePulled.
        ext = recordEntryPointUnreadable(ext, {
          location: loc,
          lastError: "source file missing from disk",
        });
        transitions.push({
          source: loc,
          fromState,
          toState: "EntryPointUnreadable",
          reason: "pulled source missing from disk (lockfile entry present)",
        });
      } else {
        // Local / source-mounted: source is canonical → tombstone.
        const bundleOnDisk = extractBundlePath(source.state);
        ext = markSourceMissing(ext, { location: loc, bundleOnDisk });
        const newState = bundleOnDisk ? "OrphanedBundleOnly" : "Tombstoned";
        transitions.push({
          source: loc,
          fromState,
          toState: newState,
          reason: "source file deleted from disk",
        });
      }
    }

    return ext;
  }

  private makeLoaderForKind(
    kindDir: KindDir,
  ): {
    bundleAndIndexOne: (args: {
      absolutePath: string;
      relativePath: string;
      baseDir: string;
    }) => Promise<
      | {
        kind:
          | "model"
          | "extension"
          | "vault"
          | "driver"
          | "datastore"
          | "report";
        typeNormalized: string;
        bundlePath: string;
        fingerprint: string;
      }
      | null
    >;
  } {
    switch (kindDir) {
      case "models":
        return new ExtensionLoader(
          this.denoRuntime,
          modelKindAdapter,
          this.repoDir,
          undefined,
          this.repository,
        );
      case "vaults":
        return new ExtensionLoader(
          this.denoRuntime,
          vaultKindAdapter,
          this.repoDir,
          undefined,
          this.repository,
        );
      case "drivers":
        return new ExtensionLoader(
          this.denoRuntime,
          driverKindAdapter,
          this.repoDir,
          undefined,
          this.repository,
        );
      case "datastores":
        return new ExtensionLoader(
          this.denoRuntime,
          datastoreKindAdapter,
          this.repoDir,
          undefined,
          this.repository,
        );
      case "reports":
        return new ExtensionLoader(
          this.denoRuntime,
          reportKindAdapter,
          this.repoDir,
          undefined,
          this.repository,
        );
    }
  }

  private markKindsPopulated(): void {
    const kinds: ExtensionKind[] = [
      "model",
      "vault",
      "driver",
      "datastore",
      "report",
    ];
    this.repository.setLayoutVersion(BUNDLE_LAYOUT_VERSION);
    for (const kind of kinds) {
      this.repository.markPopulated(kind);
    }
  }

  private markAllKindsPopulated(): void {
    this.markKindsPopulated();
    const m = this.localManifestIdentity;
    this.repository.setManifestIdentity(
      m ? `${m.name}@${m.version}` : null,
    );
  }
}

function findSourceByPath(
  extension: Extension,
  canonicalPath: string,
): import("../../domain/extensions/source.ts").Source | undefined {
  for (const [loc, source] of extension.sources) {
    if (loc.canonicalPath === canonicalPath) return source;
  }
  return undefined;
}

function countSources(extensions: Extension[]): number {
  let count = 0;
  for (const ext of extensions) {
    for (const source of ext.sources.values()) {
      if (source.state.tag !== "Tombstoned") count++;
    }
  }
  return count;
}

function extractBundlePath(
  state: { tag: string; bundle?: { canonicalPath: string } },
): ReturnType<typeof makeBundleLocation> | null {
  if ("bundle" in state && state.bundle) {
    return state.bundle as ReturnType<typeof makeBundleLocation>;
  }
  return null;
}

function makeExtensionWithNewSource(
  extension: Extension,
  location: SourceLocation,
  kindDir: KindDir,
  state: { tag: "BundleBuildFailed"; lastError: string },
): Extension {
  const kind = kindDirToExtensionKind(kindDir);
  const source = makeSource({
    id: location,
    kind,
    fingerprint: "",
    state,
  });
  return makeExtension({
    ...extension,
    sources: [...extension.sources.values(), source],
  });
}

function kindDirToExtensionKind(
  kindDir: KindDir,
): "model" | "vault" | "driver" | "datastore" | "report" {
  switch (kindDir) {
    case "models":
      return "model";
    case "vaults":
      return "vault";
    case "drivers":
      return "driver";
    case "datastores":
      return "datastore";
    case "reports":
      return "report";
  }
}

async function collectTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isFile && entry.name.endsWith(".ts")) {
        out.push(path);
      } else if (entry.isDirectory && !entry.name.startsWith("_")) {
        out.push(...await collectTsFiles(path));
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return out;
}
