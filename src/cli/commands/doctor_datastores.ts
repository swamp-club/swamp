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
import {
  consumeStream,
  createLibSwampContext,
  doctorDatastores,
  type DoctorDatastoresData,
  type DoctorDatastoresDeps,
} from "../../libswamp/mod.ts";
import { createDoctorDatastoresRenderer } from "../../presentation/renderers/doctor_datastores.ts";
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
import type { DoctorDatastoresResponse } from "../../serve/protocol.ts";
import {
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { resolveDatastoreConfig } from "../resolve_datastore.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

async function createDoctorDatastoresDeps(
  repoDir: string,
): Promise<DoctorDatastoresDeps> {
  await datastoreTypeRegistry.ensureLoaded();
  return {
    getDatastoreConfig: async () => {
      const markerRepo = new RepoMarkerRepository();
      const marker = await markerRepo.read(RepoPath.create(repoDir));
      return await resolveDatastoreConfig(marker, undefined, repoDir);
    },
    checkHealth: async (config) => {
      if (isCustomDatastoreConfig(config)) {
        await datastoreTypeRegistry.ensureTypeLoaded(config.type);
        const typeInfo = datastoreTypeRegistry.get(config.type);
        if (typeInfo?.createProvider) {
          const provider = typeInfo.createProvider(config.config);
          const verifier = provider.createVerifier();
          return await verifier.verify();
        }
        return {
          healthy: false,
          message: "No provider available for datastore type",
          latencyMs: 0,
        };
      } else {
        const verifier = new FilesystemDatastoreVerifier(config.path);
        return await verifier.verify();
      }
    },
    getVaultConfigs: async () => {
      const vaultRepo = new YamlVaultConfigRepository(repoDir);
      try {
        const vaultConfigs = await vaultRepo.findAll();
        return vaultConfigs.map((vc) => ({ name: vc.name, type: vc.type }));
      } catch {
        return [];
      }
    },
  };
}

export const doctorDatastoresCommand = withRemoteOptions(
  new Command()
    .description(
      "Check that the configured datastore is healthy and flag any " +
        "vault compatibility issues.",
    )
    .example("Check this repo's datastore", "swamp doctor datastores")
    .example("Machine-readable output for CI", "swamp doctor datastores --json")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, [
    "doctor",
    "datastores",
  ]);
  cliCtx.logger.debug("Executing doctor datastores command");

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<DoctorDatastoresResponse>(
      { server, token },
      {
        type: "doctor.datastores",
        payload: {},
      },
    );
    const renderer = createDoctorDatastoresRenderer(cliCtx.outputMode);
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response.data as unknown as DoctorDatastoresData,
        };
      })(),
      renderer.handlers(),
    );
    if (renderer.overallStatus === "fail") {
      Deno.exit(1);
    }
    return;
  }

  const repoDir = resolveRepoDir(options.repoDir);
  await resolveDatastoreForRepo(repoDir);

  const libCtx = createLibSwampContext();
  const deps = await createDoctorDatastoresDeps(repoDir);
  const renderer = createDoctorDatastoresRenderer(cliCtx.outputMode);

  await consumeStream(
    doctorDatastores(libCtx, deps),
    renderer.handlers(),
  );

  cliCtx.logger.debug("doctor datastores command completed");

  if (renderer.overallStatus === "fail") {
    Deno.exit(1);
  }
});
