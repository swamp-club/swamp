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
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import { replicaPathFor } from "../src/domain/datastore_v3/replication_lineage.ts";
import {
  closeGate,
  gateEntered,
  ignore,
  openGate,
  read,
  S3_ENDPOINT,
  STALL_MS,
  withMachines,
  type World,
} from "./datastore_v3_litestream_restore_helpers.ts";

async function chmodTree(dir: string, mode: number): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) await chmodTree(join(dir, entry.name), mode);
  }
  await Deno.chmod(dir, mode);
}

/**
 * the stale restore must never be marked current nor start serve's lineage;
 * keepStale keeps it restorable on a file replica, where the other writer's
 * collection would remove it
 */
async function retakeDuringStaleRestore(
  world: World,
  options: { readonly keepStale: boolean },
): Promise<void> {
  const serve = await world.machine("serve", { gated: true });
  await serve.send({ kind: "lease", ttlMs: 1_500, retake: true });
  await serve.send({ kind: "write", commits: 1, close: false });
  await serve.send({ kind: "upkeep", probeMs: 300 });
  await waitFor(
    async () => (await world.lineages()).current !== undefined,
    "serve's head",
  );
  const first = await serve.send({ kind: "fence" }) as number;
  await closeGate(world, "machine-serve-gate-restore");
  const other = await world.machine("other");
  let paused = serve.send({ kind: "pause", ms: STALL_MS });
  await other.send({ kind: "write", commits: 2, close: true });
  const stale = (await world.lineages()).current!;
  let kept: string | undefined;
  if (options.keepStale) {
    // Its collection fails, as a best-effort removal may.
    kept = replicaPathFor(world.replicaRoot, stale);
    await chmodTree(kept, 0o555);
  }
  try {
    await paused;
    await waitFor(
      async () => (await serve.send({ kind: "fence" }) as number) > first,
      "serve's first retake",
    );
    const retaken = await serve.send({ kind: "fence" }) as number;
    await gateEntered(world, "machine-serve-gate-restore");
    paused = serve.send({ kind: "pause", ms: STALL_MS });
    await other.send({ kind: "write", commits: 1, close: true });
    await paused;
    await waitFor(
      async () => (await serve.send({ kind: "fence" }) as number) > retaken,
      "serve's second retake",
    );
    assert(await world.registered(stale), "the stale lineage is kept");
    assert((await world.lineages()).current! > stale);
    await openGate(world, "machine-serve-gate-restore");
    await waitFor(
      async () => await serve.send({ kind: "tryCommit" }) === null,
      "serve's commit on the current state",
      { timeoutMs: 30_000 },
    );
    await serve.send({ kind: "stopUpkeep" });
    await serve.send({ kind: "close" });
  } finally {
    if (kept !== undefined) await chmodTree(kept, 0o755);
  }
  const c = await world.machine("c");
  assertEquals((await read(c)).commits, 5);
}

async function retakeDuringSidecarStart(world: World): Promise<void> {
  const serve = await world.machine("serve", { gated: true });
  await serve.send({ kind: "lease", ttlMs: 1_500, retake: true });
  await serve.send({ kind: "write", commits: 1, close: false });
  await serve.send({ kind: "upkeep", probeMs: 300 });
  await waitFor(
    async () => (await world.lineages()).current !== undefined,
    "serve's head",
  );
  const first = await serve.send({ kind: "fence" }) as number;
  await closeGate(world, "machine-serve-gate-sidecar");
  for (const pid of await serve.send({ kind: "pids" }) as number[]) {
    hostLitestreamProcesses.signalGroup(pid, "SIGKILL");
  }
  await gateEntered(world, "machine-serve-gate-sidecar");
  const other = await world.machine("other");
  const paused = serve.send({ kind: "pause", ms: STALL_MS });
  await other.send({ kind: "write", commits: 2, close: true });
  await paused;
  await waitFor(
    async () => (await serve.send({ kind: "fence" }) as number) > first,
    "serve's retake",
  );
  await openGate(world, "machine-serve-gate-sidecar");
  await waitFor(
    async () => await serve.send({ kind: "tryCommit" }) === null,
    "serve's commit once the replacement settled",
    { timeoutMs: 30_000 },
  );
  await serve.send({ kind: "stopUpkeep" });
  await serve.send({ kind: "close" });
  const c = await world.machine("c");
  assertEquals((await read(c)).commits, 4);
}

Deno.test({
  name:
    "v3 restore: a retake while serve's replacement restores a stale lineage keeps every acknowledged commit (swamp-club#3565)",
  ignore,
  async fn() {
    await withMachines((world) =>
      retakeDuringStaleRestore(world, { keepStale: true })
    );
  },
});

Deno.test({
  name:
    "v3 restore: a retake while serve's replacement starts its sidecar leaves serve writing (swamp-club#3565)",
  ignore,
  async fn() {
    await withMachines(retakeDuringSidecarStart);
  },
});

function s3Replica(): string {
  return JSON.stringify({
    type: "s3",
    bucket: Deno.env.get("SWAMP_TEST_LITESTREAM_S3_BUCKET") ?? "swamp-test",
    path: `ls-${crypto.randomUUID()}`,
    endpoint: S3_ENDPOINT,
    region: "us-east-1",
  });
}

Deno.test({
  name:
    "v3 restore: on an S3 replica, a retake during a stale restore keeps every acknowledged commit (opt-in, swamp-club#3565)",
  ignore: ignore || S3_ENDPOINT === undefined,
  async fn() {
    await withMachines(
      (world) => retakeDuringStaleRestore(world, { keepStale: false }),
      { replica: s3Replica },
    );
  },
});

Deno.test({
  name:
    "v3 restore: on an S3 replica, a retake during a sidecar start leaves serve writing (opt-in, swamp-club#3565)",
  ignore: ignore || S3_ENDPOINT === undefined,
  async fn() {
    await withMachines(retakeDuringSidecarStart, { replica: s3Replica });
  },
});
