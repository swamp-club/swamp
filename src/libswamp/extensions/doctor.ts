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

import type { ExtensionLoadWarning } from "../../infrastructure/logging/extension_load_warnings.ts";
import type { SwampError } from "../errors.ts";

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

/** Final report shape — used by the renderer's JSON mode. */
export interface DoctorExtensionsReport {
  overallStatus: DoctorOverallStatus;
  /** Map of registry name → its result. All five keys always present. */
  registries: Record<DoctorRegistryName, DoctorRegistryResult>;
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
  abortSignal: AbortSignal;
}

function overallStatus(
  results: ReadonlyArray<DoctorRegistryResult>,
): DoctorOverallStatus {
  return results.some((r) => r.status === "fail") ? "fail" : "pass";
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
 * registries and reports per-registry pass/fail. The first steps of
 * the generator are a state reset + a `resetLoadedFlag()` on every
 * registry so the diagnostic forces a full re-load even when the CLI
 * bootstrap already warmed the registries earlier in the process.
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

  yield {
    kind: "completed",
    report: { overallStatus: overallStatus(results), registries },
  };
}
