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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { UserError } from "../../domain/errors.ts";
import {
  SERVE_UPSTREAM_STATE_SCHEMA_NEWER_CODE,
  SERVE_UPSTREAM_STATE_SCHEMA_VERSION,
  ServeUpstreamState,
} from "./serve_upstream_state.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void> | void,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-serve-state-" });
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

Deno.test("ServeUpstreamState: starts at cursor 0 with no serve heads", async () => {
  await withTempDir((dir) => {
    const state = ServeUpstreamState.open(join(dir, "serve_upstream.db"));
    try {
      assertEquals(state.feedCursor(), 0);
      assertEquals(state.serveHead("", "model/a"), 0);
    } finally {
      state.close();
    }
  });
});

Deno.test("ServeUpstreamState: the feed cursor and serve heads never move back", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "serve_upstream.db");
    const state = ServeUpstreamState.open(path);
    try {
      state.advanceFeedCursor(7);
      state.advanceFeedCursor(3);
      state.recordServeHead("", "model/a", 5);
      state.recordServeHead("", "model/a", 2);
      state.recordServeHead("ns", "model/a", 9);
      assertEquals(state.feedCursor(), 7);
      assertEquals(state.serveHead("", "model/a"), 5);
      assertEquals(state.serveHead("ns", "model/a"), 9);
    } finally {
      state.close();
    }
    const reopened = ServeUpstreamState.open(path);
    try {
      assertEquals(reopened.feedCursor(), 7);
      assertEquals(reopened.serveHead("", "model/a"), 5);
    } finally {
      reopened.close();
    }
  });
});

Deno.test("ServeUpstreamState: refuses a negative or fractional value", async () => {
  await withTempDir((dir) => {
    const state = ServeUpstreamState.open(join(dir, "serve_upstream.db"));
    try {
      assertThrows(() => state.advanceFeedCursor(-1));
      assertThrows(() => state.recordServeHead("", "model/a", 1.5));
    } finally {
      state.close();
    }
  });
});

