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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  type CustomDatastoreConfig,
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { listNamespaceManifests } from "../../infrastructure/persistence/namespace_manifest.ts";
import { datastoreEngineOf } from "../../infrastructure/persistence/datastore_format_guard.ts";
import { listV3Namespaces } from "../../infrastructure/datastore_v3/v3_datastore.ts";

export interface NamespaceInfo {
  namespace: string;
  repoId: string;
  registeredAt: string;
  isCurrent: boolean;
}

export interface NamespaceListData {
  namespaces: NamespaceInfo[];
  currentNamespace: string | undefined;
}

export type NamespaceListEvent =
  | { kind: "completed"; data: NamespaceListData }
  | { kind: "error"; error: SwampError };

export interface NamespaceListDeps {
  getCurrentNamespace: () => string | undefined;
  listNamespaces: () => Promise<
    Array<{ namespace: string; repoId: string; registeredAt: string }>
  >;
}

/**
 * The namespace list dependencies for the datastore `config` names, shared
 * by the CLI and serve. An extension datastore lists through its provider,
 * a v2 filesystem datastore from its namespace manifests, and a v3 one from
 * the namespaces its commits name (swamp-club#3301), plus the current
 * namespace before its first commit. Entries without a manifest carry an
 * empty `repoId` and `registeredAt`.
 */
export async function createNamespaceListDeps(
  config: DatastoreConfig,
): Promise<NamespaceListDeps> {
  const unregistered = (namespace: string) => ({
    namespace,
    repoId: "",
    registeredAt: "",
  });

  if (isCustomDatastoreConfig(config)) {
    await datastoreTypeRegistry.ensureLoaded();
    await datastoreTypeRegistry.ensureTypeLoaded(config.type);
    const provider: DatastoreProvider | undefined = datastoreTypeRegistry
      .get(config.type)?.createProvider?.(config.config);
    return {
      getCurrentNamespace: () => config.namespace,
      listNamespaces: async () => {
        if (provider?.listNamespaces) {
          const slugs = await provider.listNamespaces(
            (config as CustomDatastoreConfig).datastorePath,
          );
          return slugs.map(unregistered);
        }
        return await listNamespaceManifests(config.datastorePath);
      },
    };
  }

  if (datastoreEngineOf(config) === "v3") {
    return {
      getCurrentNamespace: () => config.namespace,
      listNamespaces: () => {
        const namespaces = listV3Namespaces(config.path);
        if (config.namespace && !namespaces.includes(config.namespace)) {
          namespaces.push(config.namespace);
          namespaces.sort();
        }
        return Promise.resolve(namespaces.map(unregistered));
      },
    };
  }

  return {
    getCurrentNamespace: () => config.namespace,
    listNamespaces: () => listNamespaceManifests(config.path),
  };
}

export async function* datastoreNamespaceList(
  _ctx: LibSwampContext,
  deps: NamespaceListDeps,
): AsyncIterable<NamespaceListEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.namespace.list",
    {},
    (async function* () {
      const current = deps.getCurrentNamespace();
      const manifests = await deps.listNamespaces();

      const namespaces: NamespaceInfo[] = manifests.map((m) => ({
        namespace: m.namespace,
        repoId: m.repoId,
        registeredAt: m.registeredAt,
        isCurrent: m.namespace === current,
      }));

      yield {
        kind: "completed",
        data: { namespaces, currentNamespace: current },
      };
    })(),
  );
}
