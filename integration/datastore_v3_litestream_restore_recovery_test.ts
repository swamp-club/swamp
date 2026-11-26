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

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ignore,
  MachineError,
  read,
  STALL_MS,
  withMachines,
} from "./datastore_v3_litestream_restore_helpers.ts";

Deno.test({
  name:
    "v3 restore: a reader restored behind another machine's lease replays through its read model, logs no outside reset and leaves its catalog current (swamp-club#4387)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a", { captureWarnings: true });
      await a.send({ kind: "write", commits: 2, close: true });
      await a.send({ kind: "lease", ttlMs: 1_500 });
      await a.send({ kind: "write", commits: 1, close: false });
      await a.send({ kind: "catchUp" });
      const paused = a.send({ kind: "pause", ms: STALL_MS });
      const b = await world.machine("b");
      await b.send({ kind: "write", commits: 1, close: true });
      await paused;
      await assertRejects(() => a.send({ kind: "close" }));
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 3);
      const acknowledged = await c.send({ kind: "files" }) as string[];
      await a.send({ kind: "warnings" });
      // the takeover holds the writer lease, so the zombie's restore cannot
      // recover under it and replays as a reader
      await b.send({ kind: "lease", ttlMs: 60_000 });
      assertEquals((await read(a)).commits, 3);
      const files = await a.send({ kind: "files" }) as string[];
      for (const file of acknowledged) {
        assert(files.includes(file), `${file} is applied after the restore`);
      }
      assertEquals(files.length, 4, "the reader leaves the zombie's file");
      assertEquals(await a.send({ kind: "readModel" }), {
        cursor: 3,
        populated: true,
      });
      const warnings = await a.send({ kind: "warnings" }) as string[];
      assertEquals(
        warnings.filter((w) => w.includes("outside the read model")),
        [],
      );
    });
  },
});

Deno.test({
  name:
    "v3 restore: a serve write confirmed before it answers survives a crash and a takeover (swamp-club#3489)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      await a.send({ kind: "lease", ttlMs: 1_500 });
      await a.send({ kind: "write", commits: 1, close: false });
      await a.send({ kind: "confirm" });
      await a.crash();
      const b = await world.machine("b");
      await b.send({ kind: "write", commits: 1, close: true });
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 4, "the acknowledged commit kept");
    });
  },
});

Deno.test({
  name:
    "v3 restore: a seeding writer that fails before confirming leaves the shared commits for the next checkout's writer (swamp-club#3491)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const before = await world.machine("before", { replica: "" });
      await before.send({ kind: "write", commits: 3, close: true });
      // The first writer seeds its copy and claims its lineage, then dies
      // before its first sync is confirmed. Its short lease then expires.
      const first = await world.machine("first", { checkout: "before" });
      await first.send({ kind: "lease", ttlMs: 1_500 });
      await first.send({ kind: "write", commits: 1, close: false });
      await first.crash();
      const claimed = await world.lineages();
      assert(claimed.newestStarted !== undefined, "first claimed a lineage");
      assertEquals(claimed.current, undefined);
      const other = await world.machine("other");
      await other.send({ kind: "write", commits: 1, close: true });
      const fresh = await world.machine("fresh");
      assertEquals((await read(fresh)).commits, 4);
    });
  },
});

Deno.test({
  name:
    "v3 restore: a follower that appended its new leader's commits above its own unconfirmed one rebuilds its read model when restored, instead of failing on a missing seq at every refresh",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const definition = crypto.randomUUID();
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      await a.send({ kind: "lease", ttlMs: 1_500 });
      // a's own commit, never confirmed: b takes over without it
      await a.send({ kind: "write", commits: 1, close: false });
      await a.send({ kind: "catchUp" });
      const own = await a.send({ kind: "highWater" }) as number;
      const paused = a.send({ kind: "pause", ms: STALL_MS });
      const b = await world.machine("b");
      await b.send({ kind: "write", commits: 1, close: true, definition });
      await b.send({ kind: "write", commits: 1, close: true });
      await b.send({ kind: "write", commits: 1, close: true, definition });
      await paused;
      const leader = await b.send({ kind: "changes", since: own - 1 }) as {
        cursor: number;
        commit: unknown;
      }[];
      assertEquals(
        leader.map((change) => change.cursor),
        [own, own + 1, own + 2],
        "b's first commit sits at the cursor of a's dropped one",
      );
      // a's feed starts at its own high-water: b's commit at `own` is skipped
      await a.send({ kind: "follow", changes: [leader[1]] });
      await assertRejects(
        () => a.send({ kind: "follow", changes: [leader[2]] }),
        MachineError,
        "the leader's commit at cursor",
      );
      // a's lead ended with its process: a follower starts on its checkout
      await a.stopSidecars();
      await a.crash();
      const follower = await world.machine("a2", { checkout: "a" });
      // a second refresh restores nothing: a read model left behind fails again
      assertEquals(await follower.send({ kind: "refresh" }), own + 2);
      assertEquals(await follower.send({ kind: "refresh" }), own + 2);
      const files = await follower.send({ kind: "files" }) as string[];
      assert(
        files.includes(`${definition}.yaml`),
        "the definition b wrote is applied after the restore",
      );
    });
  },
});

