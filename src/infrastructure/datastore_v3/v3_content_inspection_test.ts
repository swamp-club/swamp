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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, relative } from "@std/path";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { unreadableRecordAdvice } from "../../domain/datastore_v3/read_model.ts";
import { FileSystemStorage } from "../persistence/fs_datastore_storage.ts";
import { ReadModelState } from "./read_model_state.ts";
import { readModelStateDir } from "./record_path_guard.ts";
import { AT_RISK_DIR, READ_MODEL_STATE_FILE } from "./sqlite_read_model.ts";
import {
  inspectV3Content,
  inspectV3ReplicaRestorable,
  V3_CONTENT_LISTED,
} from "./v3_content_inspection.ts";
import { withMockedEnv } from "../persistence/path_test_helpers.ts";
import { V3_REPLICA_ENV } from "./litestream/replica_setting.ts";
import {
  ensureSharedDir,
  replicationPathsFor,
  writeLineage,
  writeReplicaVerification,
} from "./litestream/replication_files.ts";
import { v3PrivateRoot } from "./litestream/v3_replication.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";
import { v3CommitsDbPath } from "./v3_datastore.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-content-" });
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

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const signal = () => AbortSignal.timeout(30_000);

function filesystem(path: string): DatastoreConfig {
  return { type: "filesystem", path };
}

/** Every file under `dir` with its size and mtime, by relative path. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (at: string) => {
    for await (const entry of Deno.readDir(at)) {
      const path = join(at, entry.name);
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      const info = await Deno.stat(path);
      files[relative(dir, path)] = `${info.size} ${info.mtime?.getTime()}`;
    }
  };
  await walk(dir);
  return files;
}

/** Creates the checkout's read model state at the current schema. */
function createState(repoDir: string): DatabaseSync {
  const stateDir = readModelStateDir(repoDir);
  Deno.mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, READ_MODEL_STATE_FILE);
  ReadModelState.open(path).close();
  return new DatabaseSync(path);
}

function liveBlob(
  db: DatabaseSync,
  namespace: string,
  recordKey: string,
  blob: unknown,
): void {
  db.prepare(
    "INSERT INTO live_records (namespace, partition, record_key, sha256, blob) VALUES (?, 'p', ?, ?, ?)",
  ).run(namespace, recordKey, "0".repeat(64), JSON.stringify(blob));
}

Deno.test("inspectV3Content: a checkout with no read model state, or state from before the v3 content tables, reports nothing (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir);
    const config = filesystem(join(dir, "datastore"));
    const none = await inspectV3Content({ repoDir, datastoreConfig: config });
    assertEquals(
      [none.unreadableRecords, none.atRiskCopies, none.tornChunks],
      [0, 0, 0],
    );
    assertEquals(
      await Deno.stat(readModelStateDir(repoDir)).then(() => true, () => false),
      false,
      "nothing is created",
    );

    // An older schema: none of the tables this check reads.
    const stateDir = readModelStateDir(repoDir);
    await Deno.mkdir(stateDir, { recursive: true });
    const db = new DatabaseSync(join(stateDir, READ_MODEL_STATE_FILE));
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER)");
    db.close();
    const old = await inspectV3Content({ repoDir, datastoreConfig: config });
    assertEquals(
      [old.unreadableRecords, old.atRiskCopies, old.tornChunks],
      [0, 0, 0],
    );
  });
});

