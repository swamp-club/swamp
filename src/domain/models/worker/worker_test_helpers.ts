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

/**
 * Test helpers for the built-in worker-management models: an in-memory
 * MethodContext whose resource writes/reads and vault operations are backed
 * by maps, so model methods can be exercised without a datastore.
 */

import { getLogger } from "@logtape/logtape";
import type { DataHandle, MethodContext } from "../model.ts";
import type { ModelType } from "../model_type.ts";
import { generateDataId } from "../../data/data_id.ts";

export interface InMemoryWorkerContext {
  context: MethodContext;
  /** Latest attributes per data name. */
  store: Map<string, Record<string, unknown>>;
  /** Number of versions written per data name. */
  versions: Map<string, number>;
  /** In-memory vault: `${vaultName}/${secretKey}` → value. */
  vault: Map<string, string>;
}

export function createInMemoryWorkerContext(
  modelType: ModelType,
  instanceName: string,
): InMemoryWorkerContext {
  const store = new Map<string, Record<string, unknown>>();
  const versions = new Map<string, number>();
  const vault = new Map<string, string>();

  const writeResource = (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<DataHandle> => {
    store.set(name, structuredClone(data));
    const version = (versions.get(name) ?? 0) + 1;
    versions.set(name, version);
    const handle: DataHandle = {
      name,
      specName,
      kind: "resource",
      dataId: generateDataId(),
      version,
      size: JSON.stringify(data).length,
      tags: {},
      metadata: {} as DataHandle["metadata"],
    };
    return Promise.resolve(handle);
  };

  const context = {
    signal: new AbortController().signal,
    repoDir: "/tmp",
    modelType,
    modelId: crypto.randomUUID(),
    globalArgs: {},
    definition: { id: "test-id", name: instanceName, version: 1, tags: {} },
    methodName: "test",
    logger: getLogger(["test"]),
    writeResource,
    readResource: (name: string) =>
      Promise.resolve(
        store.has(name) ? structuredClone(store.get(name)!) : null,
      ),
    vaultService: {
      get: (vaultName: string, secretKey: string) => {
        const value = vault.get(`${vaultName}/${secretKey}`);
        if (value === undefined) {
          return Promise.reject(
            new Error(`Secret '${secretKey}' not found in '${vaultName}'`),
          );
        }
        return Promise.resolve(value);
      },
      put: (vaultName: string, secretKey: string, secretValue: string) => {
        vault.set(`${vaultName}/${secretKey}`, secretValue);
        return Promise.resolve();
      },
    },
    extensionFile: () => {
      throw new Error("extensionFile not available in worker model tests");
    },
    createCelEnvironment: () => {
      throw new Error(
        "createCelEnvironment not available in worker model tests",
      );
    },
  } as unknown as MethodContext;

  return { context, store, versions, vault };
}
