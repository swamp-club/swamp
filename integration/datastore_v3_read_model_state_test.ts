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
 * The v3 read model's state store (swamp-club#3239) on a real
 * `_read_model_v3.db` in a temp directory.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { BlobRef } from "../src/domain/datastore_v3/blob_ref.ts";
import { versionOp } from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  type AppliedCommit,
  READ_MODEL_STATE_SCHEMA_VERSION,
  ReadModelState,
} from "../src/infrastructure/datastore_v3/read_model_state.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);

async function withState(
  fn: (state: ReadModelState, path: string) => void | Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-read-model-state-" });
  const path = join(dir, "_read_model_v3.db");
  const state = ReadModelState.open(path);
  try {
    await fn(state, path);
  } finally {
    state.close();
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function applied(overrides: Partial<AppliedCommit>): AppliedCommit {
  return {
    namespace: "",
    partition: "p",
    seq: 1,
    records: new Map(),
    live: new Map(),
    ...overrides,
  };
}

const MULTI = BlobRef.create({
  sha256: B,
  size: 3,
  parts: [{ sha256: C, size: 1 }, { sha256: D, size: 2 }],
});

Deno.test("ReadModelState: starts empty", async () => {
  await withState((state) => {
    assertEquals(state.cursor(), 0);
    assertEquals(state.catalogGeneration(), undefined);
    assertEquals(state.appliedSeq("", "p"), 0);
    assertEquals(state.liveRecords("", "p"), []);
    assertEquals(state.chunksInUse(""), new Set());
  });
});

Deno.test("ReadModelState: records a commit's index, versions, seq and cursor together", async () => {
  await withState((state) => {
    const metadata = versionOp("a", 1).metadata;
    state.recordApplied(applied({
      cursor: 7,
      records: new Map([
        ["data/a/1/raw", { sha256: A }],
        ["data/a/2/raw", { sha256: B, blob: MULTI }],
      ]),
      live: new Map([["a", [{ version: 1, metadata }]]]),
    }));
    assertEquals(state.cursor(), 7);
    assertEquals(state.appliedSeq("", "p"), 1);
    assertEquals(state.liveVersions("", "p", "a"), [{ version: 1, metadata }]);
    assertEquals(
      state.liveRecords("", "p").map((
        r,
      ) => [r.key.toString(), r.sha256, r.content.kind]),
      [["data/a/1/raw", A, "inline"], ["data/a/2/raw", B, "blob"]],
    );
    assertEquals(state.chunksInUse(""), new Set([C, D]));
    assertEquals(state.chunksInUse("other"), new Set());

    // A tombstone drops the record, and an empty live list drops the name.
    state.recordApplied(applied({
      seq: 2,
      cursor: 8,
      records: new Map([["data/a/2/raw", null]]),
      live: new Map([["a", []]]),
    }));
    assertEquals(state.liveRecords("", "p").map((r) => r.key.toString()), [
      "data/a/1/raw",
    ]);
    assertEquals(state.liveVersions("", "p", "a"), []);
    assertEquals(state.chunksInUse(""), new Set());
  });
});

Deno.test("ReadModelState: neither the cursor nor an applied seq moves back", async () => {
  await withState((state) => {
    state.recordApplied(applied({ seq: 2, cursor: 5 }));
    // An older commit of the partition changes nothing but a later cursor.
    state.recordApplied(applied({
      seq: 1,
      cursor: 9,
      records: new Map([["data/x", { sha256: A }]]),
    }));
    assertEquals(state.appliedSeq("", "p"), 2);
    assertEquals(state.liveRecords("", "p"), []);
    assertEquals(state.cursor(), 9);
    state.recordSkipped(3);
    assertEquals(state.cursor(), 9);
    // A partition catch-up leaves the cursor alone.
    state.recordApplied(applied({ seq: 3 }));
    assertEquals([state.appliedSeq("", "p"), state.cursor()], [3, 9]);
  });
});

Deno.test("ReadModelState: reset clears everything and records the generation", async () => {
  await withState((state, path) => {
    state.recordApplied(applied({
      cursor: 4,
      records: new Map([["data/x", { sha256: A }]]),
    }));
    state.reset(3);
    assertEquals(state.cursor(), 0);
    assertEquals(state.catalogGeneration(), 3);
    assertEquals(state.appliedSeq("", "p"), 0);
    assertEquals(state.liveRecords("", "p"), []);
    state.close();
    const reopened = ReadModelState.open(path);
    try {
      assertEquals(reopened.catalogGeneration(), 3);
    } finally {
      reopened.close();
    }
  });
});

Deno.test("ReadModelState: refuses a database from a newer schema", async () => {
  await withState((state, path) => {
    state.close();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version=${READ_MODEL_STATE_SCHEMA_VERSION + 1}`);
    db.close();
    assertThrows(() => ReadModelState.open(path), Error, "upgrade swamp");
  });
});

Deno.test("ReadModelState: records which put each file shows with its commit, and a reset clears it", async () => {
  await withState((state) => {
    assertEquals(state.fileOwnership("", "config/models/a.yaml"), undefined);
    state.recordApplied(applied({
      files: new Map([["config/models/a.yaml", {
        owner: "p",
        mark: 7,
        present: true,
      }]]),
    }));
    assertEquals(state.fileOwnership("", "config/models/a.yaml"), {
      owner: "p",
      mark: 7,
      present: true,
    });
    // Namespaces are separate, and a commit at or below the applied seq
    // changes nothing.
    assertEquals(
      state.fileOwnership("team", "config/models/a.yaml"),
      undefined,
    );
    state.recordApplied(applied({
      files: new Map([["config/models/a.yaml", {
        owner: "q",
        mark: 9,
        present: false,
      }]]),
    }));
    assertEquals(state.fileOwnership("", "config/models/a.yaml")?.owner, "p");
    state.reset(1);
    assertEquals(state.fileOwnership("", "config/models/a.yaml"), undefined);
  });
});

Deno.test("ReadModelState: a schema-1 database migrates and forgets its catalog generation, so the read model replays (swamp-club#3256)", async () => {
  await withState((state, path) => {
    state.reset(3);
    state.recordApplied(applied({ cursor: 4 }));
    state.close();
    // Roll the file back to schema 1: files applied under it have no
    // ownership rows.
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE materialised_keys; PRAGMA user_version=1");
    db.close();

    const reopened = ReadModelState.open(path);
    try {
      // No catalog generation makes the read model reset and replay every
      // commit, which rebuilds the ownership of every file.
      assertEquals(reopened.catalogGeneration(), undefined);
      assertEquals(reopened.cursor(), 0);
      assertEquals(reopened.appliedSeq("", "p"), 1);
      assertEquals(
        reopened.fileOwnership("", "config/models/a.yaml"),
        undefined,
      );
    } finally {
      reopened.close();
    }
    const db2 = new DatabaseSync(path);
    try {
      assertEquals(
        (db2.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
        READ_MODEL_STATE_SCHEMA_VERSION,
      );
    } finally {
      db2.close();
    }
  });
});

Deno.test("ReadModelState: every call after close throws", async () => {
  await withState((state) => {
    state.close();
    state.close();
    assertThrows(() => state.cursor(), Error, "closed");
    assertThrows(() => state.recordSkipped(1), Error, "closed");
  });
});

Deno.test("ReadModelState: reads the index only while it is complete", async () => {
  await withState((state) => {
    state.recordApplied(applied({
      cursor: 1,
      records: new Map([["data/a/2/raw", { sha256: B, blob: MULTI }]]),
    }));
    assertEquals(state.liveRecordsIfComplete("", "p"), undefined);
    assertEquals(state.chunksInUseIfComplete(""), undefined);
    state.markComplete();
    assertEquals(
      state.liveRecordsIfComplete("", "p")?.map((r) => r.key.toString()),
      ["data/a/2/raw"],
    );
    assertEquals(state.chunksInUseIfComplete(""), new Set([C, D]));
    // A reset clears the complete mark with the index.
    state.reset(1);
    assertEquals(state.isComplete(), false);
    assertEquals(state.chunksInUseIfComplete(""), undefined);
  });
});

Deno.test("ReadModelState: forgetUnsynced forgets only the keys given, and the boot once none are left (swamp-club#3416)", async () => {
  await withState((state) => {
    state.recordApplied(applied({
      unsynced: {
        keys: new Set(["data/a", "data/b", "data/c"]),
        boot: "boot-1",
      },
    }));
    assertEquals(state.unsyncedKeys(2).map((k) => k.record_key), [
      "data/a",
      "data/b",
    ]);
    state.forgetUnsynced(state.unsyncedKeys(2));
    assertEquals(state.unsyncedKeys(10).map((k) => k.record_key), ["data/c"]);
    assertEquals(state.unsyncedBoot(), "boot-1", "kept while files are listed");
    state.forgetUnsynced(state.unsyncedKeys(10));
    assertEquals(state.unsyncedKeys(10), []);
    assertEquals(state.unsyncedBoot(), undefined);
  });
});
