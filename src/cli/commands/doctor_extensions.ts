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

// relies on doctor not being in NON_REPO_COMMANDS, else ensureLoaded is a
// no-op. Managed config resolution may warm datastoreTypeRegistry first; the
// service reloads it, and that second run is what the report shows.

import { Command } from "@cliffy/command";
import { bold, dim } from "@std/fmt/colors";
import {
  getExtensionLoadWarnings,
  resetExtensionLoadWarnings,
} from "../../infrastructure/logging/extension_load_warnings.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { relative } from "@std/path";
import { buildAggregateState } from "../../libswamp/extensions/doctor_aggregate.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  createExtensionPullDeps,
  resolveServerUrl,
} from "../../libswamp/extensions/pull.ts";
import {
  doctorExtensions,
  type DoctorExtensionsReport,
  type DoctorRegistryDeps,
  type DoctorRescanSkipped,
  extensionMemberDoctorDeps,
  toDoctorWarnings,
} from "../../libswamp/extensions/doctor.ts";
import {
  ManagedLockfileUnpublishedError,
  refreshManagedLockfile,
  withManagedLockfileTransaction,
} from "../../libswamp/extensions/managed_lockfile_transaction.ts";
import {
  ReconcileFromDiskService,
  type ReconcileTransition,
} from "../../libswamp/extensions/reconcile_from_disk_service.ts";
import { repairExtensions } from "../../libswamp/extensions/doctor_repair.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import { pullExtension } from "./extension_pull.ts";
import { loadIdentity } from "../load_identity.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { webhookTypeRegistry } from "../../domain/webhooks/webhook_type_registry.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { resolveMountedSourceDirs } from "../../infrastructure/persistence/swamp_sources_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { createDoctorExtensionsRenderer } from "../../presentation/renderers/doctor_extensions.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { DoctorExtensionsResponse } from "../../serve/protocol.ts";
import {
  assertManagedConfigWritable,
  ensureManagedConfigBase,
  ManagedConfigUnresolvedError,
  requireRepoMarker,
  resolveManagedConfigPaths,
} from "../repo_context.ts";
import { createManagedLockfileTransaction } from "../managed_config_sync.ts";
import {
  type DatastoreEnvReader,
  isExtensionBackedDatastore,
} from "../../infrastructure/persistence/managed_config_lockfile.ts";
import type { RepoMarkerData } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { transitionalInstalledNames } from "../../infrastructure/persistence/installed_entries.ts";
import { resolveUniqueLocalSkillsDirs } from "../../domain/repo/skill_dirs.ts";
import { readLocalManifestIdentity } from "../../infrastructure/persistence/local_manifest_reader.ts";
import { promptConfirmation } from "../prompt_helpers.ts";
import { ProcessBundleProber } from "../../infrastructure/runtime/process_bundle_prober.ts";
import { createDefaultExtensionArchiveCache } from "../../infrastructure/persistence/extension_archive_cache.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * with the managed config base unresolved the only lockfile is the in-repo
 * guess: a rescan would tombstone every team extension's rows and repairs would
 * write where the datastore never sees them.
 */
export function rescanSkippedFor(
  repoDir: string,
  marker: RepoMarkerData | null,
  repair: boolean,
  readDatastoreEnv?: DatastoreEnvReader,
): DoctorRescanSkipped | undefined {
  try {
    assertManagedConfigWritable(repoDir, marker, readDatastoreEnv);
    return undefined;
  } catch (error) {
    if (!(error instanceof ManagedConfigUnresolvedError)) throw error;
    return { reason: error.message, repairSkipped: repair };
  }
}

export interface RepullOutcome {
  repaired: boolean;
  unpublished?: ManagedLockfileUnpublishedError;
}

/**
 * only a failed publish from the pull itself counts as repaired (installed and
 * recorded; the caller raises the error after the report). Any other failure,
 * including prepare's, is logged and counts as not repaired.
 */
