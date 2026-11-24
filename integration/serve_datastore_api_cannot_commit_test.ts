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

import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "@std/path";
import { setV3DatastoreFaultsForTesting } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { onV3CommitOutcome } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import type { OutboxCommitSink } from "../src/infrastructure/datastore_v3/outbox_commit_sink.ts";
import {
  LeaderCommitHealth,
  wireLeaderCommitHealth,
} from "../src/serve/leader_commit_health.ts";
import {
  getJson,
  partitionPath,
  save,
  type Server,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

/** what node:sqlite throws when the database cannot grow */
function sqliteFull(): Error {
  const dir = Deno.makeTempDirSync();
  const db = new DatabaseSync(join(dir, "full.db"));
  try {
    db.exec("PRAGMA page_size=4096; CREATE TABLE t(v BLOB);");
    db.exec("PRAGMA max_page_count=4");
    const insert = db.prepare("INSERT INTO t VALUES (?)");
    for (let i = 0; i < 100; i++) insert.run(new Uint8Array(4000));
  } catch (error) {
    return error as Error;
  } finally {
    db.close();
    Deno.removeSync(dir, { recursive: true });
  }
  throw new Error("the capped database never filled");
}

const disk = { full: false };

function fullWhenAsked(sink: OutboxCommitSink): OutboxCommitSink {
  return new Proxy(sink, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "beginBatch") {
        return (...args: unknown[]) =>
          disk.full ? Promise.resolve(undefined) : value.apply(target, args);
      }
      if (property !== "append") return value.bind(target);
      return (...args: unknown[]) =>
        disk.full ? Promise.reject(sqliteFull()) : value.apply(target, args);
    },
  });
}

interface Leading {
  readonly health: LeaderCommitHealth;
  readonly steps: string[];
  readonly wired: ReturnType<typeof wireLeaderCommitHealth>;
}

/** as serve wires its leader, with a window short enough to cross in a test */
function lead(server: Server): Leading {
  const health = new LeaderCommitHealth({ windowMs: 0 });
  const steps: string[] = [];
  const wired = wireLeaderCommitHealth({
    datastorePath: resolve(server.v3.datastorePath),
    leads: () => true,
    onCommitOutcome: onV3CommitOutcome,
    stopRenewal: () => {
      steps.push("stop-renewal");
      return Promise.resolve();
    },
    stepDown: () => {
      steps.push("step-down");
      return Promise.resolve();
    },
    health,
  });
  server.ctx.followerGate = {
    role: "leader",
    leader: () => undefined,
    isStale: () => false,
    leadUnconfirmed: () => false,
  };
  server.ctx.commitHealth = wired.port;
  return { health, steps, wired };
}

async function withFullDisk(fn: (server: Server) => Promise<void>) {
  disk.full = false;
  setV3DatastoreFaultsForTesting({ wrapSink: fullWhenAsked });
  try {
    await withServer(writer(), fn);
  } finally {
    setV3DatastoreFaultsForTesting(undefined);
    disk.full = false;
  }
}

Deno.test({
  name:
    "leader commit health: forwarded commits failing on a full disk trip the leader, which then refuses writes as not the leader and still answers reads",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withFullDisk(async (server) => {
      const leading = lead(server);
      try {
        const landed = await save(server, "alice-token", 1, 0);
        assertEquals(landed.status, 200, JSON.stringify(landed.json));
        disk.full = true;
        for (let attempt = 1; attempt <= 3; attempt++) {
          const failed = await save(server, "alice-token", 2, 1);
          assertEquals(failed.status, 500, JSON.stringify(failed.json));
          assertEquals(
            leading.health.cannotCommit() !== undefined,
            attempt === 3,
            `after failure ${attempt}`,
          );
        }
        await leading.wired.steppedDown();
        assertEquals(leading.steps, ["stop-renewal", "step-down"]);
        assertEquals(leading.health.cannotCommit()?.cause, "storage_full");

        // refused before the store is asked, even once it has room again
        disk.full = false;
        const refused = await save(server, "alice-token", 2, 1);
        assertEquals(refused.status, 503, JSON.stringify(refused.json));
        assertEquals(refused.json.code, "serve_not_leader");
        assertEquals(refused.json.leader, undefined);
        const read = await getJson(
          `${partitionPath(server)}?after=0`,
          "alice-token",
        );
        assertEquals(read.status, 200, JSON.stringify(read.json));
        const head = await server.v3.commitStore.head(
          server.v3.namespace,
          (await server.v3.commitStore.changesSince(0, 10))[0].commit.partition,
        );
        assertEquals(head.seq, 1, "nothing after the failures landed");
      } finally {
        leading.wired.stop();
      }
    });
  },
});

Deno.test({
  name:
    "leader commit health: a commit that lands between failures starts the run again",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withFullDisk(async (server) => {
      const leading = lead(server);
      try {
        disk.full = true;
        assertEquals((await save(server, "alice-token", 1, 0)).status, 500);
        assertEquals((await save(server, "alice-token", 1, 0)).status, 500);
        disk.full = false;
        assertEquals((await save(server, "alice-token", 1, 0)).status, 200);
        disk.full = true;
        assertEquals((await save(server, "alice-token", 2, 1)).status, 500);
        assertEquals((await save(server, "alice-token", 2, 1)).status, 500);
        assertEquals(leading.health.cannotCommit(), undefined);
        assertEquals(leading.steps, []);
      } finally {
        leading.wired.stop();
      }
    });
  },
});

Deno.test({
  name:
    "leader commit health: a failure the datastore and the request both report counts once",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withFullDisk(async (server) => {
      const leading = lead(server);
      try {
        disk.full = true;
        assertEquals((await save(server, "alice-token", 1, 0)).status, 500);
        assertEquals((await save(server, "alice-token", 1, 0)).status, 500);
        assert(
          leading.health.cannotCommit() === undefined,
          "two failed requests are two failures, not four",
        );
        assertEquals((await save(server, "alice-token", 1, 0)).status, 500);
        assert(leading.health.cannotCommit() !== undefined);
      } finally {
        leading.wired.stop();
      }
    });
  },
});
