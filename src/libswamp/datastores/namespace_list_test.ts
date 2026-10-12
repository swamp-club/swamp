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
import { join } from "@std/path";
import { assertCompletes, collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createNamespaceListDeps,
  datastoreNamespaceList,
  type NamespaceListData,
  type NamespaceListDeps,
  type NamespaceListEvent,
} from "./namespace_list.ts";
import type { FilesystemDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { writeNamespaceManifest } from "../../infrastructure/persistence/namespace_manifest.ts";
import {
  COMMITS_DB_FILE,
  initializeV3Datastore,
} from "../../infrastructure/datastore_v3/v3_datastore.ts";
import { openCommitsDatabase } from "../../infrastructure/datastore_v3/sqlite_commit_store.ts";

function makeDeps(
  overrides: Partial<NamespaceListDeps> = {},
): NamespaceListDeps {
  return {
    getCurrentNamespace: () => undefined,
    listNamespaces: () => Promise.resolve([]),
    ...overrides,
  };
}

Deno.test("datastoreNamespaceList: empty datastore returns empty list", async () => {
  const deps = makeDeps();
  await assertCompletes<NamespaceListEvent>(
    datastoreNamespaceList(createLibSwampContext(), deps),
    {
      kind: "completed",
      data: { namespaces: [], currentNamespace: undefined },
    },
  );
});

Deno.test("datastoreNamespaceList: lists namespaces with current marker", async () => {
  const deps = makeDeps({
    getCurrentNamespace: () => "infra",
    listNamespaces: () =>
      Promise.resolve([
        {
          namespace: "infra",
          repoId: "repo-1",
          registeredAt: "2026-01-01T00:00:00Z",
        },
        {
          namespace: "security",
          repoId: "repo-2",
          registeredAt: "2026-01-02T00:00:00Z",
        },
      ]),
  });

  await assertCompletes<NamespaceListEvent>(
    datastoreNamespaceList(createLibSwampContext(), deps),
    {
      kind: "completed",
      data: {
        namespaces: [
          {
            namespace: "infra",
            repoId: "repo-1",
            registeredAt: "2026-01-01T00:00:00Z",
            isCurrent: true,
          },
          {
            namespace: "security",
            repoId: "repo-2",
            registeredAt: "2026-01-02T00:00:00Z",
            isCurrent: false,
          },
        ],
        currentNamespace: "infra",
      },
    },
  );
});

Deno.test("datastoreNamespaceList: no current namespace marks none as current", async () => {
  const deps = makeDeps({
    listNamespaces: () =>
      Promise.resolve([
        {
          namespace: "infra",
          repoId: "repo-1",
          registeredAt: "2026-01-01T00:00:00Z",
        },
      ]),
  });

  await assertCompletes<NamespaceListEvent>(
    datastoreNamespaceList(createLibSwampContext(), deps),
    {
      kind: "completed",
      data: {
        namespaces: [
          {
            namespace: "infra",
            repoId: "repo-1",
            registeredAt: "2026-01-01T00:00:00Z",
            isCurrent: false,
          },
        ],
        currentNamespace: undefined,
      },
    },
  );
});

async function withNamespaceTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-namespace-list-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Runs `namespace list` on the datastore `config` names. */
async function listFor(
  config: FilesystemDatastoreConfig,
): Promise<NamespaceListData> {
  const events = await collect<NamespaceListEvent>(
    datastoreNamespaceList(
      createLibSwampContext(),
      await createNamespaceListDeps(config),
    ),
  );
  const completed = events.at(-1) as Extract<
    NamespaceListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  // The fields swamp-uat's NamespaceListSchema requires, as strings.
  for (const entry of completed.data.namespaces) {
    for (const key of ["namespace", "repoId", "registeredAt"] as const) {
      assertEquals(typeof entry[key], "string");
    }
  }
  return completed.data;
}

Deno.test("createNamespaceListDeps: a v3 datastore with no namespace lists none", async () => {
  await withNamespaceTempDir(async (dir) => {
    await initializeV3Datastore(dir, "test");
    const data = await listFor({ type: "filesystem", path: dir, format: 3 });
    assertEquals(data, { namespaces: [], currentNamespace: undefined });
  });
});

Deno.test("createNamespaceListDeps: a namespaced v3 datastore lists its namespace before its first commit", async () => {
  await withNamespaceTempDir(async (dir) => {
    await initializeV3Datastore(dir, "test");
    const data = await listFor({
      type: "filesystem",
      path: dir,
      namespace: "team",
      format: 3,
    });
    assertEquals(data, {
      namespaces: [
        { namespace: "team", repoId: "", registeredAt: "", isCurrent: true },
      ],
      currentNamespace: "team",
    });
  });
});

Deno.test("createNamespaceListDeps: a v3 datastore lists the namespaces its commits name", async () => {
  await withNamespaceTempDir(async (dir) => {
    await initializeV3Datastore(dir, "test");
    const db = openCommitsDatabase(join(dir, COMMITS_DB_FILE));
    try {
      db.exec(
        "INSERT INTO partition_heads (namespace, partition, seq) " +
          "VALUES ('team', 'p', 1), ('infra', 'p', 1), ('', 'p', 1)",
      );
    } finally {
      db.close();
    }
    const data = await listFor({
      type: "filesystem",
      path: dir,
      namespace: "team",
      format: 3,
    });
    assertEquals(
      data.namespaces.map((entry) => [entry.namespace, entry.isCurrent]),
      [["infra", false], ["team", true]],
    );
  });
});

Deno.test("createNamespaceListDeps: a v2 filesystem datastore lists its namespace manifests", async () => {
  await withNamespaceTempDir(async (dir) => {
    await writeNamespaceManifest(dir, "team", "repo-1");
    const data = await listFor({
      type: "filesystem",
      path: dir,
      namespace: "team",
    });
    assertEquals(data.namespaces.length, 1);
    assertEquals(data.namespaces[0].namespace, "team");
    assertEquals(data.namespaces[0].repoId, "repo-1");
    assertEquals(data.namespaces[0].isCurrent, true);
  });
});
