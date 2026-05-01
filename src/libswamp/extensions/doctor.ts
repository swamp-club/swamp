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

import { walk } from "@std/fs";
import { join, relative } from "@std/path";
import type { ExtensionLoadWarning } from "../../infrastructure/logging/extension_load_warnings.ts";
import type { UpstreamExtensionsMap } from "../../infrastructure/persistence/upstream_extensions.ts";
import type { SwampError } from "../errors.ts";
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

/** A single registry's failure record after the model/extension fold. */
export interface DoctorRegistryFailure {
  file: string;
  error: string;
}

/** Per-registry result emitted on `kind-completed`. */
export interface DoctorRegistryResult {
  registry: DoctorRegistryName;
  status: "pass" | "fail";
  failures: DoctorRegistryFailure[];
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
  /** Reads the captured warnings array (defensive snapshot). */
  getWarnings: () => ReadonlyArray<ExtensionLoadWarning>;
  /** Clears the captured warnings array + dedupe state. */
  resetState: () => void;
  /**
   * Reads upstream_extensions.json so the orphan-detection phase can
   * walk every per-extension root. Missing lockfile yields {} (the
   * orphan walk becomes a no-op).
   */
  readUpstreamExtensions: () => Promise<UpstreamExtensionsMap>;
  /** Repo root used to resolve repo-relative paths for filesystem walks. */
  repoDir: string;
  /**
   * Tool-aware skills directory (e.g. `.claude/skills`). Repo-relative.
   * Skill paths are tracked as directory paths only, so the orphan walk
   * skips them — extractTopLevelRoot needs this to recognise skill paths.
   */
  skillsDir: string;
  abortSignal: AbortSignal;
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

/**
 * Filters the captured warnings down to the ones owned by a given
 * registry. The model registry absorbs both `model` and `extension`
 * ExtensionKind values — `extension` warnings come exclusively from
 * the model loader's catalog-population path (see
 * `user_model_loader.ts:populateCatalogFromDir`) and so logically
 * belong to the model registry's row.
 */
function partitionForRegistry(
  registry: DoctorRegistryName,
  warnings: ReadonlyArray<ExtensionLoadWarning>,
): DoctorRegistryFailure[] {
  return warnings
    .filter((w) => {
      if (registry === "model") {
        return w.kind === "model" || w.kind === "extension";
      }
      return w.kind === registry;
    })
    .map((w) => ({ file: w.file, error: w.error }));
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
  // Step (a): clear the emitter so we only see what THIS pass produces.
  deps.resetState();
  // Step (b): force every registry's loader to re-run, even if a prior
  // CLI codepath already warmed it.
  for (const reg of deps.registries) {
    reg.resetLoadedFlag();
  }

  const results: DoctorRegistryResult[] = [];

  // Step (c): iterate each registry, run its loader, partition the
  // captured warnings, and emit a per-registry result.
  for (const reg of deps.registries) {
    if (deps.abortSignal.aborted) break;

    yield { kind: "kind-started", registry: reg.registry };

    try {
      await reg.ensureLoaded();
    } catch (error) {
      // A throw from ensureLoaded means the loader couldn't even run.
      // Convert it into a synthetic failure so the report still surfaces
      // the problem and the remaining registries continue running.
      const synthetic: ExtensionLoadWarning = {
        kind: reg.registry === "model" ? "model" : reg.registry,
        file: `<${reg.registry} loader>`,
        error: error instanceof Error ? error.message : String(error),
      };
      // Fold the synthetic failure into the partitioned list directly —
      // we cannot rely on the emitter capturing it.
      const captured = partitionForRegistry(reg.registry, deps.getWarnings());
      const failures = [...captured, {
        file: synthetic.file,
        error: synthetic.error,
      }];
      const result: DoctorRegistryResult = {
        registry: reg.registry,
        status: "fail",
        failures,
      };
      results.push(result);
      yield { kind: "kind-completed", result };
      continue;
    }

    const failures = partitionForRegistry(reg.registry, deps.getWarnings());
    const result: DoctorRegistryResult = {
      registry: reg.registry,
      status: failures.length > 0 ? "fail" : "pass",
      failures,
    };
    results.push(result);
    yield { kind: "kind-completed", result };
  }

  const registries = Object.fromEntries(
    results.map((r) => [r.registry, r]),
  ) as Record<DoctorRegistryName, DoctorRegistryResult>;

  // Filesystem orphan detection — independent of loader validation.
  // Always runs (unless aborted) so users get a warning even when
  // every loader passes. Errors are not folded into `overallStatus`.
  let orphanFiles: DoctorOrphanFile[] = [];
  if (!deps.abortSignal.aborted) {
    const upstreamMap = await deps.readUpstreamExtensions();
    orphanFiles = await detectOrphanFiles(
      upstreamMap,
      deps.repoDir,
      deps.skillsDir,
    );
  }

  yield {
    kind: "completed",
    report: {
      overallStatus: overallStatus(results),
      registries,
      orphanFiles,
    },
  };
}
