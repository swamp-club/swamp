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

import { walk } from "@std/fs";
import { join, relative } from "@std/path";
import type { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import {
  findMissingPulledExtensions,
  type MissingPulledExtensionState,
  pathsToRemoveForReinstall,
  readInstalledEntriesWithRetry,
} from "../../infrastructure/persistence/installed_entries.ts";
import type { UpstreamExtensionsMap } from "../../infrastructure/persistence/upstream_extensions.ts";
import type { SwampError } from "../errors.ts";
import type { DoctorAggregateReport } from "./doctor_aggregate.ts";
import type { RepairReport } from "./doctor_repair.ts";
import type { ReconcileTransition } from "./reconcile_from_disk_service.ts";
import { extractTopLevelRootMulti } from "./layout.ts";
import type { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { ExtensionLoadWarningEvent } from "../../infrastructure/logging/extension_load_warnings.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { getExtensionMemberCollisions } from "../../domain/extensions/model_kind_adapter.ts";

/**
 * extension is a sub-kind of the model loader and folds into the model row, so
 * only five registries are user-facing
 */
export type DoctorRegistryName =
  | "model"
  | "vault"
  | "datastore"
  | "report"
  | "webhook";

export const DOCTOR_REGISTRY_ORDER: ReadonlyArray<DoctorRegistryName> = [
  "model",
  "vault",
  "datastore",
  "report",
  "webhook",
];

export interface DoctorRegistryResult {
  registry: DoctorRegistryName;
  status: "pass" | "fail";
}

export type DoctorOverallStatus = "pass" | "fail";

export interface DoctorOrphanFile {
  extensionName: string;
  path: string;
}

/**
 * install: swamp extension install restores it; deleteAndAutoResolve: delete
 * removeToReinstall and the auto-resolver reinstalls it, since a pull would pin
 * it in the team lockfile; nextUse: the auto-resolver installs it when needed
 */
export type DoctorMissingExtensionRemedy =
  | "install"
  | "deleteAndAutoResolve"
  | "nextUse";

export interface DoctorMissingExtension {
  name: string;
  state: MissingPulledExtensionState;
  expectedPath: string;
  missingFiles: string[];
  missingFileCount: number;
  /** advisory when true: overallStatus is unchanged */
  installsOnNextUse: boolean;
  remedy: DoctorMissingExtensionRemedy;
  removeToReinstall?: string[];
}

export interface DoctorMissingExtensionsResult {
  missing: DoctorMissingExtension[];
  warning?: DoctorWarning;
}

export interface DoctorWarning {
  /**
   * for ExtensionAttachFailed it is the model type that could not be loaded,
   * since no single file is at fault
   */
  sourcePath: string;
  category: string;
  message: string;
}

export interface DoctorMemberCollision {
  type: string;
  memberKind: "method" | "check" | "resource";
  name: string;
  winner: string | null;
  losers: readonly string[];
}

/**
 * set when the managed config base is unresolved: a rescan against the in-repo
 * guess would tombstone every team extension's rows, and repairs would write
 * where the datastore never sees them
 */
export interface DoctorRescanSkipped {
  reason: string;
  repairSkipped: boolean;
}

export interface DoctorExtensionsReport {
  overallStatus: DoctorOverallStatus;
  registries: Record<DoctorRegistryName, DoctorRegistryResult>;
  /**
   * reported as warnings, not failures: overallStatus is unchanged by orphans
   * so existing CI gates keyed on it keep working
   */
  orphanFiles: DoctorOrphanFile[];
  /** any entry that does not install on next use makes overallStatus fail */
  missingExtensions: DoctorMissingExtension[];
  aggregateState?: DoctorAggregateReport;
  repairReport?: RepairReport;
  rescanSkipped?: DoctorRescanSkipped;
  recentTransitions: readonly ReconcileTransition[];
  loaderErrors?: ReadonlyMap<DoctorRegistryName, string>;
  /** advisory only: overallStatus is unchanged by warnings */
  warnings: readonly DoctorWarning[];
  memberCollisions: readonly DoctorMemberCollision[];
}

/**
 * the error variant is required by the stream protocol but not produced today:
 * every per-registry failure is folded into the report
 */
export type DoctorExtensionsEvent =
  | { kind: "kind-started"; registry: DoctorRegistryName }
  | { kind: "kind-completed"; result: DoctorRegistryResult }
  | { kind: "completed"; report: DoctorExtensionsReport }
  | { kind: "error"; error: SwampError };

/**
 * pairs each loader with its reset-flag callback so doctor can force a re-run
 * even when the registry was already warmed in this process
 */
export interface DoctorRegistryDeps {
  registry: DoctorRegistryName;
  ensureLoaded: () => Promise<void>;
  resetLoadedFlag: () => void;
}

export interface DoctorExtensionsDeps {
  registries: ReadonlyArray<DoctorRegistryDeps>;
  /**
   * captures upstream_extensions.json at construction; a missing lockfile
   * yields an empty cache, so the orphan walk is a no-op
   */
  lockfileRepository: LockfileRepository;
  repoDir: string;
  /**
   * skill paths are tracked as a dir root or, when merged into a shared dir,
   * file by file; the orphan walk skips both, and extractTopLevelRoot needs
   * these to recognise skill paths
   */
  skillsDirs: string[];
  abortSignal: AbortSignal;
  buildAggregateState?: () => Promise<DoctorAggregateReport>;
  runRepair?: (
    aggregateReport: DoctorAggregateReport,
  ) => Promise<RepairReport>;
  getRecentTransitions?: () => readonly ReconcileTransition[];
  getWarnings?: () => readonly DoctorWarning[];
  /**
   * called at the start of each doctor run so stale warnings from the CLI
   * bootstrap do not leak into the output
   */
  resetWarnings?: () => void;
  attachExtensionMembers?: () => Promise<readonly DoctorWarning[]>;
  getMemberCollisions?: () => readonly DoctorMemberCollision[];
  findMissingExtensions?: () => Promise<DoctorMissingExtensionsResult>;
  rescanSkipped?: DoctorRescanSkipped;
}

function overallStatus(
  results: ReadonlyArray<DoctorRegistryResult>,
  missingExtensions: ReadonlyArray<DoctorMissingExtension>,
): DoctorOverallStatus {
  return results.some((r) => r.status === "fail") ||
      missingExtensions.some((m) => !m.installsOnNextUse)
    ? "fail"
    : "pass";
}

/**
 * the lockfile's tracked-set entries and the layout.ts helpers assume forward
 * slashes, so walked paths are normalised the same way for set membership to
 * work on Windows
 */
function toForwardSlashes(p: string): string {
  return p.replaceAll("\\", "/");
}

/**
 * walk errors, such as a missing root dir, are tolerated and yield no orphans
 * for that root
 */
async function detectOrphanFiles(
  upstreamMap: UpstreamExtensionsMap,
  repoDir: string,
  skillsDirs: string[],
): Promise<DoctorOrphanFile[]> {
  const orphans: DoctorOrphanFile[] = [];
  const normalizedSkillsDirs = skillsDirs.map(toForwardSlashes);

  for (const [extensionName, entry] of Object.entries(upstreamMap)) {
    const trackedFiles = (entry.files ?? []).map(toForwardSlashes);
    if (trackedFiles.length === 0) continue;

    const tracked = new Set(trackedFiles);
    const roots = new Set<string>();
    for (const file of trackedFiles) {
      const root = extractTopLevelRootMulti(
        file,
        normalizedSkillsDirs,
        extensionName,
      );
      if (root !== null) {
        roots.add(root);
      }
    }

    for (const root of roots) {
      // join() uses the platform separator; walk() returns platform-
      // native paths. We normalise to forward-slash AFTER computing
      // `relative()` so the tracked-set comparison is platform-stable.
      const absoluteRoot = join(repoDir, root);
      try {
        for await (
          const walkEntry of walk(absoluteRoot, {
            includeDirs: false,
            includeSymlinks: false,
          })
        ) {
          const relPath = toForwardSlashes(
            relative(repoDir, walkEntry.path),
          );
          if (!tracked.has(relPath)) {
            orphans.push({ extensionName, path: relPath });
          }
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
    }
  }

  return orphans;
}

const FAILURE_STATE_TAGS = new Set([
  "ValidationFailed",
  "BundleBuildFailed",
  "EntryPointUnreadable",
]);

function registryHasFailures(
  registry: DoctorRegistryName,
  aggregateState: DoctorAggregateReport | undefined,
): boolean {
  if (!aggregateState) return false;
  return aggregateState.sourceDetails.some((d) => {
    if (!FAILURE_STATE_TAGS.has(d.stateTag)) return false;
    if (registry === "model") {
      return d.kind === "model" || d.kind === "extension";
    }
    return d.kind === registry;
  });
}

/**
 * loader failures flip overallStatus to fail, orphan findings do not; callers
 * must not pre-reset, as the service owns the reset and forces a full re-load
 */
export async function* doctorExtensions(
  deps: DoctorExtensionsDeps,
): AsyncIterable<DoctorExtensionsEvent> {
  deps.resetWarnings?.();
  for (const reg of deps.registries) {
    reg.resetLoadedFlag();
  }

  const loaderErrors = new Map<DoctorRegistryName, string>();

  for (const reg of deps.registries) {
    if (deps.abortSignal.aborted) break;

    yield { kind: "kind-started", registry: reg.registry };

    try {
      await reg.ensureLoaded();
    } catch (error) {
      loaderErrors.set(
        reg.registry,
        error instanceof Error ? error.message : String(error),
      );
    }

    yield {
      kind: "kind-completed",
      result: {
        registry: reg.registry,
        status: loaderErrors.has(reg.registry)
          ? "fail" as const
          : "pass" as const,
      },
    };
  }

  let attachWarnings: readonly DoctorWarning[] = [];
  if (!deps.abortSignal.aborted && deps.attachExtensionMembers) {
    attachWarnings = await deps.attachExtensionMembers();
  }

  let orphanFiles: DoctorOrphanFile[] = [];
  if (!deps.abortSignal.aborted) {
    const upstreamMap = deps.lockfileRepository.getAllEntries();
    orphanFiles = await detectOrphanFiles(
      upstreamMap,
      deps.repoDir,
      deps.skillsDirs,
    );
  }

  let missingResult: DoctorMissingExtensionsResult = { missing: [] };
  if (!deps.abortSignal.aborted && deps.findMissingExtensions) {
    missingResult = await deps.findMissingExtensions();
  }
  const missingExtensions = missingResult.missing;

  let aggregateState: DoctorAggregateReport | undefined;
  if (!deps.abortSignal.aborted && deps.buildAggregateState) {
    aggregateState = await deps.buildAggregateState();
  }

  let repairReport: RepairReport | undefined;
  if (
    !deps.abortSignal.aborted && deps.runRepair && aggregateState
  ) {
    repairReport = await deps.runRepair(aggregateState);
  }

  const recentTransitions = deps.getRecentTransitions?.() ?? [];
  const warnings = [
    ...(deps.getWarnings?.() ?? []),
    ...attachWarnings,
    ...(missingResult.warning ? [missingResult.warning] : []),
  ];
  const memberCollisions = deps.getMemberCollisions?.() ?? [];

  const results: DoctorRegistryResult[] = DOCTOR_REGISTRY_ORDER.map((name) => ({
    registry: name,
    status: (loaderErrors.has(name) ||
        registryHasFailures(name, aggregateState))
      ? "fail" as const
      : "pass" as const,
  }));

  const registries = Object.fromEntries(
    results.map((r) => [r.registry, r]),
  ) as Record<DoctorRegistryName, DoctorRegistryResult>;

  yield {
    kind: "completed",
    report: {
      overallStatus: overallStatus(results, missingExtensions),
      registries,
      orphanFiles,
      missingExtensions,
      aggregateState,
      repairReport,
      rescanSkipped: deps.rescanSkipped,
      recentTransitions,
      loaderErrors: loaderErrors.size > 0 ? loaderErrors : undefined,
      warnings,
      memberCollisions,
    },
  };
}

/** warnings raised without a category keep the TypeExtractionFailed label */
export function toDoctorWarnings(
  events: ReadonlyArray<ExtensionLoadWarningEvent>,
): DoctorWarning[] {
  return events.map((w) => ({
    sourcePath: w.file,
    category: w.category ?? "TypeExtractionFailed",
    message: w.error,
  }));
}

export function extensionMemberDoctorDeps(
  catalog: Pick<ExtensionCatalogStore, "findByKind">,
): Pick<
  DoctorExtensionsDeps,
  "attachExtensionMembers" | "getMemberCollisions"
> {
  return {
    attachExtensionMembers: async () => {
      const targets = new Set<string>();
      for (const row of catalog.findByKind("extension")) {
        if (row.extends_type) targets.add(row.extends_type);
      }
      const failures: DoctorWarning[] = [];
      for (const type of [...targets].sort()) {
        try {
          // `has` parses the type name, so a malformed row is reported here
          // rather than aborting the whole doctor run.
          if (!modelRegistry.has(type)) continue;
          await modelRegistry.ensureTypeLoaded(type);
        } catch (error) {
          failures.push({
            sourcePath: type,
            category: "ExtensionAttachFailed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return failures;
    },
    getMemberCollisions: () => getExtensionMemberCollisions(),
  };
}

/**
 * shared by the CLI and serve so both report the entries the startup warning
 * names; a lockfile that stays unreadable becomes a warning, not a failed run
 */
export function missingExtensionsDoctorDep(
  repoDir: string,
  lockfilePath: string,
  localLockfilePath: string | undefined,
  options?: { waitBeforeRetry?: () => Promise<void> },
): Pick<DoctorExtensionsDeps, "findMissingExtensions"> {
  return {
    findMissingExtensions: async () => {
      try {
        const installed = await readInstalledEntriesWithRetry(
          lockfilePath,
          localLockfilePath,
          options?.waitBeforeRetry,
        );
        const found = await findMissingPulledExtensions(
          repoDir,
          installed,
          localLockfilePath,
        );
        const missing = found.map((m): DoctorMissingExtension => {
          const remedy: DoctorMissingExtensionRemedy = m.installsOnNextUse
            ? "nextUse"
            : m.autoResolved
            ? "deleteAndAutoResolve"
            : "install";
          return {
            name: m.name,
            state: m.state,
            expectedPath: m.expectedPath,
            missingFiles: m.missingFiles,
            missingFileCount: m.missingFileCount,
            installsOnNextUse: m.installsOnNextUse,
            remedy,
            ...(remedy === "deleteAndAutoResolve"
              ? {
                removeToReinstall: pathsToRemoveForReinstall(
                  repoDir,
                  m.name,
                  installed.entries,
                ).map(toForwardSlashes),
              }
              : {}),
          };
        });
        return {
          missing: missing.sort((a, b) => a.name.localeCompare(b.name)),
        };
      } catch (error) {
        return {
          missing: [],
          warning: {
            sourcePath: lockfilePath,
            category: "LockfileUnreadable",
            message: `Cannot check pinned extensions on disk: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        };
      }
    },
  };
}
