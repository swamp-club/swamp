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

import { Command } from "@cliffy/command";
import {
  consumeStream,
  createLibSwampContext,
  createVaultMigrateDeps,
  vaultMigrate,
  vaultMigratePreview,
} from "../../libswamp/mod.ts";
import {
  createVaultMigrateRenderer,
  renderVaultMigrateCancelled,
} from "../../presentation/renderers/vault_migrate.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

async function promptConfirmation(message: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(`${message} [y/N] `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;

  const response = decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
  return response === "y" || response === "yes";
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultMigrateCommand = new Command()
  .name("migrate")
  .description(
    `Migrate a vault to a different backend type.

Copies all secrets from the current backend to a new one, then updates
the vault configuration. The vault name stays the same, so all existing
vault references continue to work without modification.

Both the source and target vaults must be different types.`,
  )
  .arguments("<vault_name:string>")
  .option("--to-type <type:string>", "Target vault type", { required: true })
  .option(
    "--config <config:string>",
    'Provider-specific config as JSON (e.g. \'{"region":"us-east-1"}\')',
  )
  .option("-f, --force", "Skip confirmation prompt")
  .option("--dry-run", "Preview migration without making changes")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .example(
    "Migrate to AWS Secrets Manager",
    'swamp vault migrate my-vault --to-type @swamp/aws-sm --config \'{"region":"us-east-1"}\'',
  )
  .example(
    "Preview migration (dry run)",
    "swamp vault migrate my-vault --to-type @swamp/aws-sm --dry-run",
  )
  .action(async function (options: AnyOptions, vaultName: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "vault",
      "migrate",
    ]);
    cliCtx.logger.debug`Migrating vault: ${vaultName}`;

    const { repoDir } = await requireInitializedRepo({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    // Parse --config JSON if provided
    let targetConfig: Record<string, unknown> | undefined;
    if (options.config) {
      try {
        targetConfig = JSON.parse(options.config);
      } catch {
        throw new UserError(
          `Invalid JSON in --config: ${options.config}`,
        );
      }
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createVaultMigrateDeps(repoDir);

    // Phase 1: Preview
    let preview;
    try {
      preview = await vaultMigratePreview(ctx, deps, {
        vaultName,
        targetType: options.toType,
        targetConfig,
        repoDir,
      });
    } catch (error) {
      if ("code" in (error as Record<string, unknown>)) {
        throw new UserError((error as { message: string }).message);
      }
      throw error;
    }

    const logger = getSwampLogger(["vault", "migrate"]);

    if (cliCtx.outputMode === "log") {
      logger
        .info`Vault ${preview.vaultName} (${preview.currentType}) has ${preview.secretCount} secret(s).`;
      logger
        .info`Target: ${preview.targetTypeName} (${preview.targetType})`;
    }

    // Phase 2: Dry run or confirmation
    if (options.dryRun) {
      if (cliCtx.outputMode === "json") {
        console.log(JSON.stringify(
          {
            dryRun: true,
            vaultName: preview.vaultName,
            currentType: preview.currentType,
            currentTypeName: preview.currentTypeName,
            targetType: preview.targetType,
            targetTypeName: preview.targetTypeName,
            secretCount: preview.secretCount,
          },
          null,
          2,
        ));
      } else {
        logger.info`Dry run — no changes made.`;
      }
      return;
    }

    if (cliCtx.outputMode === "log" && !options.force) {
      const confirmed = await promptConfirmation(
        `Migrate vault backend from ${preview.currentType} to ${preview.targetType}?`,
      );
      if (!confirmed) {
        renderVaultMigrateCancelled(cliCtx.outputMode);
        return;
      }
    }

    // Phase 3: Execute migration
    const renderer = createVaultMigrateRenderer(cliCtx.outputMode);
    await consumeStream(
      vaultMigrate(ctx, deps, {
        vaultName,
        targetType: options.toType,
        targetConfig,
        repoDir,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Vault migrate command completed");
  });