export async function runRepull(
  name: string,
  prepare: () => Promise<() => Promise<unknown>>,
  logger: {
    warn(message: string, properties: Record<string, unknown>): void;
  },
): Promise<RepullOutcome> {
  try {
    const pull = await prepare();
    try {
      await pull();
    } catch (error) {
      if (error instanceof ManagedLockfileUnpublishedError) {
        return { repaired: true, unpublished: error };
      }
      throw error;
    }
    return { repaired: true };
  } catch (error) {
    // Keep the reason visible: under managedConfig a re-pull can fail
    // before it starts because the datastore's lockfile cannot be fetched.
    logger.warn("Re-pull of {name} failed: {error}", {
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    return { repaired: false };
  }
}

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
      "Skip confirmation prompt (alias for --yes; use with --repair)",
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
    const token = await resolveServerTokenFromOptions(
      remoteServer,
      options,
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
    const remoteReport = response.data as unknown as DoctorExtensionsReport;
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          // an older server sends no memberCollisions.
          report: {
            ...remoteReport,
            memberCollisions: remoteReport.memberCollisions ?? [],
          },
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

  // fails loudly outside a repo; does not resolve the datastore, since
  // diagnostics must run when the managed config base cannot be resolved.
  const { repoDir, marker } = await requireRepoMarker(
    resolveRepoDir(options.repoDir),
  );

  // resolve the lockfile path early so the rescan repository's empty-version
  // fallback has entries; a missing datastore extension is auto-installed, and
  // rescan and repairs are skipped only if that fails.
  await ensureManagedConfigBase(repoDir, marker);
  const { lockfilePath } = resolveManagedConfigPaths(repoDir, marker);
  const extensionBacked = isExtensionBackedDatastore(marker);
  const rescanSkipped = rescanSkippedFor(repoDir, marker, repair);

  // one shared catalog connection for all doctor phases; separate connections
  // to the same SQLite file caused cross-process lock contention.
  const catalogDbPath = swampPath(repoDir, "_extension_catalog.db");
  const sharedCatalog = new ExtensionCatalogStore(catalogDbPath);

  try {
    const localManifestIdentity = readLocalManifestIdentity(repoDir);
    const mountedSourceDirs = await resolveMountedSourceDirs(repoDir);
    let reconcileTransitions: readonly ReconcileTransition[] = [];
    if (!rescanSkipped) {
      try {
        const reconcileLockfileRepo = await LockfileRepository.create(
          lockfilePath,
        );
        const rescanRepo = new ExtensionRepository({
          catalog: sharedCatalog,
          lockfileRepository: reconcileLockfileRepo,
          repoRoot: repoDir,
          localManifestIdentity,
          mountedSourceDirs,
        });
        rescanRepo.invalidateAll();
        const denoRuntime = new EmbeddedDenoRuntime();
        // same treatment of on-disk datastore extensions and the in-repo
        // auto-resolve lockfile as the startup reconcile.
        const reconciler = new ReconcileFromDiskService({
          denoRuntime,
          repository: rescanRepo,
          lockfileRepository: reconcileLockfileRepo,
          repoDir,
          localManifestIdentity,
          bundleProber: new ProcessBundleProber(),
          scanOnDiskDatastores: extensionBacked,
          additionalInstalledNames: await transitionalInstalledNames(
            repoDir,
            marker,
            lockfilePath,
          ),
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
          const { markErrorPaths, UserError } = await import(
            "../../domain/errors.ts"
          );
          const e = reconcileError;
          throw markErrorPaths(
            new UserError(
              `Type "${e.typeNormalized}" (kind=${e.kind}) is claimed by two ` +
                `installed extensions:\n` +
                `  • ${e.firstSource.extensionName}@${e.firstSource.extensionVersion}` +
                `  at ${e.firstSource.canonicalPath}\n` +
                `  • ${e.secondSource.extensionName}@${e.secondSource.extensionVersion}` +
                `  at ${e.secondSource.canonicalPath}\n` +
                `Remove one with \`swamp extension rm <name>\` to resolve ` +
                `the conflict, then run \`swamp doctor extensions\` again.`,
            ),
            [e.firstSource.canonicalPath, e.secondSource.canonicalPath],
          );
        }
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
      {
        registry: "webhook",
        ensureLoaded: () => webhookTypeRegistry.ensureLoaded(),
        resetLoadedFlag: () => webhookTypeRegistry.resetLoadedFlag(),
      },
    ];

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
    // a repair re-pull can rewrite the lockfile; it is made against the
    // datastore's lockfile and published as it lands.
    let unpublishedRepair: ManagedLockfileUnpublishedError | undefined;
    const lockfileTransaction = repair && !rescanSkipped && !dryRun
      ? createManagedLockfileTransaction(repoDir, marker, {
        lockfilePath,
        publish: true,
      })
      : undefined;
    await withManagedLockfileTransaction(
      lockfileTransaction,
      () =>
        consumeStream(
          doctorExtensions({
            registries,
            lockfileRepository: doctorLockfileRepo,
            repoDir,
            skillsDirs: repoRelativeSkillsDirs,
            abortSignal: controller.signal,
            rescanSkipped,
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
                mountedSourceDirs,
              });
              const extensions = repo.loadAll();
              return buildAggregateState({ extensions, repoDir });
            },
            getRecentTransitions: () => reconcileTransitions,
            getWarnings: () => toDoctorWarnings(getExtensionLoadWarnings()),
            resetWarnings: resetExtensionLoadWarnings,
            ...extensionMemberDoctorDeps(sharedCatalog),
            runRepair: repair && !rescanSkipped
              ? async (aggregateReport) => {
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
                  mountedSourceDirs,
                });
                const repullExtension = async (
                  name: string,
                ): Promise<boolean> => {
                  const outcome = await runRepull(name, async () => {
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
                      mountedSourceDirs,
                    });
                    const deps = await createExtensionPullDeps(
                      serverUrl,
                      lockfilePath,
                      absoluteSkillsDirs,
                      repoDir,
                      {
                        identity,
                        archiveCache: createDefaultExtensionArchiveCache(),
                      },
                    );
                    // Repair restores what the lockfile pins, not registry
                    // latest, which would destroy the pin; extensions with no
                    // entry resolve latest.
                    await refreshManagedLockfile(pullLockfileRepo);
                    const pinnedVersion =
                      pullLockfileRepo.getEntry(name)?.version ?? null;
                    return () =>
                      pullExtension(
                        { name, version: pinnedVersion },
                        {
                          getExtension: deps.getExtension,
                          downloadArchive: deps.downloadArchive,
                          getChecksum: deps.getChecksum,
                          archiveCache: deps.archiveCache,
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
                  }, cliCtx.logger);
                  if (outcome.unpublished) {
                    unpublishedRepair ??= outcome.unpublished;
                  }
                  return outcome.repaired;
                };
                return repairExtensions({
                  aggregateReport,
                  deleteBySourcePaths: (paths) =>
                    repo.deleteBySourcePaths(paths),
                  repullExtension,
                  apply: !dryRun,
                });
              }
              : undefined,
          }),
          renderer.handlers(),
        ),
    );
    // The report has rendered; now surface a re-pull whose lockfile change
    // did not reach the datastore.
    if (unpublishedRepair) throw unpublishedRepair;

    cliCtx.logger.debug("doctor extensions command completed");

    if (renderer.overallStatus === "fail") {
      Deno.exit(1);
    }
  } finally {
    sharedCatalog.close();
  }
});
