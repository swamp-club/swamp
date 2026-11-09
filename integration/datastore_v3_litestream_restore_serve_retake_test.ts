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
import { waitFor } from "@swamp-club/swamp-testing";
import { plantV3WriterLease } from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";
import {
  closeGate,
  gateEntered,
  ignore,
  openGate,
  read,
  STALL_MS,
  withMachines,
} from "./datastore_v3_litestream_restore_helpers.ts";

Deno.test({
  name:
    "v3 restore: serve's retake after another checkout wrote restores into its open store",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const serve = await world.machine("serve");
      await serve.send({ kind: "lease", ttlMs: 1_500, retake: true });
      await serve.send({ kind: "write", commits: 1, close: false });
      await serve.send({ kind: "upkeep", probeMs: 300 });
      await waitFor(
        async () => (await world.lineages()).current !== undefined,
        "serve's head",
      );
      const fence = await serve.send({ kind: "fence" }) as number;
      const paused = serve.send({ kind: "pause", ms: STALL_MS });
      const other = await world.machine("other");
      await other.send({ kind: "write", commits: 2, close: true });
      await paused;
      // serve's renewal finds the lease lost and retakes it, restoring the
      // other lineage; a write started before the renewal noticed is refused,
      // as its copy is behind while serve holds its sidecar
      await waitFor(
        async () => (await serve.send({ kind: "fence" }) as number) > fence,
        "serve's retake",
      );
      await serve.send({ kind: "write", commits: 1, close: false });
      await serve.send({ kind: "stopUpkeep" });
      await serve.send({ kind: "close" });
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 4);
    });
  },
});

Deno.test({
  name:
    "v3 restore: after serve's retake nothing commits or collects chunks on its copy until the restore lands",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const serve = await world.machine("serve");
      await serve.send({ kind: "lease", ttlMs: 1_500, retake: true });
      await serve.send({ kind: "write", commits: 1, close: false });
      await serve.send({ kind: "upkeep", probeMs: 300 });
      await waitFor(
        async () => (await world.lineages()).current !== undefined,
        "serve's head",
      );
      const paused = serve.send({ kind: "pause", ms: STALL_MS });
      const other = await world.machine("other");
      await other.send({ kind: "write", commits: 2, close: true });
      const lock = await Deno.open(
        await serve.send({ kind: "restoreLock" }) as string,
        { read: true, write: true, create: true },
      );
      await lock.lock(true);
      try {
        await paused;
        // Once serve retook the lease, a commit is still refused: its copy
        // is not current until the restore lands.
        // The lost lease's refusal names the fence that took over; the
        // retaken lease's, on a copy not yet current, names none.
        await waitFor(async () => {
          const refused = await serve.send({ kind: "tryCommit" });
          return typeof refused === "string" &&
            refused.includes("took over") && !refused.includes("(fence ") &&
            refused.includes("still being brought up to date") &&
            !refused.includes("Another swamp process");
        }, "a commit refused after the retake");
        const gc = await serve.send({ kind: "gc" }) as string | null;
        assert(gc !== null && gc.includes("made current"), `gc: ${gc}`);
      } finally {
        await lock.unlock();
        lock.close();
      }
      await waitFor(
        async () => await serve.send({ kind: "tryCommit" }) === null,
        "a commit once the restore landed",
      );
      await serve.send({ kind: "stopUpkeep" });
      await serve.send({ kind: "close" });
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 4);
    });
  },
});

Deno.test({
  name:
    "v3 restore: a stale restore that dropped an applied commit still rebuilds serve's read model (swamp-club#3565)",
  ignore,
  async fn() {
    await withMachines(async (world) => {
      const serve = await world.machine("serve", { gated: true });
      await serve.send({ kind: "lease", ttlMs: 1_500, retake: true });
      await serve.send({ kind: "write", commits: 1, close: false });
      await serve.send({ kind: "confirm" });
      await serve.send({ kind: "upkeep", probeMs: 60_000 });
      assertEquals(await serve.send({ kind: "tryCommit" }), null);
      await serve.send({ kind: "catchUp" });
      assertEquals((await serve.send({ kind: "files" }) as string[]).length, 2);
      await closeGate(world, "machine-serve-gate-restore");
      const other = await world.machine("other");
      const paused = serve.send({ kind: "pause", ms: STALL_MS });
      await other.send({ kind: "write", commits: 2, close: true });
      await paused;
      await gateEntered(world, "machine-serve-gate-restore");
      const retaken = await serve.send({ kind: "fence" }) as number;
      const planted = await plantV3WriterLease(world.datastorePath, {
        pid: Deno.ppid,
      });
      await planted.release();
      await waitFor(
        async () => (await serve.send({ kind: "fence" }) as number) > retaken,
        "serve's second retake",
      );
      await openGate(world, "machine-serve-gate-restore");
      await waitFor(
        async () => await serve.send({ kind: "tryCommit" }) === null,
        "serve's commit after the replacement",
        { timeoutMs: 30_000 },
      );
      await waitFor(
        () => serve.send({ kind: "confirm" }).then(() => true, () => false),
        "serve's commit confirmed",
      );
      await serve.send({ kind: "catchUp" });
      const files = await serve.send({ kind: "files" }) as string[];
      await serve.send({ kind: "stopUpkeep" });
      await serve.send({ kind: "close" });
      const c = await world.machine("c");
      assertEquals((await read(c)).commits, 4);
      assertEquals(files, await c.send({ kind: "files" }));
    });
  },
});
