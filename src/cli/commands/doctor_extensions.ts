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
import { isAbsolute, join, relative, resolve } from "@std/path";
import {
  consumeStream,
  doctorExtensions,
  type DoctorRegistryDeps,
} from "../../libswamp/mod.ts";
import {
  getExtensionLoadWarnings,
  resetExtensionLoadWarnings,
} from "../../infrastructure/logging/extension_load_warnings.ts";
import { readUpstreamExtensions } from "../../infrastructure/persistence/upstream_extensions.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { driverTypeRegistry } from "../../domain/drivers/driver_type_registry.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { forceCatalogRescan } from "../../infrastructure/persistence/extension_catalog_store.ts";
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
    "Verify that user-defined extensions in this repo load cleanly.",
  )
  .example("Check this repo's extensions", "swamp doctor extensions")
  .example("Machine-readable output for CI", "swamp doctor extensions --json")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "doctor",
      "extensions",
    ]);
    cliCtx.logger.debug("Executing doctor extensions command");

    const repoDir = resolveRepoDir(options.repoDir);
    // Same gate as `doctor audit` — fails loudly outside a swamp repo.
    await resolveDatastoreForRepo(repoDir);

    // Invalidate the catalog so the loaders run a full re-validation
    // instead of returning the cached lazy entries. Without this, the
    // doctor reports stale results when run after another swamp
    // command in the same repo.
    forceCatalogRescan(repoDir);

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

    // Resolve lockfile and skills paths so the orphan-detection phase
    // can walk the per-extension roots referenced by the lockfile.
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = isAbsolute(modelsDir)
      ? modelsDir
      : resolve(repoDir, modelsDir);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");
    const tool = resolvePrimaryTool(marker);
    const absoluteSkillsDir = resolveSkillsDir(repoDir, tool);
    // detectOrphanFiles wants a repo-relative skills dir so it can
    // compare against entry.files[] paths (which are repo-relative).
    const repoRelativeSkillsDir = relative(repoDir, absoluteSkillsDir);

    const controller = new AbortController();
    const renderer = createDoctorExtensionsRenderer(cliCtx.outputMode);

    await consumeStream(
      doctorExtensions({
        registries,
        getWarnings: getExtensionLoadWarnings,
        resetState: resetExtensionLoadWarnings,
        readUpstreamExtensions: () => readUpstreamExtensions(lockfilePath),
        repoDir,
        skillsDir: repoRelativeSkillsDir,
        abortSignal: controller.signal,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("doctor extensions command completed");

    if (renderer.overallStatus === "fail") {
      Deno.exit(1);
    }
  });
