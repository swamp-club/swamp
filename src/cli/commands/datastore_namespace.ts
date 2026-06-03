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
  datastoreNamespaceSet,
  datastoreNamespaceUnset,
} from "../../libswamp/mod.ts";
import {
  createNamespaceSetRenderer,
} from "../../presentation/renderers/datastore_namespace_set.ts";
import {
  createNamespaceUnsetRenderer,
} from "../../presentation/renderers/datastore_namespace_unset.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { resolveDatastoreForRepo } from "../repo_context.ts";
import { datastoreBasePath } from "../resolve_datastore.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  listNamespaceManifests,
  writeNamespaceManifest,
} from "../../infrastructure/persistence/namespace_manifest.ts";
import {
  type CustomDatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const datastoreNamespaceSetCommand = new Command()
  .description("Assign a namespace to this repository")
  .example("Set namespace", "swamp datastore namespace set infra")
  .arguments("<slug:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, slug: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "namespace",
      "set",
    ]);
    cliCtx.logger.debug("Executing datastore namespace set command");

    const repoDir = resolveRepoDir(options.repoDir);
    const { datastoreConfig, marker } = await resolveDatastoreForRepo(repoDir);
    const dsBasePath = datastoreBasePath(datastoreConfig);
    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(repoDir);
    const repoId = marker?.repoId ?? crypto.randomUUID();

    let supportsRegistration = true;
    let resolvedProvider: DatastoreProvider | undefined;
    if (isCustomDatastoreConfig(datastoreConfig)) {
      await datastoreTypeRegistry.ensureLoaded();
      await datastoreTypeRegistry.ensureTypeLoaded(datastoreConfig.type);
      const typeInfo = datastoreTypeRegistry.get(datastoreConfig.type);
      resolvedProvider = typeInfo?.createProvider?.(datastoreConfig.config);
      supportsRegistration = !!resolvedProvider?.registerNamespace;
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = {
      getDatastorePath: () => dsBasePath,
      getCurrentNamespace: () => datastoreConfig.namespace,
      supportsRegistration,
      listNamespaces: async () => {
        if (resolvedProvider?.listNamespaces) {
          const slugs = await resolvedProvider.listNamespaces(
            (datastoreConfig as CustomDatastoreConfig).datastorePath,
          );
          return slugs.map((ns) => ({ namespace: ns, repoId: "" }));
        }
        const manifests = await listNamespaceManifests(dsBasePath);
        return manifests.map((m) => ({
          namespace: m.namespace,
          repoId: m.repoId,
        }));
      },
      registerNamespace: async (namespace: string, rId: string) => {
        if (resolvedProvider?.registerNamespace) {
          await resolvedProvider.registerNamespace(
            (datastoreConfig as CustomDatastoreConfig).datastorePath,
            namespace,
            rId,
          );
          return;
        }
        await writeNamespaceManifest(dsBasePath, namespace, rId);
      },
      updateMarkerNamespace: async (namespace: string) => {
        const current = await markerRepo.read(repoPath);
        if (!current) {
          throw new UserError(
            "Cannot update namespace: .swamp.yaml marker not found.",
          );
        }
        current.datastore = current.datastore ?? { type: "filesystem" };
        current.datastore.namespace = namespace;
        await markerRepo.write(repoPath, current);
      },
      getRepoId: () => repoId,
    };

    const renderer = createNamespaceSetRenderer(cliCtx.outputMode);
    await consumeStream(
      datastoreNamespaceSet(ctx, deps, { slug }),
      renderer.handlers(),
    );
  });

export const datastoreNamespaceUnsetCommand = new Command()
  .description("Remove namespace from this repository")
  .example("Unset namespace", "swamp datastore namespace unset")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "namespace",
      "unset",
    ]);
    cliCtx.logger.debug("Executing datastore namespace unset command");

    const repoDir = resolveRepoDir(options.repoDir);
    const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
    const dsBasePath = datastoreBasePath(datastoreConfig);
    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(repoDir);

    let unsetProvider: DatastoreProvider | undefined;
    if (isCustomDatastoreConfig(datastoreConfig)) {
      await datastoreTypeRegistry.ensureLoaded();
      await datastoreTypeRegistry.ensureTypeLoaded(datastoreConfig.type);
      const typeInfo = datastoreTypeRegistry.get(datastoreConfig.type);
      unsetProvider = typeInfo?.createProvider?.(datastoreConfig.config);
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = {
      getCurrentNamespace: () => datastoreConfig.namespace,
      listNamespaces: async () => {
        if (unsetProvider?.listNamespaces) {
          return await unsetProvider.listNamespaces(
            (datastoreConfig as CustomDatastoreConfig).datastorePath,
          );
        }
        const manifests = await listNamespaceManifests(dsBasePath);
        return manifests.map((m) => m.namespace);
      },
      removeMarkerNamespace: async () => {
        const current = await markerRepo.read(repoPath);
        if (current?.datastore) {
          delete current.datastore.namespace;
          await markerRepo.write(repoPath, current);
        }
      },
    };

    const renderer = createNamespaceUnsetRenderer(cliCtx.outputMode);
    await consumeStream(
      datastoreNamespaceUnset(ctx, deps),
      renderer.handlers(),
    );
  });
