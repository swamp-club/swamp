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
import { isAbsolute, join, resolve } from "@std/path";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { resolveDatastoreForRepo } from "../repo_context.ts";
import {
  consumeStream,
  createDatastoreSetupDeps,
  createLibSwampContext,
  datastoreSetupExtension,
  datastoreSetupFilesystem,
} from "../../libswamp/mod.ts";
import { createDatastoreSetupRenderer } from "../../presentation/renderers/datastore_setup.ts";
import {
  type DatastoreConfig,
  DEFAULT_DATASTORE_SUBDIRS,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import { expandEnvVars } from "../../infrastructure/persistence/env_path.ts";
import { getSwampDataDir } from "../../infrastructure/persistence/paths.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { resolveDatastoreType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { RENAMED_DATASTORE_TYPES } from "../resolve_datastore.ts";
import { UserError } from "../../domain/errors.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { parseTimeoutFlag } from "./datastore_sync.ts";
import { requireAuthenticated, requireScope } from "../auth_context.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { dim, yellow } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import {
  promptChoice,
  promptLine,
  promptLineWithDefault,
} from "../prompt_helpers.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const encoder = new TextEncoder();

/**
 * Resolves the outgoing datastore's cache path when switching to filesystem.
 * Returns undefined when the current datastore is already filesystem-based.
 */
async function resolveOutgoingCachePath(
  repoDir: string,
): Promise<{ resolvedRepoDir: string; outgoingCachePath?: string }> {
  try {
    const { repoDir: resolvedRepoDir, datastoreConfig, marker } =
      await resolveDatastoreForRepo(repoDir);
    if (isCustomDatastoreConfig(datastoreConfig)) {
      const cachePath = datastoreConfig.cachePath ??
        join(getSwampDataDir(), "repos", marker?.repoId ?? "unknown");
      return { resolvedRepoDir, outgoingCachePath: cachePath };
    }
    return { resolvedRepoDir };
  } catch {
    // Extension may be uninstalled — fall back to reading the marker
    // directly to get repoId and compute the default cache path.
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    if (!marker) {
      throw new UserError(
        `Not a swamp repository: ${repoPath.value}. ` +
          "To initialize a new repository, run 'swamp repo init'.",
      );
    }
    if (marker.repoId && marker.datastore?.type !== "filesystem") {
      const cachePath = join(
        getSwampDataDir(),
        "repos",
        marker.repoId,
      );
      return {
        resolvedRepoDir: repoPath.value,
        outgoingCachePath: cachePath,
      };
    }
    return { resolvedRepoDir: repoPath.value };
  }
}

async function nudgeVaultMigration(repoDir: string): Promise<void> {
  try {
    const vaultRepo = new YamlVaultConfigRepository(repoDir);
    const configs = await vaultRepo.findAll();
    const localVaults = configs.filter((vc) => vc.type === "local_encryption");
    if (localVaults.length > 0) {
      const names = localVaults.map((v) => v.name).join(", ");
      writeOutput(
        `\n${
          yellow("⚠")
        } ${localVaults.length} vault(s) still use local encryption: ${names}` +
          `\n${
            dim(
              "  Local encryption keys won't work on other machines. Migrate with: swamp vault migrate <vault>",
            )
          }`,
      );
    }
  } catch {
    // Best-effort — vault discovery failure should never block datastore setup
  }
}

const datastoreSetupFilesystemCommand = new Command()
  .description("Set up a filesystem datastore")
  .example(
    "Set up filesystem datastore",
    "swamp datastore setup filesystem --path ~/swamp-data",
  )
  .example(
    "Custom subdirectories",
    "swamp datastore setup filesystem --path /data --directories models,outputs",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--path <path:string>", "Path for the datastore directory", {
    required: true,
  })
  .option(
    "--directories <dirs:string[]>",
    "Subdirectories to store in the datastore (comma-separated)",
  )
  .option(
    "--skip-migration",
    "Skip copying existing data into the target path",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "setup",
      "filesystem",
    ]);

    const { resolvedRepoDir: repoDir, outgoingCachePath } =
      await resolveOutgoingCachePath(resolveRepoDir(options.repoDir));

    // Expand env vars (e.g. ~/data or $HOME/data) then resolve path
    const expandedPath = expandEnvVars(options.path);
    const datastorePath = isAbsolute(expandedPath)
      ? expandedPath
      : resolve(repoDir, expandedPath);

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createDatastoreSetupDeps(repoDir);
    const renderer = createDatastoreSetupRenderer(cliCtx.outputMode);

    await consumeStream(
      datastoreSetupFilesystem(ctx, deps, {
        datastorePath,
        repoDir,
        directories: options.directories ??
          [...DEFAULT_DATASTORE_SUBDIRS],
        skipMigration: !!options.skipMigration,
        outgoingCachePath,
      }),
      renderer.handlers(),
    );
  });