Deno.test("inspectV3Content: reports unreadable records, at-risk copies and torn chunks, with advice, stat-ing chunks only (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const datastorePath = join(dir, "datastore");
    await Deno.mkdir(repoDir);
    await Deno.mkdir(datastorePath);
    const storage = new FileSystemStorage(datastorePath);
    const put = async (namespace: string, text: string) => {
      const bytes = new TextEncoder().encode(text);
      const sha256 = sha256Hex(bytes);
      await storage.put(namespace, sha256, bytes, signal());
      return { sha256, size: bytes.length };
    };
    const good = await put("_default", "good content");
    const torn = await put("_default", "torn by a power cut");
    const tornPart = await put("acme", "second part, torn");
    const firstPart = await put("acme", "first part");
    // A crash left two chunks short.
    for (
      const [ns, sha256] of [["_default", torn.sha256], [
        "acme",
        tornPart.sha256,
      ]]
    ) {
      await Deno.truncate(
        join(datastorePath, "_blobs", ns, "sha256", sha256.slice(0, 2), sha256),
        3,
      );
    }

    const db = createState(repoDir);
    try {
      liveBlob(db, "", "data/m/good/1/raw", good);
      liveBlob(db, "", "data/m/torn/1/raw", torn);
      // Absent: a lagging checkout may name a chunk compaction released.
      liveBlob(db, "", "data/m/absent/1/raw", {
        sha256: "f".repeat(64),
        size: 10,
      });
      liveBlob(db, "", "data/m/legacy/1/raw", {
        sha256: "e".repeat(64),
        size: 3,
        legacyKey: "data/m/legacy/1/raw",
      });
      liveBlob(db, "acme", "workflow-runs/w/run.yaml", {
        sha256: "d".repeat(64),
        size: firstPart.size + tornPart.size,
        parts: [firstPart, tornPart],
      });
      const unreadable = db.prepare(
        "INSERT INTO unreadable_records (namespace, record_key, partition, seq, position, blob, chunk, chunk_size, chunk_mtime, reason, last_attempt) VALUES (?, ?, 'p', 1, 1, NULL, ?, NULL, NULL, ?, 0)",
      );
      for (let i = 0; i < V3_CONTENT_LISTED + 2; i++) {
        unreadable.run(
          "",
          `data/m/lost-${String(i).padStart(2, "0")}/1/raw`,
          "a".repeat(64),
          i === 0 ? "damaged" : "missing",
        );
      }
      db.prepare(
        "INSERT INTO at_risk_copies (namespace, sha256, record_key, blob, size, created_at, last_attempt) VALUES ('acme', ?, 'outputs/m/out.yaml', NULL, 42, 1, 1)",
      ).run("b".repeat(64));
    } finally {
      db.close();
    }

    const before = await snapshot(datastorePath);
    const found = await inspectV3Content({
      repoDir,
      datastoreConfig: filesystem(datastorePath),
    });
    assertEquals(await snapshot(datastorePath), before, "nothing opened");

    assertEquals(found.unreadableRecords, V3_CONTENT_LISTED + 2);
    assertEquals(found.unreadable.length, V3_CONTENT_LISTED);
    assertEquals(found.unreadable[0], {
      namespace: "",
      recordKey: "data/m/lost-00/1/raw",
      reason: "damaged",
      chunk: "a".repeat(64),
      advice: unreadableRecordAdvice("data/m/lost-00/1/raw"),
    });
    assertEquals(found.atRiskCopies, 1);
    assertEquals(found.atRisk, [{
      namespace: "acme",
      sha256: "b".repeat(64),
      recordKey: "outputs/m/out.yaml",
      size: 42,
    }]);
    const atRiskDir = join(readModelStateDir(repoDir), AT_RISK_DIR);
    assertEquals(found.atRiskDir, atRiskDir);
    assertStringIncludes(found.atRiskAdvice, `delete ${atRiskDir}`);
    assertStringIncludes(found.atRiskAdvice, "writes");
    assertEquals(found.tornChunks, 2);
    assertEquals(
      found.torn.map((c) => [c.namespace, c.sha256, c.recordKey, c.size]),
      [
        ["", torn.sha256, "data/m/torn/1/raw", 3],
        ["acme", tornPart.sha256, "workflow-runs/w/run.yaml", 3],
      ],
    );
    assertEquals(found.torn[0].expectedSize, torn.size);

    // A bucket's chunks cannot tear, and are not stat'ed.
    const bucket = await inspectV3Content({
      repoDir,
      datastoreConfig: {
        type: "@acme/s3",
        config: {},
      } as unknown as DatastoreConfig,
    });
    assertEquals(bucket.tornChunks, 0);
    assertEquals(bucket.unreadableRecords, V3_CONTENT_LISTED + 2);
  });
});

