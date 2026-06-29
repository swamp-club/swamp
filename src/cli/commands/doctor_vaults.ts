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
  createDoctorVaultsDeps,
  createLibSwampContext,
  doctorVaults,
  type DoctorVaultsData,
} from "../../libswamp/mod.ts";
import { createDoctorVaultsRenderer } from "../../presentation/renderers/doctor_vaults.ts";
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
import type { DoctorVaultsResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const doctorVaultsCommand = withRemoteOptions(
  new Command()
    .description(
      "Scan model definitions for sensitive resource outputs and verify " +
        "a vault is configured to store them.",
    )
    .example("Scan this repo's definitions", "swamp doctor vaults")
    .example("Machine-readable output for CI", "swamp doctor vaults --json")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, [
    "doctor",
    "vaults",
  ]);
  cliCtx.logger.debug("Executing doctor vaults command");

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<DoctorVaultsResponse>(
      { server, token },
      {
        type: "doctor.vaults",
        payload: {},
      },
    );
    const renderer = createDoctorVaultsRenderer(cliCtx.outputMode);
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response.data as unknown as DoctorVaultsData,
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
  const deps = await createDoctorVaultsDeps(repoDir);
  const renderer = createDoctorVaultsRenderer(cliCtx.outputMode);

  await consumeStream(
    doctorVaults(libCtx, deps),
    renderer.handlers(),
  );

  cliCtx.logger.debug("doctor vaults command completed");

  if (renderer.overallStatus === "fail") {
    Deno.exit(1);
  }
});
