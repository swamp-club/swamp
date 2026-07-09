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
  createVaultDeleteDeps,
  vaultDelete,
  type VaultDeleteData,
  vaultDeletePreview,
} from "../../libswamp/mod.ts";
import {
  createVaultDeleteRenderer,
  renderVaultDeleteCancelled,
} from "../../presentation/renderers/vault_delete.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  acquireVaultSync,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  normalizeServerUrl,
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { VaultDeleteResponse } from "../../serve/protocol.ts";
import { promptConfirmation } from "../prompt_helpers.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultDeleteCommand = withRemoteOptions(
  new Command()
    .name("delete")
    .description(
      `Delete a secret from a vault.

Removes the secret and any associated metadata (annotations, refresh hooks).
Use --force to skip the confirmation prompt and to treat non-existent keys as a no-op.

When using --server, the confirmation prompt is not available — use --force to suppress the error on missing keys.`,
    )
    .arguments("<vault_name:string> <key:string>")
    .example(
      "Delete a secret (with confirmation)",
      "swamp vault delete my-vault OLD_API_KEY",
    )
    .example(
      "Delete without confirmation (for scripts/CI)",
      "swamp vault delete my-vault OLD_API_KEY --force",
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option("-f, --force", "Skip confirmation prompt and ignore missing keys"),
).action(async function (
  options: AnyOptions,
  vaultName: string,
  key: string,
) {
  const cliCtx = createContext(options as GlobalOptions, ["vault", "delete"]);
  cliCtx.logger.debug`Deleting secret from vault: ${vaultName}`;

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const wsUrl = normalizeServerUrl(server);
    const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
    try {
      const parsed = new URL(wsUrl);
      if (parsed.protocol === "ws:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
        cliCtx.logger.warn(
          "Sending request over unencrypted connection — use wss:// for security",
        );
      }
    } catch { /* invalid URL handled by normalizeServerUrl */ }

    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<VaultDeleteResponse>(
      { server, token },
      {
        type: "vault.delete",
        payload: {
          vaultName,
          key,
          force: options.force as boolean | undefined,
        },
      },
    );
    const renderer = createVaultDeleteRenderer(cliCtx.outputMode);
    renderer.handlers().completed({
      kind: "completed",
      data: response.data as unknown as VaultDeleteData,
    });
    return;
  }

  const { repoDir, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });
  const { flush } = await acquireVaultSync(
    datastoreConfig,
    syncService,
    repoDir,
  );

  try {
    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createVaultDeleteDeps(repoDir, repoContext.eventBus);

    let preview;
    try {
      preview = await vaultDeletePreview(ctx, deps, vaultName, key);
    } catch (error) {
      if ("code" in (error as Record<string, unknown>)) {
        throw new UserError((error as { message: string }).message);
      }
      throw error;
    }

    if (!preview.supportsDelete) {
      throw new UserError(
        `Vault '${vaultName}' (type: ${preview.vaultType}) does not support deleting secrets`,
      );
    }

    if (!preview.secretExists) {
      if (options.force) {
        const renderer = createVaultDeleteRenderer(cliCtx.outputMode);
        renderer.handlers().completed({
          kind: "completed",
          data: {
            vaultName,
            secretKey: key,
            vaultType: preview.vaultType,
            timestamp: new Date().toISOString(),
            noOp: true,
          },
        });
        return;
      }
      throw new UserError(
        `Secret '${key}' not found in vault '${vaultName}'`,
      );
    }

    if (cliCtx.outputMode === "log" && !options.force) {
      const confirmed = await promptConfirmation(
        `Delete secret '${key}' from vault '${vaultName}'?`,
      );
      if (!confirmed) {
        renderVaultDeleteCancelled(cliCtx.outputMode);
        return;
      }
    }

    const renderer = createVaultDeleteRenderer(cliCtx.outputMode);
    await consumeStream(
      vaultDelete(ctx, deps, {
        vaultName,
        key,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Vault delete command completed");
  } finally {
    await flush();
  }
});
