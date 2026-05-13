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

// `swamp doctor extensions` — runs ensureLoaded() across all five user
// extension registries, captures load failures via the issue-177
// emitter, and emits a per-registry pass/fail report.
//
// Relies on `doctor` not being in NON_REPO_COMMANDS — see
// `cli/mod.ts:NON_REPO_COMMANDS` (the constant lives near line 191).
// Without that, configureExtensionLoaders never runs and the
// registries' ensureLoaded would be no-ops.
//
// Caller does NOT need to call resetState/resetLoadedFlag — the
// service handles that ordering as the first steps of its async
// generator.
//
// Note: `resolveDatastoreForRepo()` warms `datastoreTypeRegistry`'s
// `ensureLoaded()` BEFORE the service runs. The service then calls
// `resetLoadedFlag()` and `ensureLoaded()` again. The double-run is
// intentional — the second run is what the user sees in the report
// — and it is consistent with how registries that the CLI bootstrap
// already warmed get re-loaded.

import { Command } from "@cliffy/command";
import { bold, dim } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { isAbsolute, join, relative, resolve } from "@std/path";
import {
  buildAggregateState,
  consumeStream,
  doctorExtensions,
  type DoctorRegistryDeps,
  ReconcileFromDiskService,
  type ReconcileTransition,
  repairExtensions,
} from "../../libswamp/mod.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import {
  getExtensionLoadWarnings,
  resetExtensionLoadWarnings,
} from "../../infrastructure/logging/extension_load_warnings.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { driverTypeRegistry } from "../../domain/drivers/driver_type_registry.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { createDoctorExtensionsRenderer } from "../../presentation/renderers/doctor_extensions.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { resolveDatastoreForRepo } from "../repo_context.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import { resolveSkillsDir } from "../../domain/repo/skill_dirs.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { resolvePrimaryTool } from "../../domain/repo/primary_tool.ts";
import { readLocalManifestIdentity } from "../../infrastructure/persistence/local_manifest_reader.ts";

