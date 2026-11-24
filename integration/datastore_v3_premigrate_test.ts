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
import { DatabaseSync } from "node:sqlite";
import { V3_REPLICA_ENV } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import {
  migrateV3CopySchema,
  type V3Copy,
} from "../src/infrastructure/datastore_v3/litestream/v3_copy.ts";
import { replicationPathsFor } from "../src/infrastructure/datastore_v3/litestream/replication_files.ts";
import { setV3ReplicationForTesting } from "../src/infrastructure/datastore_v3/litestream/v3_replication.ts";
import {
  COMMIT_STORE_SCHEMA_VERSION,
  openCommitsDatabase,
  SqliteCommitStore,
} from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import {
  initializeV3Datastore,
  v3CommitsDbPath,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";

const STEP_14_TABLES = [
  "base_records",
  "base_versions",
  "base_catalog",
  "base_forwards",
  "base_files",
];

/** a commits.db as a swamp at schema 13 left it */
function writeSchema13(path: string): void {
  openCommitsDatabase(path).close();
  const db = new DatabaseSync(path);
  try {
    db.exec("DROP TABLE IF EXISTS base_removed");
    for (const table of STEP_14_TABLES) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN changed_seq`);
    }
    db.exec("PRAGMA user_version=13");
  } finally {
    db.close();
  }
}

function schemaOf(path: string): { version: number; columns: boolean } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const version = (db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    }).user_version;
    const columns = STEP_14_TABLES.every((table) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .some((column) => column.name === "changed_seq")
    );
    return { version, columns };
  } finally {
    db.close();
  }
}

async function withCopy(
  fn: (copy: V3Copy, root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.realPath(
    // short: replicationPathsFor refuses a socket path over the platform's limit
    await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-pm-" }),
  );
  try {
    const datastorePath = join(root, "ds");
    await initializeV3Datastore(datastorePath, "test");
    const repoDir = join(root, "repo");
    await Deno.mkdir(repoDir, { recursive: true });
    setV3ReplicationForTesting({ privateRoot: join(root, "priv") });
    await withMockedEnv(
      {
        [V3_REPLICA_ENV]: JSON.stringify({
          type: "file",
          path: join(root, "replica"),
        }),
      },
      async () => {
        const copy = {
          datastorePath,
          repoDir,
          commitsDb: v3CommitsDbPath(datastorePath, repoDir),
        };
        await fn(copy, root);
      },
    );
  } finally {
    setV3ReplicationForTesting(undefined);
    await Deno.remove(root, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

Deno.test({
  name:
    "migrateV3CopySchema: a copy at schema 13 is brought to this swamp's schema, and running it again changes nothing",
  // a short /tmp path and a uid, as the sibling replication tests need
  ignore: Deno.build.os === "windows",
  async fn() {
    await withCopy(async (copy) => {
      writeSchema13(copy.commitsDb);
      await migrateV3CopySchema(copy);
      assertEquals(schemaOf(copy.commitsDb), {
        version: COMMIT_STORE_SCHEMA_VERSION,
        columns: true,
      });
      await migrateV3CopySchema(copy);
      assertEquals(
        schemaOf(copy.commitsDb).version,
        COMMIT_STORE_SCHEMA_VERSION,
      );
    });
  },
});

Deno.test({
  name:
    "migrateV3CopySchema: a copy with a sidecar's presence, or one another process is restoring, is left for its open under the lease",
  // a short /tmp path and a uid, as the sibling replication tests need
  ignore: Deno.build.os === "windows",
  async fn() {
    await withCopy(async (copy, root) => {
      writeSchema13(copy.commitsDb);
      const paths = await replicationPathsFor(
        copy.commitsDb,
        join(root, "priv"),
      );
      await Deno.mkdir(paths.sharedDir, { recursive: true, mode: 0o700 });
      // a sidecar that may still be replicating this copy
      await Deno.writeTextFile(
        paths.presence,
        JSON.stringify({
          supervisorPid: 1,
          uid: Deno.uid(),
          hostname: Deno.hostname(),
          lineageFence: 1,
          replicaPath: join(root, "replica"),
        }),
      );
      await migrateV3CopySchema(copy);
      assertEquals(schemaOf(copy.commitsDb).version, 13);
      await Deno.remove(paths.presence);

      const holder = await Deno.open(paths.restoreLock, {
        read: true,
        write: true,
        create: true,
      });
      try {
        await holder.lock(true);
        await migrateV3CopySchema(copy);
        assertEquals(schemaOf(copy.commitsDb).version, 13);
      } finally {
        await holder.unlock();
        holder.close();
      }
    });
  },
});

Deno.test({
  name:
    "migrateV3CopySchema: a migrated copy then restored from a schema-13 lineage ends at this schema with the restored content",
  // a short /tmp path and a uid, as the sibling replication tests need
  ignore: Deno.build.os === "windows",
  async fn() {
    await withCopy(async (copy, root) => {
      writeSchema13(copy.commitsDb);
      await migrateV3CopySchema(copy);
      const restored = join(root, "restored.db");
      writeSchema13(restored);
      const store = SqliteCommitStore.open(copy.commitsDb, {
        replicated: true,
      });
      try {
        await store.replaceContentFrom(restored);
      } finally {
        await store.close();
      }
      assertEquals(schemaOf(copy.commitsDb), {
        version: COMMIT_STORE_SCHEMA_VERSION,
        columns: true,
      });
      // the restored file was opened, so migrated, under that open: the limit
      assertEquals(schemaOf(restored).version, COMMIT_STORE_SCHEMA_VERSION);
    });
  },
});
