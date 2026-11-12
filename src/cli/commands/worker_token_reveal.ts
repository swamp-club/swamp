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
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { consumeStream, withDefaults } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createWorkerTokenRevealDeps,
  workerTokenReveal,
  type WorkerTokenRevealData,
  type WorkerTokenRevealEvent,
} from "../../libswamp/worker/token_reveal.ts";
import { renderWorkerTokenReveal } from "../../presentation/output/worker_output.ts";
import { initializeControlPlaneVaultForCli } from "../control_plane_vault.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { promptConfirmation } from "../prompt_helpers.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import {
  requestNewerServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkerTokenRevealResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workerTokenRevealCommand = withRemoteOptions(
  new Command()
    .name("reveal")
    .description(
      `Show the current credential for a worker enrollment token

Use it to hand the token to a host again, or to recover the token a
rotation printed when its output was lost, rather than rotating again.`,
    )
    .example(
      "Reveal a token (interactive confirmation)",
      "swamp worker token reveal web-01",
    )
    .example(
      "Reveal a token held by a server, skipping confirmation",
      "swamp worker token reveal web-01 --yes --server wss://swamp.example.com",
    )
    .arguments("<name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option("-y, --yes", "Skip confirmation prompt")
    .option("-f, --force", "Skip confirmation prompt (alias for --yes)"),
).action(async function (options: AnyOptions, name: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "worker",
    "token",
    "reveal",
  ]);

  const skipConfirm = !!(options.yes || options.force);
  const confirmReveal = async (): Promise<boolean> => {
    if (cliCtx.outputMode !== "log" || skipConfirm) return true;
    const confirmed = await promptConfirmation(
      `This will reveal the secret for enrollment token '${name}'. Continue?`,
    );
    if (!confirmed) writeOutput("Reveal cancelled.");
    return confirmed;
  };

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    if (!(await confirmReveal())) return;
    const response = await requestNewerServerResponse<
      WorkerTokenRevealResponse
    >(
      "revealing a worker token",
      { server, token },
      { type: "worker.token.reveal", payload: { name } },
    );
    renderWorkerTokenReveal(
      response.data as unknown as WorkerTokenRevealData,
      cliCtx.outputMode,
    );
    return;
  }

  const { repoDir, repoContext, datastoreConfig, syncService, vaultsDir } =
    await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

  const namespace = isCustomDatastoreConfig(datastoreConfig)
    ? datastoreConfig.namespace
    : undefined;

  await initializeControlPlaneVaultForCli(repoDir, syncService, {
    namespace,
    catalogInvalidate: () => repoContext.catalogStore.invalidate(),
  });

  const deps = createWorkerTokenRevealDeps(
    repoContext.dataQueryService,
    await VaultService.fromRepository(repoDir, { vaultsDir }),
  );

  if (!(await confirmReveal())) return;

  const libCtx = createLibSwampContext({ logger: cliCtx.logger });
  let data: WorkerTokenRevealData | undefined;
  await consumeStream(
    workerTokenReveal(libCtx, deps, name),
    withDefaults<WorkerTokenRevealEvent>({
      completed: (event) => {
        data = event.data;
      },
      error: (event) => {
        throw new UserError(event.error.message);
      },
    }),
  );
  if (data === undefined) {
    throw new UserError(`Revealing token '${name}' ended without completing`);
  }
  renderWorkerTokenReveal(data, cliCtx.outputMode);
});
