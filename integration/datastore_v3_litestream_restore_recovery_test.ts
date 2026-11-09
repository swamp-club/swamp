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