Deno.test("inspectV3Content: a torn chunk of a record this checkout could not materialise gets that record's advice, not the held-file advice (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const datastorePath = join(dir, "datastore");
    await Deno.mkdir(repoDir);
    await Deno.mkdir(datastorePath);
    const storage = new FileSystemStorage(datastorePath);
    const put = async (text: string) => {
      const bytes = new TextEncoder().encode(text);
      const sha256 = sha256Hex(bytes);
      await storage.put("_default", sha256, bytes, signal());
      await Deno.truncate(
        join(
          datastorePath,
          "_blobs",
          "_default",
          "sha256",
          sha256.slice(0, 2),
          sha256,
        ),
        3,
      );
      return { sha256, size: bytes.length };
    };
    const held = await put("held in this checkout");
    const lost = await put("never materialised here");

    const db = createState(repoDir);
    try {
      liveBlob(db, "", "data/m/held/1/raw", held);
      liveBlob(db, "", "data/m/lost/1/raw", lost);
      db.prepare(
        "INSERT INTO unreadable_records (namespace, record_key, partition, seq, position, blob, chunk, chunk_size, chunk_mtime, reason, last_attempt) VALUES ('', 'data/m/lost/1/raw', 'p', 1, 1, NULL, ?, NULL, NULL, 'damaged', 0)",
      ).run(lost.sha256);
    } finally {
      db.close();
    }

    const found = await inspectV3Content({
      repoDir,
      datastoreConfig: filesystem(datastorePath),
    });
    const advice = new Map(found.torn.map((c) => [c.recordKey, c.advice]));
    assertStringIncludes(
      advice.get("data/m/held/1/raw") ?? "",
      "This checkout's file still holds the content",
    );
    assertEquals(
      advice.get("data/m/lost/1/raw"),
      unreadableRecordAdvice("data/m/lost/1/raw"),
    );
  });
});

Deno.test({
  name:
    "inspectV3ReplicaRestorable: maps the copy's lineage and last verdict to a status, and quick-checks the copy only when broken (swamp-club#3935)",
  // Replication needs a Unix user id.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const root = await Deno.realPath(dir);
      const datastorePath = join(root, "ds");
      const repoDir = join(root, "repo");
      await Deno.mkdir(datastorePath);
      await Deno.mkdir(repoDir);
      const config = filesystem(datastorePath);
      const inspect = () =>
        inspectV3ReplicaRestorable({ repoDir, datastoreConfig: config });
      // Not replicating: no finding.
      await withMockedEnv({ [V3_REPLICA_ENV]: undefined }, async () => {
        assertEquals(await inspect(), undefined);
      });
      await withMockedEnv(
        {
          [V3_REPLICA_ENV]: JSON.stringify({
            type: "file",
            path: join(root, "replica"),
          }),
        },
        async () => {
          const commitsDb = v3CommitsDbPath(datastorePath, repoDir);
          await Deno.mkdir(dirname(commitsDb), { recursive: true });
          // Never replicated: no lineage yet.
          assertEquals(await inspect(), { status: "unverified" });
          const store = SqliteCommitStore.open(commitsDb);
          await store.close();
          const paths = await replicationPathsFor(commitsDb, v3PrivateRoot());
          await ensureSharedDir(paths);
          await writeLineage(paths, {
            replicaRoot: `file:${join(root, "replica")}`,
            lineageFence: 4,
            lastFence: 5,
            previousLineages: [],
          });
          assertEquals(await inspect(), {
            status: "unverified",
            lineageFence: 4,
          });
          const verdict = {
            lineageFence: 4,
            txid: "0000000000000009",
            checkedAt: "2026-10-25T12:00:00.000Z",
            ok: true,
          };
          // A verdict on another lineage says nothing about this one.
          await writeReplicaVerification(paths, {
            ...verdict,
            lineageFence: 3,
          });
          assertEquals(await inspect(), {
            status: "unverified",
            lineageFence: 4,
          });
          await writeReplicaVerification(paths, verdict);
          assertEquals(await inspect(), {
            status: "verified",
            lineageFence: 4,
            txid: verdict.txid,
            checkedAt: verdict.checkedAt,
          });
          const broken = { ...verdict, ok: false, error: "integrity check" };
          await writeReplicaVerification(paths, broken);
          assertEquals(await inspect(), {
            status: "broken",
            lineageFence: 4,
            txid: verdict.txid,
            checkedAt: verdict.checkedAt,
            error: "integrity check",
            copyCheck: "ok",
          });
          await Deno.writeFile(
            commitsDb,
            new TextEncoder().encode("not sqlite"),
          );
          const damaged = await inspect();
          assertEquals(damaged?.status, "broken-copy-damaged");
          assertStringIncludes(damaged!.copyCheck!, "not a database");
        },
      );
    });
  },
});