const datastoreSetupExtensionCommand = new Command()
  .description(
    "Set up an extension-provided datastore (e.g., @swamp/s3-datastore)",
  )
  .example(
    "Set up S3 datastore",
    `swamp datastore setup extension @swamp/s3-datastore --config '{"bucket":"my-bucket","region":"us-east-1"}'`,
  )
  .example(
    "Set up with namespace (shared prefix)",
    `swamp datastore setup extension @swamp/s3-datastore --namespace my-project --config '{"bucket":"shared","prefix":"swamp","region":"us-east-1"}'`,
  )
  .arguments("<type:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--config <config:string>",
    'JSON config object for the extension (e.g., \'{"bucket":"name","region":"us-east-1"}\')',
    { required: true },
  )
  .option(
    "--namespace <slug:string>",
    "Namespace to scope this datastore to (avoids absorbing foreign data from shared prefixes)",
  )
  .option(
    "--skip-migration",
    "Skip pushing local .swamp/ data to the remote (does not skip remote→local cache hydration, which always runs)",
  )
  .option(
    "--hydration-strategy <strategy:string>",
    'Content download strategy: "full" (default, download everything) or "lazy" (metadata only, download content on demand)',
  )
  .option(
    "--timeout <seconds:integer>",
    "Override the sync timeout for the initial push and hydration pull (seconds, " +
      "max 21600). Wins over SWAMP_DATASTORE_SYNC_TIMEOUT_MS. " +
      "Preferred escape hatch for large first-time setups.",
  )
  .action(async function (options: AnyOptions, type: string) {
    requireAuthenticated(
      "External datastores are a team feature",
      "datastore:*",
    );
    requireScope("datastore:*");

    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "setup",
      "extension",
    ]);

    // Remap legacy type names (e.g., "s3" → "@swamp/s3-datastore")
    const renamedTo = RENAMED_DATASTORE_TYPES[type];
    const resolvedType = renamedTo ?? type;

    await datastoreTypeRegistry.ensureLoaded();

    // Auto-resolve the extension if needed — catch network errors so
    // the registry check below produces a clean UserError instead of
    // an opaque stack trace.
    if (resolvedType.startsWith("@")) {
      try {
        await resolveDatastoreType(resolvedType, getAutoResolver());
      } catch {
        // Fall through to the registry check which has a user-friendly error
      }
    }

    if (!datastoreTypeRegistry.has(resolvedType)) {
      throw new UserError(
        `Datastore type "${resolvedType}" is not registered. ` +
          `Install it with: swamp extension pull ${resolvedType}`,
      );
    }

    // Parse config JSON and extract namespace before provider validation
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(options.config) as Record<string, unknown>;
    } catch {
      throw new UserError(
        `Invalid JSON in --config: ${options.config}`,
      );
    }

    const { namespace: configNamespace, ...providerConfig } = config;

    const { repoDir, marker } = await resolveDatastoreForRepo(
      resolveRepoDir(options.repoDir),
    );

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createDatastoreSetupDeps(repoDir);
    const renderer = createDatastoreSetupRenderer(cliCtx.outputMode);

    const hydrationStrategy = options.hydrationStrategy as
      | "full"
      | "lazy"
      | undefined;
    if (
      hydrationStrategy !== undefined && hydrationStrategy !== "full" &&
      hydrationStrategy !== "lazy"
    ) {
      throw new UserError(
        `Invalid --hydration-strategy: "${hydrationStrategy}". Must be "full" or "lazy".`,
      );
    }

    const syncTimeoutMsOverride = options.timeout != null
      ? parseTimeoutFlag(options.timeout)
      : undefined;

    // Resolve namespace: --namespace flag wins, then --config JSON, then
    // existing .swamp.yaml value. The namespace MUST survive setup so the
    // initial pullChanged is scoped and the written config preserves it.
    const namespace = typeof options.namespace === "string"
      ? options.namespace
      : typeof configNamespace === "string"
      ? configNamespace
      : marker?.datastore?.namespace;

    await consumeStream(
      datastoreSetupExtension(ctx, deps, {
        type: resolvedType,
        config: providerConfig,
        repoDir,
        repoId: marker?.repoId,
        skipMigration: !!options.skipMigration,
        hydrationStrategy,
        namespace,
        syncTimeoutMsOverride,
      }),
      renderer.handlers(),
    );

    await nudgeVaultMigration(repoDir);
  });

