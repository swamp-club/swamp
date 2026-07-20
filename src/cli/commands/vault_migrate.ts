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
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import {
  promptChoice,
  promptConfirmation,
  promptLine,
} from "../prompt_helpers.ts";

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
  .option("--to-type <type:string>", "Target vault type")
  .option(
    "--config <config:string>",
    'Provider-specific config as JSON (e.g. \'{"region":"us-east-1"}\')',
  )
  .option("-y, --yes", "Skip confirmation prompt")
  .option("-f, --force", "Skip confirmation prompt (alias for --yes)")
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
    "Interactive migration",
    "swamp vault migrate my-vault",
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

    const { repoDir } = await requireInitializedRepoUnlocked({
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

    // Resolve --to-type: use the provided value or prompt interactively
    let toType: string = options.toType;
    if (!toType) {
      if (cliCtx.outputMode === "json") {
        throw new UserError(
          "Interactive vault migration is not available in JSON mode. Provide --to-type explicitly.",
        );
      }

      // Look up the vault to show current type
      const vaultConfig = await deps.findVaultConfig(vaultName);
      if (!vaultConfig) {
        throw new UserError(
          `Vault '${vaultName}' not found. Use 'swamp vault search' to see available vaults.`,
        );
      }

      const currentType = vaultConfig.type;
      const logger = getSwampLogger(["vault", "migrate"]);
      logger
        .info`Vault ${vaultName} is currently using type ${currentType}.`;

      const VAULT_CHOICES = [
        "AWS Secrets Manager",
        "Azure Key Vault",
        "1Password",
        "Other",
      ];
      const chosen = await promptChoice(
        "Select the target vault provider:",
        VAULT_CHOICES,
      );

      if (chosen === "AWS Secrets Manager") {
        toType = "@swamp/aws-sm";
        const region = await promptLine("AWS region (e.g. us-east-1): ");
        if (region) {
          targetConfig = { region };
        }
      } else if (chosen === "Azure Key Vault") {
        toType = "@swamp/azure-kv";
        const vaultUrl = await promptLine("Azure Key Vault URL: ");
        if (vaultUrl) {
          targetConfig = { vaultUrl };
        }
      } else if (chosen === "1Password") {
        toType = "@swamp/1password";
        const vault = await promptLine(
          "1Password vault name (or Enter for default): ",
        );
        if (vault) {
          targetConfig = { vault };
        }
      } else {
        // Other: search for a vault extension by keyword
        const query = await promptLine(
          "Search for a vault extension (e.g. hashicorp, doppler): ",
        );
        if (!query) {
          throw new UserError("No search query provided.");
        }

        const encoder = new TextEncoder();
        await Deno.stdout.write(
          encoder.encode(
            `\nSearching for "${query}" vault extensions…\n`,
          ),
        );

        const searchCmd = new Deno.Command(Deno.execPath(), {
          args: [
            "extension",
            "search",
            query,
            "--content-type",
            "vaults",
            "--json",
          ],
          stdout: "piped",
          stderr: "piped",
          signal: AbortSignal.timeout(30_000),
        });
        const searchOutput = await searchCmd.output();
        let searchResults: Array<{ type: string; description: string }> = [];
        if (searchOutput.success) {
          try {
            const parsed = JSON.parse(
              new TextDecoder().decode(searchOutput.stdout),
            ) as {
              extensions?: Array<{
                name: string;
                description: string;
              }>;
            };
            searchResults = (parsed.extensions ?? []).map((r) => ({
              type: r.name,
              description: r.description,
            }));
          } catch {
            // Treat parse failure as no results
          }
        }

        if (searchResults.length === 0) {
          throw new UserError(
            `No vault extensions found for "${query}". ` +
              `Browse available extensions at https://swamp-club.com/extensions`,
          );
        }

        const typeChoices = searchResults.map((r) =>
          `${r.type} — ${r.description}`
        );
        const chosenExt = await promptChoice(
          "Which vault extension?",
          typeChoices,
        );
        toType = chosenExt.split(" — ")[0];

        const configJson = await promptLine(
          `Config JSON for ${toType} (e.g. {}, or Enter to skip): `,
        );
        if (configJson) {
          try {
            targetConfig = JSON.parse(configJson);
          } catch {
            throw new UserError(`Invalid JSON: ${configJson}`);
          }
        }
      }
    }

    // Phase 1: Preview
    let preview;
    try {
      preview = await vaultMigratePreview(ctx, deps, {
        vaultName,
        targetType: toType,
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

    if (cliCtx.outputMode === "log" && !options.yes && !options.force) {
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
        targetType: toType,
        targetConfig,
        repoDir,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Vault migrate command completed");
  });
