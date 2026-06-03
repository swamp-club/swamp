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

// `swamp doctor secrets` — read-only scan that reports model definitions
// whose `sensitive: true` global arguments hold a cleartext literal value
// (left on disk before the at-rest guard, or arriving via datastore sync,
// which copies definition YAML byte-for-byte and bypasses the save-time
// guard). Reporting only: it prints value-free vault remediation guidance and
// exits non-zero when a leak is found so CI can gate on it.

import { Command } from "@cliffy/command";
import {
  consumeStream,
  createDoctorSecretsDeps,
  createLibSwampContext,
  doctorSecrets,
} from "../../libswamp/mod.ts";
import { createDoctorSecretsRenderer } from "../../presentation/renderers/doctor_secrets.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { resolveDatastoreForRepo } from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const doctorSecretsCommand = new Command()
  .description(
    "Scan model definitions for cleartext sensitive global arguments and " +
      "report how to migrate each to a vault.",
  )
  .example("Scan this repo's definitions", "swamp doctor secrets")
  .example("Machine-readable output for CI", "swamp doctor secrets --json")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "doctor",
      "secrets",
    ]);
    cliCtx.logger.debug("Executing doctor secrets command");

    const repoDir = resolveRepoDir(options.repoDir);
    // Same gate as the other doctor subcommands — fails loudly outside a repo.
    await resolveDatastoreForRepo(repoDir);

    const libCtx = createLibSwampContext();
    const deps = await createDoctorSecretsDeps(repoDir);
    const renderer = createDoctorSecretsRenderer(cliCtx.outputMode);

    await consumeStream(
      doctorSecrets(libCtx, deps),
      renderer.handlers(),
    );

    cliCtx.logger.debug("doctor secrets command completed");

    if (renderer.overallStatus === "fail") {
      Deno.exit(1);
    }
  });
