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
  createVaultGetDeps,
  vaultGet,
  type VaultGetData,
  type VaultGetEvent,
} from "../../libswamp/mod.ts";
import { createVaultGetRenderer } from "../../presentation/renderers/vault_get.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { VaultGetResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultGetCommand = withRemoteOptions(
  new Command()
    .name("get")
    .description("Show details of a vault configuration")
    .example("Show vault details", "swamp vault get my-vault")
    .arguments("<vault_name_or_id:string> [extra:string]")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "-t, --type <type:string>",
      "Vault type (optional, narrows search)",
    )
    .option(
      "--pull",
      "Pull config from the remote datastore before reading (for managedConfig deployments)",
    ),
).action(
  async function (
    options: AnyOptions,
    vaultNameOrId: string,
    extra?: string,
  ) {
    if (extra) {
      throw new UserError(
        `Unexpected argument: ${extra}\n\n` +
          "Usage: swamp vault get <vault_name_or_id>\n\n" +
          "To retrieve a secret value, use: swamp vault read-secret <vault_name> <key>",
      );
    }

    const cliCtx = createContext(options as GlobalOptions, ["vault", "get"]);
    cliCtx.logger.debug`Getting vault: ${vaultNameOrId}`;

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      const token = await resolveServerTokenFromOptions(
        server,
        options,
      );
      const response = await requestServerResponse<VaultGetResponse>(
        { server, token },
        {
          type: "vault.get",
          payload: {
            vaultNameOrId,
            vaultType: options.type as string | undefined,
          },
        },
      );
      const renderer = createVaultGetRenderer(cliCtx.outputMode);
      renderer.handlers().completed({
        kind: "completed",
        data: response.data as unknown as VaultGetData,
      });
      return;
    }

    const pull = !!(options.pull as boolean | undefined);
    const { repoDir, managedConfig } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
      pull,
    });
    const vaultType = options.type as string | undefined;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createVaultGetDeps(repoDir);

    const renderer = createVaultGetRenderer(cliCtx.outputMode);
    const handlers = renderer.handlers();
    const wrappedHandlers: typeof handlers = {
      ...handlers,
      error: (e: VaultGetEvent & { kind: "error" }) => {
        if (
          managedConfig && !pull &&
          e.error.code === "not_found"
        ) {
          handlers.error(e);
          cliCtx.logger.info(
            "Tip: run with --pull to fetch the latest remote state",
          );
          return;
        }
        handlers.error(e);
      },
    };
    await consumeStream(
      vaultGet(ctx, deps, vaultNameOrId, vaultType),
      wrappedHandlers,
    );

    cliCtx.logger.debug("Vault get command completed");
  },
);