async function promptConfirmation(message: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  await Deno.stdout.write(encoder.encode(`${message} [y/N] `));
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;
  const response = decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
  return response === "y" || response === "yes";
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * `swamp doctor extensions` — re-runs the extension loaders across
 * all five user registries and reports any load failures. Exits
 * non-zero on any failure so the command composes into CI preflight
 * checks.
 */
export const doctorExtensionsCommand = new Command()
  .description(
    "Verify that user-defined extensions in this repo load cleanly " +
      "and inspect catalog aggregate state.",
  )
  .example("Check this repo's extensions", "swamp doctor extensions")
  .example("Machine-readable output for CI", "swamp doctor extensions --json")
  .example("Show per-source detail", "swamp doctor extensions --verbose")
  .example(
    "Preview what repair would clean up",
    "swamp doctor extensions --repair --dry-run",
  )
  .example(
    "Apply repair operations",
    "swamp doctor extensions --repair",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--verbose", "Show per-source detail for each extension")
  .option(
    "--repair",
    "Prune Tombstoned catalog rows and evict unreferenced bundle files",
  )
  .option(
    "--dry-run",
    "Preview repair operations without executing (use with --repair)",
  )
  .option("-f, --force", "Skip confirmation prompt (use with --repair)")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "doctor",
      "extensions",
    ]);
    cliCtx.logger.debug("Executing doctor extensions command");

    const verbose = options.verbose === true;
    const repair = options.repair === true;
    const dryRun = options.dryRun === true;
    const force = options.force === true;
    const needsPrompt = repair && !dryRun && !force &&
      cliCtx.outputMode === "log";

    const repoDir = resolveRepoDir(options.repoDir);
    // Same gate as `doctor audit` — fails loudly outside a swamp repo.
    await resolveDatastoreForRepo(repoDir);

    // Resolve lockfile path early so the rescan repository's
    // empty-version fallback has lockfile entries available. (Hoisted
    // from the post-rescan section per ADV-2 resolution; the same
    // values are reused below for orphan detection.)
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = isAbsolute(modelsDir)
      ? modelsDir
      : resolve(repoDir, modelsDir);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");

    // Invalidate the catalog and run reconcile so failure states
    // (BundleBuildFailed, EntryPointUnreadable, OrphanedBundleOnly)
    // are written through the Extension aggregate and surface in
    // sourceDetails[]. Without reconcile, failures only land in
    // registries.<kind>.failures[] via the legacy buildIndex path.
    //
    // This repository instance and the loaders' repository (constructed
    // at mod.ts startup) are two separate ExtensionRepository objects
    // pointing at the same SQLite DB. Writes here are process-wide-
    // visible to the loaders regardless of close ordering; the close
    // is connection hygiene, not synchronization.
    const localManifestIdentity = readLocalManifestIdentity(repoDir);
    let reconcileTransitions: readonly ReconcileTransition[] = [];
    try {
      const reconcileLockfileRepo = await LockfileRepository.create(
        lockfilePath,
      );
      const rescanRepo = new ExtensionRepository({
        catalog: new ExtensionCatalogStore(
          swampPath(repoDir, "_extension_catalog.db"),
        ),
        lockfileRepository: reconcileLockfileRepo,
        repoRoot: repoDir,
        localManifestIdentity,
      });
      try {
        rescanRepo.invalidateAll();
        const denoRuntime = new EmbeddedDenoRuntime();
        const reconciler = new ReconcileFromDiskService({
          denoRuntime,
          repository: rescanRepo,
          lockfileRepository: reconcileLockfileRepo,
          repoDir,
          localManifestIdentity,
        });
        const result = await reconciler.execute();
        reconcileTransitions = result.transitions;
      } finally {
        rescanRepo.close();
      }
    } catch {
      // Best-effort — the loader will bootstrap a fresh catalog if this fails.
    }

    const registries: ReadonlyArray<DoctorRegistryDeps> = [
      {
        registry: "model",
        ensureLoaded: () => modelRegistry.ensureLoaded(),
        resetLoadedFlag: () => modelRegistry.resetLoadedFlag(),
      },
      {
        registry: "vault",
        ensureLoaded: () => vaultTypeRegistry.ensureLoaded(),
        resetLoadedFlag: () => vaultTypeRegistry.resetLoadedFlag(),
      },
      {
        registry: "driver",
        ensureLoaded: () => driverTypeRegistry.ensureLoaded(),
        resetLoadedFlag: () => driverTypeRegistry.resetLoadedFlag(),
      },
      {
        registry: "datastore",
        ensureLoaded: () => datastoreTypeRegistry.ensureLoaded(),
        resetLoadedFlag: () => datastoreTypeRegistry.resetLoadedFlag(),
      },
      {
        registry: "report",
        ensureLoaded: () => reportRegistry.ensureLoaded(),
        resetLoadedFlag: () => reportRegistry.resetLoadedFlag(),
      },
    ];

    // Resolve skills paths so the orphan-detection phase can walk the
    // per-extension roots referenced by the lockfile. (lockfilePath /
    // marker / repoPath / modelsDir / absoluteModelsDir are hoisted
    // above the rescan call earlier in this function.)
    const tool = resolvePrimaryTool(marker);
    const absoluteSkillsDir = resolveSkillsDir(repoDir, tool);
    // detectOrphanFiles wants a repo-relative skills dir so it can
    // compare against entry.files[] paths (which are repo-relative).
    const repoRelativeSkillsDir = relative(repoDir, absoluteSkillsDir);

    const controller = new AbortController();
    const renderer = createDoctorExtensionsRenderer(cliCtx.outputMode, {
      verbose,
    });

    const catalogDbPath = swampPath(repoDir, "_extension_catalog.db");

    const doctorLockfileRepo = await LockfileRepository.create(lockfilePath);
    await consumeStream(
      doctorExtensions({
        registries,
        getWarnings: getExtensionLoadWarnings,
        resetState: resetExtensionLoadWarnings,
        lockfileRepository: doctorLockfileRepo,
        repoDir,
        skillsDir: repoRelativeSkillsDir,
        abortSignal: controller.signal,
        buildAggregateState: async () => {
          const aggLockfileRepo = await LockfileRepository.create(
            lockfilePath,
          );
          const localIdentity = readLocalManifestIdentity(repoDir);
          const repo = new ExtensionRepository({
            catalog: new ExtensionCatalogStore(catalogDbPath),
            lockfileRepository: aggLockfileRepo,
            repoRoot: repoDir,
            localManifestIdentity: localIdentity,
          });
          try {
            const extensions = repo.loadAll();
            return buildAggregateState({ extensions, repoDir });
          } finally {
            repo.close();
          }
        },
        getRecentTransitions: () => reconcileTransitions,
        runRepair: repair
          ? async (aggregateReport) => {
            // In interactive mode without --force, preview first and prompt.
            if (needsPrompt) {
              const preview = await repairExtensions({
                aggregateReport,
                deleteBySourcePaths: () => 0,
                apply: false,
              });
              if (preview.operations.length === 0) {
                return preview;
              }
              const n = preview.operations.length;
              writeOutput(
                `\n${bold(`${n} repair operation(s) planned`)} ${
                  dim("(use --dry-run to see details without prompting)")
                }`,
              );
              const confirmed = await promptConfirmation(
                "Proceed with repair?",
              );
              if (!confirmed) {
                writeOutput(dim("Repair cancelled."));
                return preview;
              }
            }
            const repairLockfileRepo = await LockfileRepository.create(
              lockfilePath,
            );
            const repo = new ExtensionRepository({
              catalog: new ExtensionCatalogStore(catalogDbPath),
              lockfileRepository: repairLockfileRepo,
              repoRoot: repoDir,
            });
            try {
              return repairExtensions({
                aggregateReport,
                deleteBySourcePaths: (paths) => repo.deleteBySourcePaths(paths),
                apply: !dryRun,
              });
            } finally {
              repo.close();
            }
          }
          : undefined,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("doctor extensions command completed");

    if (renderer.overallStatus === "fail") {
      Deno.exit(1);
    }
  });
