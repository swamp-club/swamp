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
import { dirname } from "@std/path";
import type {
  LocalProcess,
  ProcessIdentity,
} from "../../domain/datastore_v3/process_liveness.ts";
import { localProcess } from "./process_identity.ts";
import {
  readWriterMarker,
  removeOwnWriterMarker,
  writerMarkerPath,
  writerMarkerState,
  writeWriterMarker,
} from "./interrupted_writer_recovery.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-writer-marker-" });
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

async function writeRaw(repoDir: string, text: string): Promise<void> {
  const path = writerMarkerPath(repoDir);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

Deno.test("writeWriterMarker: records this process, dated before it started writing", async () => {
  await withTempDir(async (dir) => {
    const before = Date.now();
    await writeWriterMarker(dir);
    const marker = await readWriterMarker(dir);
    assertEquals(marker?.pid, Deno.pid);
    assertEquals(marker?.hostname, Deno.hostname());
    assert(marker !== undefined && marker.since <= before - 1_000);
    assertEquals(marker.since % 1000, 0, "floored to the second");
  });
});

Deno.test("removeOwnWriterMarker: removes this process's marker and leaves another's", async () => {
  await withTempDir(async (dir) => {
    await writeWriterMarker(dir);
    await removeOwnWriterMarker(dir);
    assertEquals(await readWriterMarker(dir), undefined);

    // This pid and host under another token: a predecessor's marker.
    const predecessor = {
      hostname: Deno.hostname(),
      pid: Deno.pid,
      instance: crypto.randomUUID(),
      since: 0,
    };
    await writeRaw(dir, JSON.stringify(predecessor));
    await removeOwnWriterMarker(dir);
    assertEquals(await readWriterMarker(dir), predecessor);

    const other = { hostname: Deno.hostname(), pid: Deno.ppid, since: 0 };
    await writeRaw(dir, JSON.stringify(other));
    await removeOwnWriterMarker(dir);
    assertEquals(await readWriterMarker(dir), other);

    // No marker at all is not an error.
    await Deno.remove(writerMarkerPath(dir));
    await removeOwnWriterMarker(dir);
  });
});

Deno.test("readWriterMarker: a marker that names no process reads as none", async () => {
  await withTempDir(async (dir) => {
    for (
      const text of [
        "not json",
        "null",
        JSON.stringify({ hostname: "h", pid: "1", since: 0 }),
        JSON.stringify({ hostname: "h", pid: 0, since: 0 }),
        JSON.stringify({ hostname: "h", pid: 1.5, since: 0 }),
        JSON.stringify({ pid: 1, since: 0 }),
        JSON.stringify({ hostname: "h", pid: 1 }),
        JSON.stringify({ hostname: "h", pid: 1, since: 0, instance: 7 }),
      ]
    ) {
      await writeRaw(dir, text);
      assertEquals(await readWriterMarker(dir), undefined, text);
    }
  });
});

Deno.test("writerMarkerState: knows this process by its token, judges a process on this kernel by its identity, and leaves the rest to the lease", async () => {
  const kernel = { host: "host#pid:[1]", bootId: "boot-id:a" };
  const local = (present: boolean, startTime?: string): LocalProcess => ({
    pid: Deno.pid,
    identity: { ...kernel, startTime: "t-self" },
    probe: () => ({
      present,
      zombie: false,
      ...(startTime !== undefined ? { startTime } : {}),
    }),
    bootIdRequired: true,
  });
  const alive = local(true, "t1");
  const gone = local(false);
  await withTempDir(async (dir) => {
    await writeWriterMarker(dir);
    const own = await readWriterMarker(dir);
    assert(own !== undefined && own.instance !== undefined);
    assertEquals(own.process, (await localProcess()).identity);
    assertEquals(writerMarkerState(own, alive), "own");
    // A restarted container: same host and pid, another process's token.
    assertEquals(
      writerMarkerState(
        { ...own, instance: crypto.randomUUID(), process: kernel },
        alive,
      ),
      "interrupted",
    );
  });
  const marker = (process?: ProcessIdentity) => ({
    hostname: "host",
    pid: 4242,
    since: 0,
    ...(process !== undefined ? { process } : {}),
  });
  assertEquals(
    writerMarkerState(
      { hostname: "host", pid: Deno.pid, since: 0, process: kernel },
      alive,
    ),
    "interrupted",
    "a marker without this process's token is never this process's",
  );
  assertEquals(writerMarkerState(marker(kernel), gone), "interrupted");
  assertEquals(writerMarkerState(marker(kernel), alive), "live");
  // A pid reused by a process started later (swamp-club#3564).
  assertEquals(
    writerMarkerState(marker({ ...kernel, startTime: "t0" }), alive),
    "interrupted",
  );
  // Another pid namespace with the same hostname, or a marker from a swamp
  // before identities: the lease decides, whatever the pid here.
  assertEquals(
    writerMarkerState(marker({ ...kernel, host: "host#pid:[2]" }), gone),
    "unknown",
  );
  assertEquals(writerMarkerState(marker(), gone), "unknown");
});
