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

import { assertCompletes } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  datastoreStatus,
  type DatastoreStatusDeps,
  type DatastoreStatusEvent,
} from "./status.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";

function makeDeps(
  overrides: Partial<DatastoreStatusDeps> = {},
): DatastoreStatusDeps {
  const defaultConfig: DatastoreConfig = {
    type: "filesystem",
    path: "/tmp/swamp-data",
  };
  return {
    loadConfig: () => defaultConfig,
    verifyHealth: () =>
      Promise.resolve({ healthy: true, message: "OK", latencyMs: 5 }),
    getDirectories: () => ["data", "outputs", "workflow-runs"],
    ...overrides,
  };
}

Deno.test("datastoreStatus: healthy filesystem datastore", async () => {
  const deps = makeDeps();

  await assertCompletes<DatastoreStatusEvent>(
    datastoreStatus(createLibSwampContext(), deps),
    {
      kind: "completed",
      data: {
        type: "filesystem",
        path: "/tmp/swamp-data",
        healthy: true,
        message: "OK",
        latencyMs: 5,
        directories: ["data", "outputs", "workflow-runs"],
        exclude: undefined,
      },
    },
  );
});

Deno.test("datastoreStatus: unhealthy datastore", async () => {
  const deps = makeDeps({
    verifyHealth: () =>
      Promise.resolve({
        healthy: false,
        message: "Connection refused",
        latencyMs: 0,
      }),
  });

  await assertCompletes<DatastoreStatusEvent>(
    datastoreStatus(createLibSwampContext(), deps),
    {
      kind: "completed",
      data: {
        type: "filesystem",
        path: "/tmp/swamp-data",
        healthy: false,
        message: "Connection refused",
        latencyMs: 0,
        directories: ["data", "outputs", "workflow-runs"],
        exclude: undefined,
      },
    },
  );
});

Deno.test("datastoreStatus: includes exclude patterns", async () => {
  const config: DatastoreConfig = {
    type: "filesystem",
    path: "/tmp/swamp-data",
    exclude: ["*.log", "temp/"],
  };
  const deps = makeDeps({
    loadConfig: () => config,
  });

  await assertCompletes<DatastoreStatusEvent>(
    datastoreStatus(createLibSwampContext(), deps),
    {
      kind: "completed",
      data: {
        type: "filesystem",
        path: "/tmp/swamp-data",
        healthy: true,
        message: "OK",
        latencyMs: 5,
        directories: ["data", "outputs", "workflow-runs"],
        exclude: ["*.log", "temp/"],
      },
    },
  );
});
