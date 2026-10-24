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

import { ReplicaRoot } from "../../../domain/datastore_v3/replica_root.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { WritableDatastoreControlPlaneStore } from "../../../domain/datastore/control_plane_store.ts";
import {
  currentLineage,
  newestStartedFence,
} from "../../../domain/datastore_v3/published_lineage.ts";
import { FileSystemControlPlaneStore } from "../../persistence/fs_control_plane_store.ts";
import { LineageRegistry, PruneDeadlineError } from "./lineage_registry.ts";

const ROOT = "file:/replica";
const AT = "2026-10-14T00:00:00.000Z";

async function withRegistry(
  fn: (
    registry: LineageRegistry,
    calls: { list: number; get: number },
    dir: string,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const fs = new FileSystemControlPlaneStore(dir);
  const calls = { list: 0, get: 0 };
  const store: WritableDatastoreControlPlaneStore = {
    get: (key) => {
      calls.get++;
      return fs.get(key);
    },
    list: (prefix) => {
      calls.list++;
      return fs.list(prefix);
    },
    put: (key, data) => fs.put(key, data),
    putIfAbsent: (key, data) => fs.putIfAbsent(key, data),
    delete: (key) => fs.delete(key),
  };
  try {
    await fn(new LineageRegistry(store), calls, dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function started(fence: number, replicaRoot = ROOT) {
  return { fence, holder: "me@host", replicaRoot, startedAt: AT };
}

function head(fence: number, txid: string) {
  return {
    fence,
    txid,
    writerFence: fence + 1,
    mark: { cursor: 4 },
    publishedAt: AT,
  };
}

Deno.test("LineageRegistry: a lineage is claimed and confirmed once", async () => {
  await withRegistry(async (registry) => {
    assertEquals(await registry.start(started(3)), true);
    assertEquals(await registry.start(started(3)), false);
    const confirmed = { fence: 3, txid: "0000000000000002", confirmedAt: AT };
    assertEquals(await registry.confirm(confirmed), true);
    assertEquals(await registry.confirm(confirmed), false);
  });
});

Deno.test("LineageRegistry: read finds the current lineage and its head", async () => {
  await withRegistry(async (registry, calls) => {
    await registry.start(started(3));
    await registry.confirm({ fence: 3, txid: "1", confirmedAt: AT });
    await registry.publishHead(head(3, "5"));
    await registry.start(started(5));
    await registry.confirm({ fence: 5, txid: "2", confirmedAt: AT });
    await registry.publishHead(head(5, "a"));
    await registry.start(started(8));
    calls.list = 0;
    calls.get = 0;
    const lineages = await registry.read(ReplicaRoot.of(ROOT));
    assertEquals(lineages.map((l) => l.fence), [8, 5, 3]);
    const current = currentLineage(lineages, ReplicaRoot.of(ROOT));
    assertEquals(current?.fence, 5);
    assertEquals(current?.head?.txid, "000000000000000a");
    assertEquals(newestStartedFence(lineages, ReplicaRoot.of(ROOT)), 8);
    // One list, then the newest start, and the current start,
    // confirmation and head: the cost of a check on a current copy.
    assertEquals(calls, { list: 1, get: 4 });
  });
});

Deno.test("LineageRegistry: records under another root or malformed are ignored", async () => {
  await withRegistry(async (registry, _calls, dir) => {
    await registry.start(started(3));
    await registry.confirm({ fence: 3, txid: "1", confirmedAt: AT });
    await registry.publishHead(head(3, "1"));
    // Confirmed without a head: not the current state.
    await registry.start(started(4));
    await registry.confirm({ fence: 4, txid: "1", confirmedAt: AT });
    await registry.start(started(6, "file:/other"));
    await registry.confirm({ fence: 6, txid: "1", confirmedAt: AT });
    // A torn or hand-written record, and a key that is not a lineage's.
    const lineageDir = join(dir, "_control", "lineage");
    await Deno.mkdir(join(lineageDir, "000000000009"), { recursive: true });
    await Deno.writeTextFile(
      join(lineageDir, "000000000009", "started.json"),
      "{not json",
    );
    await Deno.writeTextFile(join(lineageDir, "notes.txt"), "x");
    const lineages = await registry.read(ReplicaRoot.of(ROOT));
    assertEquals(currentLineage(lineages, ReplicaRoot.of(ROOT))?.fence, 3);
    assertEquals(newestStartedFence(lineages, ReplicaRoot.of(ROOT)), 4);
  });
});

Deno.test("LineageRegistry: a removed lineage leaves no records", async () => {
  await withRegistry(async (registry) => {
    await registry.start(started(3));
    await registry.confirm({ fence: 3, txid: "1", confirmedAt: AT });
    await registry.publishHead(head(3, "4"));
    await registry.remove(3);
    await registry.remove(3);
    assertEquals(await registry.read(ReplicaRoot.of(ROOT)), []);
  });
});

Deno.test("LineageRegistry: a fenced writer's late head never moves a continued lineage's head back", async () => {
  await withRegistry(async (registry) => {
    await registry.start(started(5));
    await registry.confirm({ fence: 5, txid: "1", confirmedAt: AT });
    // Writer 7 continued lineage 5 and published its head; writer 6, which
    // lost the lease before, publishes late.
    await registry.publishHead({ ...head(5, "20"), writerFence: 7 });
    await registry.publishHead({ ...head(5, "18"), writerFence: 6 });
    const current = currentLineage(
      await registry.read(ReplicaRoot.of(ROOT)),
      ReplicaRoot.of(ROOT),
    );
    assertEquals(current?.head?.writerFence, 7);
    assertEquals(current?.head?.txid, "0000000000000020");
    await registry.remove(5);
    assertEquals(await registry.read(ReplicaRoot.of(ROOT)), []);
  });
});

Deno.test("LineageRegistry.everConfirmed: only once a lineage under any root is confirmed (swamp-club#3491)", async () => {
  await withRegistry(async (registry) => {
    assertEquals(await registry.everConfirmed(), false);
    // Started but never confirmed: a writer that failed before its first
    // sync leaves the shared commits for the next writer to seed.
    await registry.start(started(4));
    assertEquals(await registry.everConfirmed(), false);
    await registry.start(started(5, "file:/other"));
    await registry.confirm({
      fence: 5,
      txid: "0000000000000001",
      confirmedAt: AT,
    });
    assertEquals(await registry.everConfirmed(), true);
  });
});

Deno.test("LineageRegistry: read finds the current lineage another spelling of the S3 endpoint started (swamp-club#3801)", async () => {
  await withRegistry(async (registry) => {
    const proxied = "s3:http://localhost:47441:bucket:prefix";
    await registry.start(started(5, proxied));
    await registry.confirm({ fence: 5, txid: "1", confirmedAt: AT });
    await registry.publishHead(head(5, "1"));
    for (
      const own of [
        ReplicaRoot.s3("http://localhost:47411", "bucket", "prefix"),
        ReplicaRoot.s3("http://localhost:47441/", "bucket", "prefix"),
        ReplicaRoot.s3(undefined, "bucket", "prefix"),
      ]
    ) {
      const lineages = await registry.read(own);
      assertEquals(currentLineage(lineages, own)?.fence, 5, own.value);
      assertEquals(newestStartedFence(lineages, own), 5, own.value);
    }
  });
});

/** A head of lineage `fence` that writer `writerFence` published. */
function headBy(fence: number, writerFence: number, txid: string) {
  return { ...head(fence, txid), writerFence };
}

/** The lineage records under `dir`, relative to the control plane. */
async function lineageKeys(dir: string): Promise<string[]> {
  const fs = new FileSystemControlPlaneStore(dir);
  return (await fs.list("lineage/")).sort();
}

Deno.test("LineageRegistry.pruneHeads: removes the heads below its writer's, oldest first, and keeps the lineage complete (swamp-club#3803)", async () => {
  await withRegistry(async (registry, _calls, dir) => {
    await registry.start(started(3));
    await registry.confirm({ fence: 3, txid: "1", confirmedAt: AT });
    for (const writer of [4, 5, 6, 7, 9]) {
      await registry.publishHead(headBy(3, writer, writer.toString(16)));
    }
    // Writer 8's own head is not there yet: nothing goes.
    assertEquals(await registry.pruneHeads(3, 8), 0);
    // At most `limit`, the oldest first; writer 9's stays, and so does
    // writer 6's, the newest below writer 7's.
    assertEquals(await registry.pruneHeads(3, 7, { limit: 1 }), 1);
    assertEquals(await registry.pruneHeads(3, 7), 1);
    assertEquals(await lineageKeys(dir), [
      "lineage/000000000003/confirmed.json",
      "lineage/000000000003/head-000000000006.json",
      "lineage/000000000003/head-000000000007.json",
      "lineage/000000000003/head-000000000009.json",
      "lineage/000000000003/started.json",
    ]);
    assertEquals(await registry.pruneHeads(3, 9), 1);
    assertEquals(await lineageKeys(dir), [
      "lineage/000000000003/confirmed.json",
      "lineage/000000000003/head-000000000007.json",
      "lineage/000000000003/head-000000000009.json",
      "lineage/000000000003/started.json",
    ]);
    const current = currentLineage(
      await registry.read(ReplicaRoot.of(ROOT)),
      ReplicaRoot.of(ROOT),
    );
    assertEquals(current?.head?.writerFence, 9);
  });
});

Deno.test("LineageRegistry: a read whose listed heads a newer writer pruned lists the lineage again, rather than fall back to an older one (swamp-club#3803)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const fs = new FileSystemControlPlaneStore(dir);
    const setup = new LineageRegistry(fs);
    await setup.start(started(3));
    await setup.confirm({ fence: 3, txid: "1", confirmedAt: AT });
    await setup.publishHead(headBy(3, 4, "a"));
    await setup.start(started(5));
    await setup.confirm({ fence: 5, txid: "2", confirmedAt: AT });
    await setup.publishHead(headBy(5, 6, "b"));
    // Between the read's list and its first head GET, writer 7 publishes
    // its head on lineage 5 and prunes writer 6's.
    let raced = false;
    const store: WritableDatastoreControlPlaneStore = {
      get: async (key) => {
        if (!raced && key === "lineage/000000000005/head-000000000006.json") {
          raced = true;
          await setup.publishHead(headBy(5, 7, "c"));
          await fs.delete("lineage/000000000005/head-000000000006.json");
        }
        return await fs.get(key);
      },
      list: (prefix) => fs.list(prefix),
      put: (key, data) => fs.put(key, data),
      putIfAbsent: (key, data) => fs.putIfAbsent(key, data),
      delete: (key) => fs.delete(key),
    };
    const current = currentLineage(
      await new LineageRegistry(store).read(ReplicaRoot.of(ROOT)),
      ReplicaRoot.of(ROOT),
    );
    assertEquals(raced, true);
    assertEquals(current?.fence, 5);
    assertEquals(current?.head?.writerFence, 7);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("LineageRegistry: a read that finds a higher listed head gone while a lower one is still there lists again, and never settles on the lower head (swamp-club#3803)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const fs = new FileSystemControlPlaneStore(dir);
    const setup = new LineageRegistry(fs);
    await setup.start(started(3));
    await setup.confirm({ fence: 3, txid: "1", confirmedAt: AT });
    for (const writer of [5, 6, 7]) {
      await setup.publishHead(headBy(3, writer, writer.toString(16)));
    }
    // A prune that removes the highest head first: writer 8 publishes, and
    // writer 7's head is gone before writer 6's.
    let raced = false;
    const store: WritableDatastoreControlPlaneStore = {
      get: async (key) => {
        if (!raced && key === "lineage/000000000003/head-000000000007.json") {
          raced = true;
          await setup.publishHead(headBy(3, 8, "8"));
          await fs.delete(key);
        }
        return await fs.get(key);
      },
      list: (prefix) => fs.list(prefix),
      put: (key, data) => fs.put(key, data),
      putIfAbsent: (key, data) => fs.putIfAbsent(key, data),
      delete: (key) => fs.delete(key),
    };
    const current = currentLineage(
      await new LineageRegistry(store).read(ReplicaRoot.of(ROOT)),
      ReplicaRoot.of(ROOT),
    );
    assertEquals(raced, true);
    assertEquals(current?.head?.writerFence, 8);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("LineageRegistry.pruneHeads: deletes in batches of at most 16, keeping its writer's head and the newest below it (swamp-club#3803)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const fs = new FileSystemControlPlaneStore(dir);
    let inFlight = 0;
    let most = 0;
    const store: WritableDatastoreControlPlaneStore = {
      get: (key) => fs.get(key),
      list: (prefix) => fs.list(prefix),
      put: (key, data) => fs.put(key, data),
      putIfAbsent: (key, data) => fs.putIfAbsent(key, data),
      delete: async (key) => {
        most = Math.max(most, ++inFlight);
        try {
          // Every delete of a batch starts before any finishes.
          await Promise.resolve();
          await fs.delete(key);
        } finally {
          inFlight--;
        }
      },
    };
    const registry = new LineageRegistry(store);
    await registry.start(started(3));
    await registry.confirm({ fence: 3, txid: "1", confirmedAt: AT });
    for (let writer = 4; writer <= 40; writer++) {
      await registry.publishHead(headBy(3, writer, writer.toString(16)));
    }
    // 4..38 go; 39, the newest below 40, and 40 stay.
    assertEquals(await registry.pruneHeads(3, 40), 35);
    assertEquals(most, 16);
    assertEquals(await lineageKeys(dir), [
      "lineage/000000000003/confirmed.json",
      "lineage/000000000003/head-000000000039.json",
      "lineage/000000000003/head-000000000040.json",
      "lineage/000000000003/started.json",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("LineageRegistry.pruneHeads: a store that stops answering ends the prune at its deadline (swamp-club#3803)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const fs = new FileSystemControlPlaneStore(dir);
    const hung = Promise.withResolvers<void>();
    const store: WritableDatastoreControlPlaneStore = {
      get: (key) => fs.get(key),
      list: (prefix) => fs.list(prefix),
      put: (key, data) => fs.put(key, data),
      putIfAbsent: (key, data) => fs.putIfAbsent(key, data),
      delete: () => hung.promise,
    };
    const registry = new LineageRegistry(store);
    await registry.start(started(3));
    await registry.confirm({ fence: 3, txid: "1", confirmedAt: AT });
    for (const writer of [4, 5, 6]) {
      await registry.publishHead(headBy(3, writer, writer.toString(16)));
    }
    await assertRejects(
      () => registry.pruneHeads(3, 6, { deadlineMs: 50 }),
      PruneDeadlineError,
    );
    hung.resolve();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
