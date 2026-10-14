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
import type { WritableDatastoreControlPlaneStore } from "../../../domain/datastore/control_plane_store.ts";
import {
  currentLineage,
  newestStartedFence,
} from "../../../domain/datastore_v3/published_lineage.ts";
import { FileSystemControlPlaneStore } from "../../persistence/fs_control_plane_store.ts";
import { LineageRegistry } from "./lineage_registry.ts";

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
    const lineages = await registry.read(ROOT);
    assertEquals(lineages.map((l) => l.fence), [8, 5, 3]);
    const current = currentLineage(lineages, ROOT);
    assertEquals(current?.fence, 5);
    assertEquals(current?.head?.txid, "000000000000000a");
    assertEquals(newestStartedFence(lineages, ROOT), 8);
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
    const lineages = await registry.read(ROOT);
    assertEquals(currentLineage(lineages, ROOT)?.fence, 3);
    assertEquals(newestStartedFence(lineages, ROOT), 4);
  });
});

Deno.test("LineageRegistry: a removed lineage leaves no records", async () => {
  await withRegistry(async (registry) => {
    await registry.start(started(3));
    await registry.confirm({ fence: 3, txid: "1", confirmedAt: AT });
    await registry.publishHead(head(3, "4"));
    await registry.remove(3);
    await registry.remove(3);
    assertEquals(await registry.read(ROOT), []);
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
    const current = currentLineage(await registry.read(ROOT), ROOT);
    assertEquals(current?.head?.writerFence, 7);
    assertEquals(current?.head?.txid, "0000000000000020");
    await registry.remove(5);
    assertEquals(await registry.read(ROOT), []);
  });
});
