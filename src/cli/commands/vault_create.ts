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
  createVaultCreateDeps,
  vaultCreate,
  type VaultCreateData,
} from "../../libswamp/mod.ts";
import { createVaultCreateRenderer } from "../../presentation/renderers/vault_create.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { requireAuthenticated, requireScope } from "../auth_context.ts";
import { RENAMED_VAULT_TYPES } from "../../domain/vaults/vault_types.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { VaultCreateResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Prompts user for vault name in interactive mode.
 */
async function promptVaultName(): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode("Enter vault name: "));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) {
    throw new UserError("No input provided for vault name.");
  }

  return decoder.decode(buf.subarray(0, n)).trim();
}

export const vaultCreateCommand = withRemoteOptions(
  new Command()
    .name("create")
    .description("Create a new vault configuration")
    .example(
      "Create a local vault",
      "swamp vault create local_encryption my-vault",
    )
    .example(
      "With provider config",
      `swamp vault create aws-secrets-manager my-vault --config '{"region":"us-east-1"}'`,
    )
    .arguments("<type:string> [name:string]")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--config <json:string>",
      "Provider configuration as JSON",
    )
    .option(
      "--audit-reads",
      "Enable read access audit trail for this vault (can also be set later with vault edit)",
    ),
).action(
  async function (
    options: AnyOptions,
    vaultType: string,
    vaultNameArg?: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "vault",
      "create",
    ]);

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      const token = await resolveServerToken(
        server,
        options.token as string | undefined,
      );
      let config: Record<string, unknown> | undefined;
      if (options.config) {
        try {
          config = JSON.parse(options.config) as Record<string, unknown>;
        } catch {
          throw new UserError(
            `Invalid JSON in --config: ${options.config}`,
          );
        }
      }
      const response = await requestServerResponse<VaultCreateResponse>(
        { server, token },
        {
          type: "vault.create",
          payload: {
            vaultType,
            name: vaultNameArg,
            config,
            auditReads: options.auditReads,
          },
        },
      );
      const renderer = createVaultCreateRenderer(cliCtx.outputMode);
      renderer.handlers().completed({
        kind: "completed",
        data: response.data as unknown as VaultCreateData,
      });
      return;
    }

    const { repoDir } = await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    // Get vault name - prompt if not provided (stays in CLI)
    let vaultName = vaultNameArg;
    if (!vaultName) {
      if (cliCtx.outputMode === "json") {
        throw new UserError(
          "Vault name is required in non-interactive mode. Usage: swamp vault create <type> <name>",
        );
      }
      vaultName = await promptVaultName();
      if (!vaultName) {
        throw new UserError("Vault name is required.");
      }
    }

    // Parse --config JSON (stays in CLI as input parsing)
    let config: Record<string, unknown> | undefined;
    if (options.config) {
      try {
        config = JSON.parse(options.config) as Record<string, unknown>;
      } catch {
        throw new UserError(
          `Invalid JSON in --config: ${options.config}`,
        );
      }
    }

    // Validate type before the auth gate so typos produce "unknown type"
    // instead of a paywall. Renamed types get a helpful redirect message.
    if (vaultType.toLowerCase() !== "local_encryption") {
      const renamed = RENAMED_VAULT_TYPES[vaultType.toLowerCase()];
      if (
        !renamed && !vaultType.startsWith("@") &&
        !vaultTypeRegistry.has(vaultType)
      ) {
        const availableTypes = vaultTypeRegistry.getAll()
          .map((t) => t.type).join(", ");
        throw new UserError(
          `Unknown vault type: ${vaultType}. Available types: ${availableTypes}. Use 'swamp vault type search' to see available types.`,
        );
      }
      requireAuthenticated("Non-local vaults are a team feature", "vault:*");
      requireScope("vault:*");
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createVaultCreateDeps(repoDir);
    const renderer = createVaultCreateRenderer(cliCtx.outputMode);
    await consumeStream(
      vaultCreate(ctx, deps, {
        vaultType,
        name: vaultName,
        config,
        repoDir,
        auditReads: options.auditReads,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Vault create command completed");
  },
);
