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
import type { UpstreamExtensionsMap } from "../../infrastructure/persistence/upstream_extensions.ts";
import type { SwampError } from "../errors.ts";
import type { DoctorAggregateReport } from "./doctor_aggregate.ts";
import type { RepairReport } from "./doctor_repair.ts";
import type { ReconcileTransition } from "./reconcile_from_disk_service.ts";
import { extractTopLevelRoot } from "./layout.ts";

/**
 * Public registry name for the doctor report. The infrastructure-layer
 * `ExtensionKind` enum has six values (`model`, `extension`, `vault`,
 * `driver`, `datastore`, `report`) but only five user-facing registries
 * exist — `extension` is a sub-kind of the model loader (it indicates
 * a user extension extending an existing model type) and folds into
 * the `model` row in this report.
 */
export type DoctorRegistryName =
  | "model"
  | "vault"
  | "driver"
  | "datastore"
  | "report";

/** Fixed run order — also the row order in the rendered report. */
export const DOCTOR_REGISTRY_ORDER: ReadonlyArray<DoctorRegistryName> = [
  "model",
  "vault",
  "driver",
  "datastore",
  "report",
];

/** Per-registry result emitted on `kind-completed`. */
export interface DoctorRegistryResult {
  registry: DoctorRegistryName;
  status: "pass" | "fail";
}

/** Final overall status — `pass` when every registry passed. */
export type DoctorOverallStatus = "pass" | "fail";

/**
 * A single orphan finding: a file or directory present under an
 * extension's tracked roots but NOT in the current lockfile entry's
 * files[]. Surfaces in the report's `orphanFiles` warnings list.
 */
export interface DoctorOrphanFile {
  extensionName: string;
  /** Repo-relative path. */
  path: string;
}

export interface DoctorWarning {
  sourcePath: string;
  category: string;
  message: string;
}

/** Final report shape — used by the renderer's JSON mode. */
export interface DoctorExtensionsReport {
  overallStatus: DoctorOverallStatus;
  /** Map of registry name → its result. All five keys always present. */
  registries: Record<DoctorRegistryName, DoctorRegistryResult>;
  /**
   * Filesystem-orphan findings — paths present under tracked roots but
   * absent from the current lockfile's files[] list. Reported as
   * WARNINGS, not failures: `overallStatus` is unchanged by orphan
   * presence so existing CI gates that key on `overallStatus === "fail"`
   * keep working through the transition. A future release may promote
   * orphans to failure once routine install/pull/update calls have
   * drained pre-existing dirt from the ecosystem.
   */
  orphanFiles: DoctorOrphanFile[];
  /**
   * W6: Per-extension aggregate state with RowState distribution,
   * catalog orphans, and bundle orphans. Always present when the
   * catalog is readable; undefined only on early abort.
   */
  aggregateState?: DoctorAggregateReport;
  /**
   * W6: Repair report — present only when `--repair` was requested.
   * Contains the list of operations (dry-run or applied).
   */
  repairReport?: RepairReport;
  /**
   * State transitions from the most recent reconcile pass. Always
   * present (empty array when no transitions occurred). Each entry
   * captures a source's fromState → toState with reason.
   */
  recentTransitions: readonly ReconcileTransition[];
  /**
   * Errors thrown by `ensureLoaded()` for each registry. Empty when every
   * loader succeeds. Keyed by registry name; value is the error message.
   */
  loaderErrors?: ReadonlyMap<DoctorRegistryName, string>;
  /**
   * Extension load warnings — diagnostic findings about suboptimal-but-working
   * patterns (e.g. non-literal type fields that prevent static catalog
   * extraction). Advisory only: `overallStatus` is unchanged by warning
   * presence. Empty array when no warnings were emitted.
   */
  warnings: readonly DoctorWarning[];
}

/**
 * Streaming events from the doctor extensions pipeline. The `error`
 * variant is required by libswamp's stream-protocol type system but
 * is not produced today — every per-registry failure is folded into
 * the report. Reserved for future failure modes that need to
 * short-circuit the stream mid-run.
 */
export type DoctorExtensionsEvent =
  | { kind: "kind-started"; registry: DoctorRegistryName }
  | { kind: "kind-completed"; result: DoctorRegistryResult }
  | { kind: "completed"; report: DoctorExtensionsReport }
  | { kind: "error"; error: SwampError };

/**
 * Per-registry callbacks supplied by the CLI. Each entry pairs the
 * loader-trigger with its reset-flag callback so the doctor service
 * can force a re-run regardless of whether the registry was already
 * warmed earlier in the same process.
 */
export interface DoctorRegistryDeps {
  registry: DoctorRegistryName;
  ensureLoaded: () => Promise<void>;
  resetLoadedFlag: () => void;
}

