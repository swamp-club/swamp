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

import { Command } from "@cliffy/command";
import { relative } from "@std/path";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  ensureManagedConfigBase,
  requireRepoMarker,
  resolveManagedConfigPaths,
  resolveManagedLockfileForWrite,
} from "../repo_context.ts";
import { createExtensionRegistryLookup } from "../extension_registry_lookup.ts";
import { isExtensionBackedDatastore } from "../../infrastructure/persistence/managed_config_lockfile.ts";
import { createManagedLockfileTransaction } from "../managed_config_sync.ts";
import { createInstallContext, parseExtensionRef } from "./extension_pull.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  createExtensionUpdateDeps,
  extensionUpdate,
} from "../../libswamp/extensions/update.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import type { ExtensionUpdateResult } from "../../domain/extensions/extension_update_service.ts";
import {
  type LockfileTransaction,
  withManagedLockfileTransaction,
} from "../../libswamp/extensions/managed_lockfile_transaction.ts";
import { UpgradeExtensionService } from "../../libswamp/extensions/upgrade_extension_service.ts";
import { warnLegacyExtensionLayout } from "../../libswamp/extensions/layout.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { resolveMountedSourceDirs } from "../../infrastructure/persistence/swamp_sources_repository.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import {
  isManagedConfigBaseResolved,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { createExtensionUpdateRenderer } from "../../presentation/renderers/extension_update.ts";
import { resolveUniqueLocalSkillsDirs } from "../../domain/repo/skill_dirs.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";
import { loadIdentity } from "../load_identity.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  serverReloadCommand,
  withRemoteOptions,
} from "../remote_run.ts";
import { renderServerExtensionChange } from "../../presentation/output/server_extension_change_output.ts";
import type { ExtensionUpdateResponse } from "../../serve/protocol.ts";
import { createDefaultExtensionArchiveCache } from "../../infrastructure/persistence/extension_archive_cache.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

export const extensionUpdateCommand = withRemoteOptions(
  new Command()
    .name("update")
    .description("Update installed extensions to latest versions")
    .example("Update all extensions", "swamp extension update")
    .example("Update one extension", "swamp extension update @stack72/aws-ec2")
    .example("Check for updates", "swamp extension update --check")
    .arguments("[extension:string]")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option("--check", "Show what's outdated without pulling"),
).action(async function (options: AnyOptions, extensionArg?: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "extension",
    "update",
  ]);
  cliCtx.logger.debug`Starting extension update`;

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(
      server,
      options,
    );
    const response = await requestServerResponse<ExtensionUpdateResponse>(
      { server, token, timeoutMs: 300_000 },
      {
        type: "extension.update",
        payload: {
          extensionName: extensionArg
            ? parseExtensionRef(extensionArg).name
            : undefined,
          checkOnly: !!options.check,
        },
      },
    );
    const renderer = createExtensionUpdateRenderer(cliCtx.outputMode);
    const mode = options.check ? "check" : "update";
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response.data as unknown as ExtensionUpdateResult,
          mode: mode as "check" | "update",
        };
      })(),
      renderer.handlers(),
    );
    if (!options.check) {
      renderServerExtensionChange({
        serveReload: response.serveReload,
        reloadCommand: serverReloadCommand(server),
      }, cliCtx.outputMode);
    }
    return;
  }

  // lightweight: no datastore resolution, so updating the repo's own datastore
  // extension does not fail circularly.
  const { repoDir, marker } = await requireRepoMarker(
    resolveRepoDir(options.repoDir),
  );

  let extensionName: string | undefined;
  if (extensionArg) {
    const ref = parseExtensionRef(extensionArg);
    extensionName = ref.name;
  }

  const serverUrl = resolveServerUrl();
  const identity = await loadIdentity();
  let lockfilePath: string;
  let lockfileTransaction: LockfileTransaction | undefined;
  let fallbackLockfile = false;
  if (options.check) {
    // read-only: no guard, but say when the answer comes from the in-repo
    // fallback because the datastore extension could not be installed.
    await ensureManagedConfigBase(repoDir, marker);
    lockfilePath = resolveManagedConfigPaths(repoDir, marker).lockfilePath;
    fallbackLockfile = isExtensionBackedDatastore(marker) &&
      !isManagedConfigBaseResolved(repoDir);
  } else {
    // refuses to record into a guessed managed config base, except when
    // updating the repo's own datastore extension by name.
    const target = await resolveManagedLockfileForWrite(repoDir, marker, {
      exemptTargets: extensionName ? [extensionName] : [],
      extensionLookup: createExtensionRegistryLookup(serverUrl, identity),
    });
    lockfilePath = target.lockfilePath;
    // updates are made against the datastore's lockfile and published as they
    // land.
    lockfileTransaction = createManagedLockfileTransaction(
      repoDir,
      marker,
      target,
    );
  }

  // per-extension destinations are derived inside installExtension from the
  // extension's scoped name; only skillsDir is tool-dependent.
  const tools = marker?.tools?.length ? marker.tools : ["claude"];
  const skillsDirs = resolveUniqueLocalSkillsDirs(repoDir, tools);

  const primarySkillsDirRelative = relative(repoDir, skillsDirs[0]);
  await warnLegacyExtensionLayout(
    lockfilePath,
    (msg) => cliCtx.logger.warn(msg),
    primarySkillsDirRelative,
  );

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  // Shared denoRuntime and repository so each upgrade routes through
  // InstallExtensionService; the catalog stays open for the bulk update.
  const denoRuntime = new EmbeddedDenoRuntime();
  const mountedSourceDirs = await resolveMountedSourceDirs(repoDir);
  const catalog = new ExtensionCatalogStore(
    swampPath(repoDir, "_extension_catalog.db"),
  );
  try {
    const deps = await createExtensionUpdateDeps({
      lockfilePath,
      serverUrl,
      identity,
      installExtension: async (
        name: string,
        version: string,
        channel?: string,
      ) => {
        // a fresh InstallContext per upgrade: its lockfileRepository is
        // single-use, and reusing one across installs would expose stale state.
        const installCtx = await createInstallContext(serverUrl, {
          logger: cliCtx.logger,
          lockfilePath,
          skillsDirs,
          repoDir,
          force: true,
          identity,
          channel,
          archiveCache: createDefaultExtensionArchiveCache(),
        });
        // a fresh ExtensionRepository per upgrade so its lockfile snapshot
        // lines up with the InstallContext's; the catalog is shared across the
        // bulk run.
        const repository = new ExtensionRepository({
          catalog,
          lockfileRepository: installCtx.lockfileRepository,
          repoRoot: repoDir,
          mountedSourceDirs,
        });
        // UpgradeExtensionService delegates to InstallExtensionService, whose
        // phase 8 tombstones the prior version atomically (saveAll is one
        // SQLite transaction).
        return await new UpgradeExtensionService({
          denoRuntime,
          repository,
        })
          .execute(name, version, installCtx);
      },
    });

    const renderer = createExtensionUpdateRenderer(cliCtx.outputMode);
    await withManagedLockfileTransaction(
      lockfileTransaction,
      () =>
        consumeStream(
          extensionUpdate(ctx, deps, {
            extensionName,
            checkOnly: !!options.check,
            fallbackLockfile,
          }),
          renderer.handlers(),
        ),
    );
  } finally {
    catalog.close();
  }
});
