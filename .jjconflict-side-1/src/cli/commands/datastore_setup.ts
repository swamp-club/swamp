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
import { requireInitializedRepo } from "../repo_context.ts";
import {
  consumeStream,
  createDatastoreSetupDeps,
  createLibSwampContext,
  datastoreSetupFilesystem,
  datastoreSetupS3,
} from "../../libswamp/mod.ts";
import { createDatastoreSetupRenderer } from "../../presentation/renderers/datastore_setup.ts";
import { DEFAULT_DATASTORE_SUBDIRS } from "../../domain/datastore/datastore_config.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { expandEnvVars } from "../../infrastructure/persistence/env_path.ts";

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

const datastoreSetupS3Command = new Command()
  .description("Set up an S3 datastore")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--bucket <bucket:string>", "S3 bucket name", { required: true })
  .option("--prefix <prefix:string>", "Key prefix within the bucket")
  .option("--region <region:string>", "AWS region")
  .option("--skip-migration", "Skip pushing existing data to S3")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "setup",
      "s3",
    ]);

    const { repoDir } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: cliCtx.outputMode,
    });

    // Read marker to get repoId for cache path
    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(repoDir);
    const marker = await markerRepo.read(repoPath);

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createDatastoreSetupDeps(repoDir);
    const renderer = createDatastoreSetupRenderer(cliCtx.outputMode);

    await consumeStream(
      datastoreSetupS3(ctx, deps, {
        bucket: options.bucket,
        prefix: options.prefix,
        region: options.region,
        repoDir,
        repoId: marker?.repoId,
        skipMigration: !!options.skipMigration,
      }),
      renderer.handlers(),
    );
  });

/**
 * Sets up a filesystem or S3 datastore.
 */
export const datastoreSetupCommand = new Command()
  .description("Configure a datastore for this repository")
  .command("filesystem", datastoreSetupFilesystemCommand)
  .command("s3", datastoreSetupS3Command);