Deno.test({
  name:
    "v3 restore: a leader that restarts as a follower holding a commit it never confirmed restores it away at boot, and a second refresh restores nothing (swamp-club#5145)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      // long enough that the crashed holder's lease is still busy at boot
      await a.send({ kind: "lease", ttlMs: 60_000 });
      await a.send({ kind: "write", commits: 1, close: false });
      const own = await a.send({ kind: "highWater" }) as number;
      await a.stopSidecars();
      await a.crash();
      const follower = await world.machine("a2", { checkout: "a" });
      assertEquals(await follower.send({ kind: "followHold" }), "follower");
      assertEquals(
        await follower.send({ kind: "feedCursor" }),
        own - 1,
        "the feed starts at the head's acknowledged mark, not the own commit",
      );
      const restored = await follower.send({ kind: "copyStateInode" });
      await follower.send({ kind: "refresh" });
      assertEquals(
        await follower.send({ kind: "copyStateInode" }),
        restored,
        "a copy just restored is current",
      );
      assertEquals(await follower.send({ kind: "feedCursor" }), own - 1);
    });
  },
});

Deno.test({
  name:
    "v3 restore: a follower refreshed after its own unconfirmed commit takes its new leader's commit at that cursor instead of diverging (swamp-club#5145)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const definition = crypto.randomUUID();
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      await a.send({ kind: "lease", ttlMs: 1_500 });
      await a.send({ kind: "write", commits: 1, close: false });
      const own = await a.send({ kind: "highWater" }) as number;
      await a.stopSidecars();
      await a.crash();
      const follower = await world.machine("a2", { checkout: "a" });
      await follower.send({ kind: "refresh" });
      assertEquals(await follower.send({ kind: "feedCursor" }), own - 1);
      const b = await world.machine("b");
      await b.send({ kind: "write", commits: 1, close: true, definition });
      await b.send({ kind: "write", commits: 1, close: true });
      const leader = await b.send({ kind: "changes", since: own - 1 }) as {
        cursor: number;
        commit: unknown;
      }[];
      assertEquals(leader.map((change) => change.cursor), [own, own + 1]);
      await follower.send({ kind: "follow", changes: leader });
      assertEquals(await follower.send({ kind: "feedCursor" }), own + 1);
      const files = await follower.send({ kind: "files" }) as string[];
      assert(
        files.includes(`${definition}.yaml`),
        "the definition b wrote at the dropped commit's cursor is applied",
      );
    });
  },
});

Deno.test({
  name:
    "v3 restore: a follower whose boot restore of its own unconfirmed commit fails still boots, but neither its feed nor a refresh follows from that commit (swamp-club#5145)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const a = await world.machine("a");
      await a.send({ kind: "write", commits: 2, close: true });
      await a.send({ kind: "lease", ttlMs: 60_000 });
      await a.send({ kind: "write", commits: 1, close: false });
      const own = await a.send({ kind: "highWater" }) as number;
      await a.stopSidecars();
      await a.crash();
      const follower = await world.machine("a2", {
        checkout: "a",
        binaryMissing: true,
      });
      assertEquals(await follower.send({ kind: "followHold" }), "follower");
      assertEquals(
        await follower.send({ kind: "highWater" }),
        own,
        "read as it was",
      );
      await assertRejects(
        () => follower.send({ kind: "feedCursor" }),
        MachineError,
        "never replicated",
      );
      await assertRejects(
        () => follower.send({ kind: "refresh" }),
        MachineError,
        "never replicated",
      );
    });
  },
});
