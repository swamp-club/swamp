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
import { isAbsolute, resolve } from "@std/path";
import { createContext, type GlobalOptions } from "../context.ts";
import {
  requireInitializedRepo,
  resolveDatastoreForRepo,
} from "../repo_context.ts";
import {
  consumeStream,
  createDatastoreSetupDeps,
  createLibSwampContext,
  datastoreSetupExtension,
  datastoreSetupFilesystem,
} from "../../libswamp/mod.ts";
import { createDatastoreSetupRenderer } from "../../presentation/renderers/datastore_setup.ts";
import { DEFAULT_DATASTORE_SUBDIRS } from "../../domain/datastore/datastore_config.ts";
import { expandEnvVars } from "../../infrastructure/persistence/env_path.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { resolveDatastoreType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { RENAMED_DATASTORE_TYPES } from "../resolve_datastore.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const datastoreSetupFilesystemCommand = new Command()
  .description("Set up a filesystem datastore")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--path <path:string>", "Path for the datastore directory", {
    required: true,
  })
  .option(
    "--directories <dirs:string[]>",
    "Subdirectories to store in the datastore (comma-separated)",
  )
  .option("--skip-migration", "Skip migrating existing data")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "setup",
      "filesystem",
    ]);

    const { repoDir } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: cliCtx.outputMode,
    });

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
      }),
      renderer.handlers(),
    );
  });

const datastoreSetupExtensionCommand = new Command()
  .description(
    "Set up an extension-provided datastore (e.g., @swamp/s3-datastore)",
  )
  .arguments("<type:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option(
    "--config <config:string>",
    'JSON config object for the extension (e.g., \'{"bucket":"name","region":"us-east-1"}\')',
    { required: true },
  )
  .option("--skip-migration", "Skip migrating existing data")
  .action(async function (options: AnyOptions, type: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "setup",
      "extension",
    ]);

    // Remap legacy type names (e.g., "s3" → "@swamp/s3-datastore")
    const renamedTo = RENAMED_DATASTORE_TYPES[type];
    const resolvedType = renamedTo ?? type;

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

    // Parse config JSON
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(options.config) as Record<string, unknown>;
    } catch {
      throw new UserError(
        `Invalid JSON in --config: ${options.config}`,
      );
    }

    const { repoDir, marker } = await resolveDatastoreForRepo(
      options.repoDir ?? ".",
    );

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createDatastoreSetupDeps(repoDir);
    const renderer = createDatastoreSetupRenderer(cliCtx.outputMode);

    await consumeStream(
      datastoreSetupExtension(ctx, deps, {
        type: resolvedType,
        config,
        repoDir,
        repoId: marker?.repoId,
        skipMigration: !!options.skipMigration,
      }),
      renderer.handlers(),
    );
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

/** Configure a datastore for this repository. */
export const datastoreSetupCommand = new Command()
  .description("Configure a datastore for this repository")
  .command("filesystem", datastoreSetupFilesystemCommand)
  .command("extension", datastoreSetupExtensionCommand)
  .command("s3", datastoreSetupS3DeprecatedCommand);
