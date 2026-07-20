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
import {
  getExtensionLoadWarnings,
  resetExtensionLoadWarnings,
} from "../../infrastructure/logging/extension_load_warnings.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { isAbsolute, join, relative, resolve } from "@std/path";
import {
  buildAggregateState,
  consumeStream,
  createExtensionPullDeps,
  doctorExtensions,
  type DoctorExtensionsReport,
  type DoctorRegistryDeps,
  ReconcileFromDiskService,
  type ReconcileTransition,
  repairExtensions,
  resolveServerUrl,
} from "../../libswamp/mod.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import { pullExtension } from "./extension_pull.ts";
import { loadIdentity } from "../load_identity.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
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
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { DoctorExtensionsResponse } from "../../serve/protocol.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import { resolveUniqueLocalSkillsDirs } from "../../domain/repo/skill_dirs.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { readLocalManifestIdentity } from "../../infrastructure/persistence/local_manifest_reader.ts";
import { promptConfirmation } from "../prompt_helpers.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * `swamp doctor extensions` — re-runs the extension loaders across
 * all five user registries and reports any load failures. Exits
 * non-zero on any failure so the command composes into CI preflight
 * checks.
 */
export const doctorExtensionsCommand = withRemoteOptions(
  new Command()
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
    .option("-y, --yes", "Skip confirmation prompt (use with --repair)")
    .option(
      "-f, --force",
      "Skip confirmation prompt (alias for --yes, use with --repair)",
    ),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, [
    "doctor",
    "extensions",
  ]);
  cliCtx.logger.debug("Executing doctor extensions command");

  const remoteServer = resolveServeUrl(
    options.server as string | undefined,
  );
  if (remoteServer) {
    const token = await resolveServerToken(
      remoteServer,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<DoctorExtensionsResponse>(
      { server: remoteServer, token },
      {
        type: "doctor.extensions",
        payload: {},
      },
    );
    const verbose = options.verbose === true;
    const renderer = createDoctorExtensionsRenderer(cliCtx.outputMode, {
      verbose,
    });
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          report: response
            .data as unknown as DoctorExtensionsReport,
        };
      })(),
      renderer.handlers(),
    );
    if (renderer.overallStatus === "fail") {
      Deno.exit(1);
    }
    return;
  }

  const verbose = options.verbose === true;
  const repair = options.repair === true;
  const dryRun = options.dryRun === true;
  const skipConfirm = options.yes === true || options.force === true;
  const needsPrompt = repair && !dryRun && !skipConfirm &&
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

  // A single shared catalog connection for all doctor phases
  // (reconcile, aggregate state, repair, re-pull). Previous code
  // opened up to 4 separate connections to the same SQLite file,
  // which contributed to cross-process lock contention.
  const catalogDbPath = swampPath(repoDir, "_extension_catalog.db");
  const sharedCatalog = new ExtensionCatalogStore(catalogDbPath);

  try {
    const localManifestIdentity = readLocalManifestIdentity(repoDir);
    let reconcileTransitions: readonly ReconcileTransition[] = [];
    try {
      const reconcileLockfileRepo = await LockfileRepository.create(
        lockfilePath,
      );
      const rescanRepo = new ExtensionRepository({
        catalog: sharedCatalog,
        lockfileRepository: reconcileLockfileRepo,
        repoRoot: repoDir,
        localManifestIdentity,
      });
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
    } catch (reconcileError) {
      // Best-effort — the loader will bootstrap a fresh catalog for
      // most failures. DuplicateTypeError from same-origin conflicts
      // should still surface so the user sees it.
      const { DuplicateTypeError } = await import(
        "../../infrastructure/persistence/duplicate_type_error.ts"
      );
      if (reconcileError instanceof DuplicateTypeError) {
        const { UserError } = await import("../../domain/errors.ts");
        const e = reconcileError;
        throw new UserError(
          `Type "${e.typeNormalized}" (kind=${e.kind}) is claimed by two ` +
            `installed extensions:\n` +
            `  • ${e.firstSource.extensionName}@${e.firstSource.extensionVersion}` +
            `  at ${e.firstSource.canonicalPath}\n` +
            `  • ${e.secondSource.extensionName}@${e.secondSource.extensionVersion}` +
            `  at ${e.secondSource.canonicalPath}\n` +
            `Remove one with \`swamp extension rm <name>\` to resolve ` +
            `the conflict, then run \`swamp doctor extensions\` again.`,
        );
      }
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
    const tools = marker?.tools?.length ? marker.tools : ["claude"];
    const absoluteSkillsDirs = resolveUniqueLocalSkillsDirs(repoDir, tools);
    // detectOrphanFiles wants repo-relative skills dirs so it can
    // compare against entry.files[] paths (which are repo-relative).
    const repoRelativeSkillsDirs = absoluteSkillsDirs.map((d) =>
      relative(repoDir, d)
    );

    let denoPath: string | undefined;
    try {
      denoPath = await new EmbeddedDenoRuntime().ensureDeno();
    } catch {
      // Best-effort — path resolution can fail in dev mode or when
      // the embedded binary extraction fails. The field is omitted
      // from JSON output in that case.
    }

    const controller = new AbortController();
    const renderer = createDoctorExtensionsRenderer(cliCtx.outputMode, {
      verbose,
      denoPath,
    });

    const doctorLockfileRepo = await LockfileRepository.create(lockfilePath);
    await consumeStream(
      doctorExtensions({
        registries,
        lockfileRepository: doctorLockfileRepo,
        repoDir,
        skillsDirs: repoRelativeSkillsDirs,
        abortSignal: controller.signal,
        buildAggregateState: async () => {
          const aggLockfileRepo = await LockfileRepository.create(
            lockfilePath,
          );
          const localIdentity = readLocalManifestIdentity(repoDir);
          const repo = new ExtensionRepository({
            catalog: sharedCatalog,
            lockfileRepository: aggLockfileRepo,
            repoRoot: repoDir,
            localManifestIdentity: localIdentity,
          });
          const extensions = repo.loadAll();
          return buildAggregateState({ extensions, repoDir });
        },
        getRecentTransitions: () => reconcileTransitions,
        getWarnings: () =>
          getExtensionLoadWarnings().map((w) => ({
            sourcePath: w.file,
            category: "TypeExtractionFailed",
            message: w.error,
          })),
        resetWarnings: resetExtensionLoadWarnings,
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
              catalog: sharedCatalog,
              lockfileRepository: repairLockfileRepo,
              repoRoot: repoDir,
            });
            const repullExtension = async (
              name: string,
            ): Promise<boolean> => {
              try {
                const serverUrl = resolveServerUrl();
                const identity = await loadIdentity();
                const pullLockfileRepo = await LockfileRepository.create(
                  lockfilePath,
                );
                const denoRuntime = new EmbeddedDenoRuntime();
                const pullRepo = new ExtensionRepository({
                  catalog: sharedCatalog,
                  lockfileRepository: pullLockfileRepo,
                  repoRoot: repoDir,
                  localManifestIdentity: readLocalManifestIdentity(repoDir),
                });
                const deps = await createExtensionPullDeps(
                  serverUrl,
                  lockfilePath,
                  absoluteSkillsDirs,
                  repoDir,
                  { identity },
                );
                await pullExtension(
                  { name, version: null },
                  {
                    getExtension: deps.getExtension,
                    downloadArchive: deps.downloadArchive,
                    getChecksum: deps.getChecksum,
                    logger: cliCtx.logger,
                    lockfileRepository: deps.lockfileRepository,
                    skillsDirs: absoluteSkillsDirs,
                    repoDir,
                    force: true,
                    outputMode: cliCtx.outputMode,
                    alreadyPulled: new Set(),
                    depth: 0,
                    denoRuntime,
                    repository: pullRepo,
                  },
                );
                return true;
              } catch {
                return false;
              }
            };
            return repairExtensions({
              aggregateReport,
              deleteBySourcePaths: (paths) => repo.deleteBySourcePaths(paths),
              repullExtension,
              apply: !dryRun,
            });
          }
          : undefined,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("doctor extensions command completed");

    if (renderer.overallStatus === "fail") {
      Deno.exit(1);
    }
  } finally {
    sharedCatalog.close();
  }
});
