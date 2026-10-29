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

import { assertEquals } from "@std/assert";
import { z } from "zod";
import { isMethodMutating, methodRunLockMode } from "./method_run_lock_mode.ts";
import type {
  CustomDatastoreConfig,
  DatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../../domain/datastore/datastore_sync_service.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";

const TEST_TYPE = ModelType.create("test/lock-check");

function registerTestModel(methods: Record<string, { kind?: string }>) {
  const methodDefs: Record<
    string,
    {
      description: string;
      kind?: "read" | "list" | "create" | "update" | "delete" | "action";
      arguments: z.ZodTypeAny;
      execute: () => Promise<Record<string, unknown>>;
    }
  > = {};
  for (const [name, config] of Object.entries(methods)) {
    methodDefs[name] = {
      description: `test method ${name}`,
      ...(config.kind
        ? {
          kind: config.kind as
            | "read"
            | "list"
            | "create"
            | "update"
            | "delete"
            | "action",
        }
        : {}),
      arguments: z.object({}),
      execute: () => Promise.resolve({}),
    };
  }
  modelRegistry.register({
    type: TEST_TYPE,
    version: "2026.01.01.1",
    methods: methodDefs,
  });
}

function cleanup() {
  modelRegistry.invalidateType(TEST_TYPE);
}

Deno.test("isMethodMutating: returns false for method with kind 'read'", async () => {
  registerTestModel({ status: { kind: "read" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "status"), false);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns false for method with kind 'list'", async () => {
  registerTestModel({ search: { kind: "list" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "search"), false);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with kind 'create'", async () => {
  registerTestModel({ provision: { kind: "create" } });
  try {
    assertEquals(
      await isMethodMutating(TEST_TYPE.normalized, "provision"),
      true,
    );
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with kind 'update'", async () => {
  registerTestModel({ patch: { kind: "update" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "patch"), true);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with kind 'action'", async () => {
  registerTestModel({ deploy: { kind: "action" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "deploy"), true);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with no kind and unrecognized name", async () => {
  registerTestModel({ custom_process: {} });
  try {
    assertEquals(
      await isMethodMutating(TEST_TYPE.normalized, "custom_process"),
      true,
    );
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: infers 'read' from name 'get' without explicit kind", async () => {
  registerTestModel({ get: {} });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "get"), false);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: infers 'list' from name 'list' without explicit kind", async () => {
  registerTestModel({ list: {} });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "list"), false);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with kind 'delete'", async () => {
  registerTestModel({ purge: { kind: "delete" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "purge"), true);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for unknown model type", async () => {
  assertEquals(
    await isMethodMutating("nonexistent/model-type", "get"),
    true,
  );
});

Deno.test("isMethodMutating: returns true for unknown method on known model", async () => {
  registerTestModel({ run: { kind: "action" } });
  try {
    assertEquals(
      await isMethodMutating(TEST_TYPE.normalized, "nonexistent"),
      true,
    );
  } finally {
    cleanup();
  }
});

// --- methodRunLockMode (swamp-club#3934) ---

const V2_REMOTE: CustomDatastoreConfig = {
  type: "@test/remote",
  config: {},
  datastorePath: "remote",
  cachePath: "cache",
};
const V3_REMOTE: CustomDatastoreConfig = { ...V2_REMOTE, format: 3 };
const FILESYSTEM: DatastoreConfig = {
  type: "filesystem",
  path: "nonexistent-datastore",
};

function syncService(
  options: { fetchContent: boolean },
): DatastoreSyncService {
  return {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
    ...(options.fetchContent
      ? { fetchContent: () => Promise.resolve(null) }
      : {}),
  };
}

function lockMode(
  methodName: string,
  config: DatastoreConfig,
  service: DatastoreSyncService | undefined,
) {
  return methodRunLockMode({
    modelType: TEST_TYPE.normalized,
    methodName,
    config,
    syncService: service,
    repoContext: { commitLog: undefined },
  });
}

Deno.test("methodRunLockMode: a read run on a v2 extension datastore locks only to publish", async () => {
  registerTestModel({ status: { kind: "read" }, search: { kind: "list" } });
  try {
    const service = syncService({ fetchContent: true });
    assertEquals(await lockMode("status", V2_REMOTE, service), "publish");
    assertEquals(await lockMode("search", V2_REMOTE, service), "publish");
  } finally {
    cleanup();
  }
});

Deno.test("methodRunLockMode: a read run locks only to publish without fetchContent, and takes no lock without a sync service", async () => {
  registerTestModel({ status: { kind: "read" } });
  try {
    assertEquals(
      await lockMode("status", V2_REMOTE, syncService({ fetchContent: false })),
      "publish",
    );
    assertEquals(await lockMode("status", V2_REMOTE, undefined), "none");
  } finally {
    cleanup();
  }
});

Deno.test("methodRunLockMode: a read run on a filesystem or v3 datastore takes no lock", async () => {
  registerTestModel({ status: { kind: "read" } });
  try {
    const service = syncService({ fetchContent: true });
    assertEquals(await lockMode("status", FILESYSTEM, service), "none");
    assertEquals(await lockMode("status", V3_REMOTE, service), "none");
  } finally {
    cleanup();
  }
});

Deno.test("methodRunLockMode: a mutating run locks for the run on every datastore", async () => {
  registerTestModel({ deploy: { kind: "action" } });
  try {
    const service = syncService({ fetchContent: true });
    assertEquals(await lockMode("deploy", V2_REMOTE, service), "run");
    assertEquals(await lockMode("deploy", FILESYSTEM, service), "run");
    assertEquals(await lockMode("deploy", V3_REMOTE, service), "run");
  } finally {
    cleanup();
  }
});

Deno.test("methodRunLockMode: an unresolvable type locks for the run", async () => {
  assertEquals(
    await methodRunLockMode({
      modelType: "nonexistent/model-type",
      methodName: "get",
      config: V2_REMOTE,
      syncService: syncService({ fetchContent: true }),
      repoContext: { commitLog: undefined },
    }),
    "run",
  );
});