Deno.test("ServeUpstreamState: refuses a file from a newer schema", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "serve_upstream.db");
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version=${SERVE_UPSTREAM_STATE_SCHEMA_VERSION + 1}`);
    db.close();
    const error = assertThrows(
      () => ServeUpstreamState.open(path),
      UserError,
    );
    assertEquals(error.code, SERVE_UPSTREAM_STATE_SCHEMA_NEWER_CODE);
  });
});

Deno.test("ServeUpstreamState: the first caller stamp wins, and a reset forgets the old caller's view until it finishes", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "serve_upstream.db");
    const state = ServeUpstreamState.open(path);
    try {
      assertEquals(state.caller(), undefined);
      assertEquals(state.stampCaller("aaa"), {
        fingerprint: "aaa",
        resetting: false,
      });
      // A second stamp never replaces the first.
      assertEquals(state.stampCaller("bbb"), {
        fingerprint: "aaa",
        resetting: false,
      });
      state.advanceFeedCursor(7);
      state.recordServeHead("", "model/a", 5);

      state.beginCallerReset();
      assertEquals(state.caller(), { fingerprint: "aaa", resetting: true });
      assertEquals(state.feedCursor(), 0);
      assertEquals(state.serveHead("", "model/a"), 0);
    } finally {
      state.close();
    }
    // A reset cut short is still marked after a reopen.
    const reopened = ServeUpstreamState.open(path);
    try {
      assertEquals(reopened.stampCaller("bbb"), {
        fingerprint: "aaa",
        resetting: true,
      });
      reopened.finishCallerReset("bbb");
      assertEquals(reopened.caller(), { fingerprint: "bbb", resetting: false });
    } finally {
      reopened.close();
    }
  });
});

Deno.test("ServeUpstreamState.hasReadFeed: false until a page is applied, even an empty one at cursor 0", async () => {
  await withTempDir((dir) => {
    const state = ServeUpstreamState.open(join(dir, "serve_upstream.db"));
    try {
      assertEquals(state.hasReadFeed(), false);
      state.advanceFeedCursor(0);
      assertEquals(state.hasReadFeed(), true);
      assertEquals(state.feedCursor(), 0);
    } finally {
      state.close();
    }
  });
});

const ANCHOR_A = {
  namespace: "",
  partition: "model/a",
  seq: 3,
  txnId: "txn-a3",
};
const ANCHOR_B = {
  namespace: "",
  partition: "model/b",
  seq: 1,
  txnId: "txn-b1",
};

Deno.test("ServeUpstreamState.feedAnchor: recorded with the cursor, kept by a page without commits, never moved back", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "serve_upstream.db");
    const state = ServeUpstreamState.open(path);
    try {
      assertEquals(state.feedAnchor(), undefined);
      state.advanceFeedCursor(4, ANCHOR_A);
      assertEquals(state.feedAnchor(), ANCHOR_A);
      // A page that carried no commit moves the cursor and keeps the anchor.
      state.advanceFeedCursor(6);
      assertEquals(state.feedCursor(), 6);
      assertEquals(state.feedAnchor(), ANCHOR_A);
      // Another process that applied an older page lands neither.
      state.advanceFeedCursor(5, ANCHOR_B);
      assertEquals(state.feedCursor(), 6);
      assertEquals(state.feedAnchor(), ANCHOR_A);
      state.advanceFeedCursor(8, ANCHOR_B);
      assertEquals(state.feedAnchor(), ANCHOR_B);
    } finally {
      state.close();
    }
    const reopened = ServeUpstreamState.open(path);
    try {
      assertEquals(reopened.feedCursor(), 8);
      assertEquals(reopened.feedAnchor(), ANCHOR_B);
    } finally {
      reopened.close();
    }
  });
});

Deno.test("ServeUpstreamState.feedAnchor: a caller reset forgets it and the log id with the cursor", async () => {
  await withTempDir((dir) => {
    const state = ServeUpstreamState.open(join(dir, "serve_upstream.db"));
    try {
      state.stampCaller("aaa");
      state.advanceFeedCursor(4, ANCHOR_A);
      state.recordServeLogId("log-a");
      state.beginCallerReset();
      assertEquals(state.feedAnchor(), undefined);
      assertEquals(
        state.serveLogId(),
        undefined,
        "the reset copy follows none",
      );
      assertEquals(state.feedCursor(), 0);
    } finally {
      state.close();
    }
  });
});

Deno.test("ServeUpstreamState: a file at schema version 1 keeps its cursor and has no anchor", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "serve_upstream.db");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE feed (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       cursor INTEGER NOT NULL
     );
     CREATE TABLE serve_heads (
       namespace TEXT NOT NULL,
       partition TEXT NOT NULL,
       seq INTEGER NOT NULL,
       PRIMARY KEY (namespace, partition)
     );
     CREATE TABLE caller (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       fingerprint TEXT NOT NULL,
       resetting INTEGER NOT NULL DEFAULT 0
     );
     INSERT INTO feed (id, cursor) VALUES (1, 7);
     PRAGMA user_version=1;`);
    db.close();
    const state = ServeUpstreamState.open(path);
    try {
      assertEquals(state.feedCursor(), 7);
      assertEquals(state.feedAnchor(), undefined);
      assertEquals(state.copyId().length, 32, "the upgrade gave it an id");
      state.advanceFeedCursor(9, ANCHOR_A);
      assertEquals(state.feedAnchor(), ANCHOR_A);
    } finally {
      state.close();
    }
  });
});

Deno.test("ServeUpstreamState.copyId: random per file, kept across a reopen", async () => {
  await withTempDir((dir) => {
    const copyDir = join(dir, "serve-1");
    const path = join(copyDir, "serve_upstream.db");
    const state = ServeUpstreamState.open(path);
    let id: string;
    try {
      id = state.copyId();
      assertEquals(/^[0-9a-f]{32}$/.test(id), true, id);
    } finally {
      state.close();
    }
    const reopened = ServeUpstreamState.open(path);
    try {
      assertEquals(reopened.copyId(), id);
    } finally {
      reopened.close();
    }
    // A copy moved aside and started afresh at the same path has another.
    Deno.renameSync(copyDir, join(dir, "serve-1.moved"));
    const fresh = ServeUpstreamState.open(path);
    try {
      assert(fresh.copyId() !== id);
    } finally {
      fresh.close();
    }
  });
});

Deno.test("ServeUpstreamState.recordServeLogId: the first log recorded stays", async () => {
  await withTempDir((dir) => {
    const state = ServeUpstreamState.open(join(dir, "serve_upstream.db"));
    try {
      assertEquals(state.serveLogId(), undefined);
      assertEquals(state.recordServeLogId("log-a"), "log-a");
      assertEquals(state.recordServeLogId("log-b"), "log-a");
      assertEquals(state.serveLogId(), "log-a");
    } finally {
      state.close();
    }
  });
});
