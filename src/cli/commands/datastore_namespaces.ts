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
  datastoreNamespaceList,
} from "../../libswamp/mod.ts";
import {
  createNamespaceListRenderer,
} from "../../presentation/renderers/datastore_namespace_list.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { resolveDatastoreForRepo } from "../repo_context.ts";
import { datastoreBasePath } from "../resolve_datastore.ts";
import {
  listNamespaceManifests,
} from "../../infrastructure/persistence/namespace_manifest.ts";
import {
  type CustomDatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const datastoreNamespacesCommand = new Command()
  .description("List all namespaces in the datastore")
  .example("List namespaces", "swamp datastore namespace list")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "namespaces",
    ]);
    cliCtx.logger.debug("Executing datastore namespaces command");

    const repoDir = resolveRepoDir(options.repoDir);
    const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
    const dsBasePath = datastoreBasePath(datastoreConfig);

    let listProvider: DatastoreProvider | undefined;
    if (isCustomDatastoreConfig(datastoreConfig)) {
      await datastoreTypeRegistry.ensureLoaded();
      await datastoreTypeRegistry.ensureTypeLoaded(datastoreConfig.type);
      const typeInfo = datastoreTypeRegistry.get(datastoreConfig.type);
      listProvider = typeInfo?.createProvider?.(datastoreConfig.config);
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = {
      getCurrentNamespace: () => datastoreConfig.namespace,
      listNamespaces: async () => {
        if (listProvider?.listNamespaces) {
          const slugs = await listProvider.listNamespaces(
            (datastoreConfig as CustomDatastoreConfig).datastorePath,
          );
          return slugs.map((ns) => ({
            namespace: ns,
            repoId: "",
            registeredAt: "",
          }));
        }
        return await listNamespaceManifests(dsBasePath);
      },
    };

    const renderer = createNamespaceListRenderer(cliCtx.outputMode);
    await consumeStream(
      datastoreNamespaceList(ctx, deps),
      renderer.handlers(),
    );
  });