const datastoreSetupS3DeprecatedCommand = new Command()
  .description(
    "(Removed) Use: swamp datastore setup extension @swamp/s3-datastore --config '{...}'",
  )
  .arguments("[...args:string]")
  .action(() => {
    throw new UserError(
      `The "datastore setup s3" command has been removed.\n\n` +
        `S3 datastores are now provided by the @swamp/s3-datastore extension.\n` +
        `Use the new generic command instead:\n\n` +
        `  swamp datastore setup extension @swamp/s3-datastore \\\n` +
        `    --config '{"bucket":"my-bucket","region":"us-east-1"}'`,
    );
  });

/**
 * Describes the current datastore configuration for display during
 * interactive setup.
 */
function describeCurrentDatastore(
  datastoreConfig: DatastoreConfig,
): string {
  if (isCustomDatastoreConfig(datastoreConfig)) {
    return `${datastoreConfig.type} (${datastoreConfig.datastorePath})`;
  }
  return `filesystem (${datastoreConfig.path})`;
}

/** Configure a datastore for this repository. */
export const datastoreSetupCommand = new Command()
  .description("Configure a datastore for this repository")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "setup",
    ]);

    if (cliCtx.outputMode === "json") {
      throw new UserError(
        "Interactive datastore setup is not available in JSON mode. " +
          "Use 'swamp datastore setup filesystem' or " +
          "'swamp datastore setup extension' with explicit flags.",
      );
    }

    const repoDir = resolveRepoDir(options.repoDir);

    // Resolve the current datastore configuration up front. The result is
    // reused later by the filesystem branch to detect a remote-to-filesystem
    // transition (ADV-6: avoids a redundant resolveDatastoreForRepo call).
    let currentResolution:
      | Awaited<
        ReturnType<typeof resolveDatastoreForRepo>
      >
      | undefined;
    try {
      currentResolution = await resolveDatastoreForRepo(repoDir);
      await Deno.stdout.write(
        encoder.encode(
          `\nCurrent datastore: ${
            describeCurrentDatastore(currentResolution.datastoreConfig)
          }\n\n`,
        ),
      );
    } catch {
      await Deno.stdout.write(
        encoder.encode("\nNo datastore currently configured.\n\n"),
      );
    }

    // Ask where to store data
    const CHOICES = [
      "AWS S3 / S3-compatible",
      "Google Cloud Storage",
      "Shared filesystem",
      "Other",
    ];
    const choice = await promptChoice(
      "Where do you want to store data?",
      CHOICES,
    );

    let extensionType: string | undefined;
    let datastoreConfig: Record<string, unknown> | undefined;
    let filesystemPath: string | undefined;

    if (choice === "AWS S3 / S3-compatible") {
      extensionType = "@swamp/s3-datastore";
      const defaultRegion = Deno.env.get("AWS_DEFAULT_REGION") ??
        Deno.env.get("AWS_REGION") ?? "us-east-1";

      const bucket = await promptLine("S3 bucket name: ");
      if (!bucket) {
        throw new UserError("No bucket name provided.");
      }
      const prefix = await promptLineWithDefault("Key prefix:", "");
      const region = await promptLineWithDefault("AWS region:", defaultRegion);

      const endpoint = await promptLine(
        "Custom endpoint (for MinIO/S3-compatible, or Enter to skip): ",
      );

      datastoreConfig = { bucket, region };
      if (prefix) {
        datastoreConfig.prefix = prefix;
      }
      if (endpoint) {
        datastoreConfig.endpoint = endpoint;
        datastoreConfig.forcePathStyle = true;
      }
    } else if (choice === "Google Cloud Storage") {
      extensionType = "@swamp/gcs-datastore";

      const bucket = await promptLine("GCS bucket name: ");
      if (!bucket) {
        throw new UserError("No bucket name provided.");
      }
      const prefix = await promptLineWithDefault("Key prefix:", "");

      datastoreConfig = { bucket };
      if (prefix) {
        datastoreConfig.prefix = prefix;
      }
    } else if (choice === "Shared filesystem") {
      const path = await promptLine("Datastore path: ");
      if (!path) {
        throw new UserError("No path provided.");
      }
      filesystemPath = path;
    } else {
      // Other: search for a datastore extension by name
      const query = await promptLine(
        "Search for a datastore extension (e.g. azure, minio): ",
      );
      if (!query) {
        throw new UserError("No search query provided.");
      }

      await Deno.stdout.write(
        encoder.encode(`\nSearching for "${query}" datastore extensions…\n`),
      );

      const searchCmd = new Deno.Command(Deno.execPath(), {
        args: [
          "extension",
          "search",
          query,
          "--content-type",
          "datastores",
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
          // If JSON parsing fails, treat as no results
        }
      }

      if (searchResults.length === 0) {
        throw new UserError(
          `No datastore extensions found for "${query}". ` +
            `Browse available extensions at https://swamp-club.com/extensions`,
        );
      }

      const typeChoices = searchResults.map((r) =>
        `${r.type} — ${r.description}`
      );
      const chosen = await promptChoice(
        "Which datastore extension?",
        typeChoices,
      );
      extensionType = chosen.split(" — ")[0];

      const configJson = await promptLine(
        `Config JSON for ${extensionType} (e.g. {}): `,
      );
      try {
        datastoreConfig = JSON.parse(configJson || "{}") as Record<
          string,
          unknown
        >;
      } catch {
        throw new UserError(`Invalid JSON: ${configJson}`);
      }
    }

    // Execute the chosen setup path
    if (filesystemPath) {
      let resolvedRepoDir: string;
      let outgoingCachePath: string | undefined;

      if (currentResolution) {
        resolvedRepoDir = currentResolution.repoDir;
        if (isCustomDatastoreConfig(currentResolution.datastoreConfig)) {
          outgoingCachePath = currentResolution.datastoreConfig.cachePath ??
            join(
              getSwampDataDir(),
              "repos",
              currentResolution.marker?.repoId ?? "unknown",
            );
        }
      } else {
        const result = await resolveOutgoingCachePath(repoDir);
        resolvedRepoDir = result.resolvedRepoDir;
        outgoingCachePath = result.outgoingCachePath;
      }

      const expandedPath = expandEnvVars(filesystemPath);
      const datastorePath = isAbsolute(expandedPath)
        ? expandedPath
        : resolve(resolvedRepoDir, expandedPath);

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const deps = createDatastoreSetupDeps(resolvedRepoDir);
      const renderer = createDatastoreSetupRenderer(cliCtx.outputMode);

      await consumeStream(
        datastoreSetupFilesystem(ctx, deps, {
          datastorePath,
          repoDir: resolvedRepoDir,
          directories: [...DEFAULT_DATASTORE_SUBDIRS],
          skipMigration: false,
          outgoingCachePath,
        }),
        renderer.handlers(),
      );
    } else if (extensionType) {
      requireAuthenticated(
        "External datastores are a team feature",
        "datastore:*",
      );
      requireScope("datastore:*");
      await datastoreTypeRegistry.ensureLoaded();
      try {
        await resolveDatastoreType(extensionType, getAutoResolver());
      } catch {
        // Fall through to registry check
      }
      if (!datastoreTypeRegistry.has(extensionType)) {
        throw new UserError(
          `Datastore type "${extensionType}" is not registered. ` +
            `Install it with: swamp extension pull ${extensionType}`,
        );
      }

      const { repoDir: resolvedRepoDir, marker } =
        await resolveDatastoreForRepo(repoDir);

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const deps = createDatastoreSetupDeps(resolvedRepoDir);
      const renderer = createDatastoreSetupRenderer(cliCtx.outputMode);

      await consumeStream(
        datastoreSetupExtension(ctx, deps, {
          type: extensionType,
          config: datastoreConfig ?? {},
          repoDir: resolvedRepoDir,
          repoId: marker?.repoId,
          skipMigration: false,
          namespace: marker?.datastore?.namespace,
        }),
        renderer.handlers(),
      );

      await nudgeVaultMigration(resolvedRepoDir);
    }
  })
  .command("filesystem", datastoreSetupFilesystemCommand)
  .command("extension", datastoreSetupExtensionCommand)
  .command("s3", datastoreSetupS3DeprecatedCommand);