/** Dependencies for the doctor extensions operation. */
export interface DoctorExtensionsDeps {
  /** One entry per registry, in DOCTOR_REGISTRY_ORDER. */
  registries: ReadonlyArray<DoctorRegistryDeps>;
  /**
   * Lockfile repository — captures upstream_extensions.json at
   * construction so the orphan-detection phase can walk every
   * per-extension root. Missing lockfile yields an empty cache (the
   * orphan walk becomes a no-op).
   */
  lockfileRepository: LockfileRepository;
  /** Repo root used to resolve repo-relative paths for filesystem walks. */
  repoDir: string;
  /**
   * Tool-aware skills directory (e.g. `.claude/skills`). Repo-relative.
   * Skill paths are tracked as directory paths only, so the orphan walk
   * skips them — extractTopLevelRoot needs this to recognise skill paths.
   */
  skillsDir: string;
  abortSignal: AbortSignal;
  /**
   * W6: Callback that builds aggregate state from the catalog after
   * loaders have run. Injected by the CLI so the service doesn't
   * construct infrastructure objects directly.
   */
  buildAggregateState?: () => Promise<DoctorAggregateReport>;
  /**
   * W6: Callback that runs repair operations. Injected by the CLI.
   * Called only when repair is requested. Receives the aggregate
   * report and the apply flag.
   */
  runRepair?: (
    aggregateReport: DoctorAggregateReport,
  ) => Promise<RepairReport>;
  /**
   * Returns transitions from the most recent reconcile pass. Injected
   * by the CLI so the generator doesn't depend on infrastructure
   * objects. Returns an empty array when reconcile was skipped or
   * failed.
   */
  getRecentTransitions?: () => readonly ReconcileTransition[];
  /**
   * Returns extension load warnings emitted during this process run.
   * Injected by the CLI — maps emitter events to DoctorWarning shape.
   */
  getWarnings?: () => readonly DoctorWarning[];
  /**
   * Resets the extension load warning state. Called at the start of
   * each doctor invocation (alongside resetLoadedFlag) to prevent
   * stale warnings from the CLI bootstrap leaking into doctor output.
   */
  resetWarnings?: () => void;
}

function overallStatus(
  results: ReadonlyArray<DoctorRegistryResult>,
): DoctorOverallStatus {
  return results.some((r) => r.status === "fail") ? "fail" : "pass";
}

/**
 * Normalises a path to use forward-slash separators regardless of the
 * platform `relative()` and `walk()` produced. The tracked-set entries
 * in the lockfile and the helpers in `layout.ts` (PULLED_PREFIX,
 * extractTopLevelRoot) all assume forward slashes; orphan detection
 * needs the same normalisation on its walked paths so set membership
 * works on Windows where native paths use backslashes.
 */
function toForwardSlashes(p: string): string {
  return p.replaceAll("\\", "/");
}

/**
 * Walks every per-extension root referenced by a lockfile entry and
 * returns paths on disk that are NOT in the entry's `tracked` set.
 *
 * For each entry, derive the unique top-level roots from its
 * `files[]` list via `extractTopLevelRoot` (skips skills, legacy
 * paths, and unknown locations) and walk each root recursively. Any
 * file path under a walked root that isn't in `tracked` is an orphan.
 *
 * All path-set membership comparisons are done in forward-slash form
 * so the same lockfile entries match on both POSIX and Windows.
 *
 * Empty lockfile / missing entries / no recognisable roots → no walk,
 * no orphans. Walk errors (e.g. missing root dir) are tolerated and
 * yield no orphans for that root.
 */
async function detectOrphanFiles(
  upstreamMap: UpstreamExtensionsMap,
  repoDir: string,
  skillsDir: string,
): Promise<DoctorOrphanFile[]> {
  const orphans: DoctorOrphanFile[] = [];
  const normalizedSkillsDir = toForwardSlashes(skillsDir);

  for (const [extensionName, entry] of Object.entries(upstreamMap)) {
    const trackedFiles = (entry.files ?? []).map(toForwardSlashes);
    if (trackedFiles.length === 0) continue;

    const tracked = new Set(trackedFiles);
    const roots = new Set<string>();
    for (const file of trackedFiles) {
      const root = extractTopLevelRoot(file, normalizedSkillsDir);
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
 * Runs `ensureLoaded()` across all five user-facing extension
 * registries AND walks every per-extension root for orphan files.
 *
 * Two distinct concerns share this entry point:
 * 1. Loader validation — does each registry's loader run cleanly
 *    against the on-disk extensions? Failures fold into per-registry
 *    `failures` and DO flip `overallStatus` to `"fail"`.
 * 2. Filesystem orphan detection — are there files under each
 *    extension's tracked roots that aren't declared by the lockfile?
 *    Findings surface in `report.orphanFiles` as WARNINGS and do NOT
 *    flip `overallStatus`. CI gates on `overallStatus === "fail"`
 *    keep working through the transition.
 *
 * The first steps of the generator are a state reset + a
 * `resetLoadedFlag()` on every registry so the diagnostic forces a
 * full re-load even when the CLI bootstrap already warmed the
 * registries earlier in the process.
 *
 * Order of operations is the load-bearing invariant: callers must
 * NOT pre-reset state — the service owns that ordering.
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

  let orphanFiles: DoctorOrphanFile[] = [];
  if (!deps.abortSignal.aborted) {
    const upstreamMap = deps.lockfileRepository.getAllEntries();
    orphanFiles = await detectOrphanFiles(
      upstreamMap,
      deps.repoDir,
      deps.skillsDir,
    );
  }

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
  const warnings = deps.getWarnings?.() ?? [];

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
      overallStatus: overallStatus(results),
      registries,
      orphanFiles,
      aggregateState,
      repairReport,
      recentTransitions,
      loaderErrors: loaderErrors.size > 0 ? loaderErrors : undefined,
      warnings,
    },
  };
}
