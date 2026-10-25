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
import { dirname, join } from "@std/path";
import type {
  LocalProcess,
  ProcessIdentity,
} from "../../domain/datastore_v3/process_liveness.ts";
import { localProcess } from "./process_identity.ts";
import {
  readWriterMarker,
  readWriterMarkerFile,
  recoverInterruptedWriter,
  recoverySince,
  removeOwnWriterMarker,
  setV3RecoveryProgress,
  writerMarkerPath,
  writerMarkerState,
  writeWriterMarker,
} from "./interrupted_writer_recovery.ts";
import type { V3Datastore } from "./v3_datastore.ts";

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

// --- swamp-club#3617: a marker a crash left unreadable ---

/** Every marker file readWriterMarker reads as none. */
const UNREADABLE_MARKERS = [
  "",
  "\0".repeat(80),
  '{"hostname":"h","pid":4',
  "not json",
  "null",
  JSON.stringify({ hostname: "h", pid: "1", since: 0 }),
  JSON.stringify({ hostname: "h", pid: 0, since: 0 }),
  JSON.stringify({ hostname: "h", pid: 1.5, since: 0 }),
  JSON.stringify({ pid: 1, since: 0 }),
  JSON.stringify({ hostname: "h", pid: 1 }),
  JSON.stringify({ hostname: "h", pid: 1, since: 0, instance: 7 }),
];

Deno.test("readWriterMarkerFile: absent, a marker, or unreadable dated by its file's modification time (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await readWriterMarkerFile(dir), { kind: "absent" });
    const marker = { hostname: "h", pid: 4242, since: 1_000 };
    await writeRaw(dir, JSON.stringify(marker));
    assertEquals(await readWriterMarkerFile(dir), { kind: "marker", marker });
    const mtime = new Date("2026-10-19T10:00:05.700Z");
    for (const text of UNREADABLE_MARKERS) {
      await writeRaw(dir, text);
      await Deno.utime(writerMarkerPath(dir), mtime, mtime);
      assertEquals(
        await readWriterMarkerFile(dir),
        { kind: "unreadable", since: recoverySince(mtime.getTime()) },
        JSON.stringify(text),
      );
      assertEquals(await readWriterMarker(dir), undefined, text);
    }
  });
});

Deno.test("readWriterMarkerFile: a read error other than a missing file is thrown (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(writerMarkerPath(dir), { recursive: true });
    await assertRejects(() => readWriterMarkerFile(dir));
  });
});

Deno.test("writeWriterMarker: syncs the marker, its directory and the directories it created (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const files: string[] = [];
    const dirs: string[] = [];
    await writeWriterMarker(dir, {
      syncFile: () => {
        files.push("synced");
        return Promise.resolve();
      },
      syncDirectory: (synced) => {
        dirs.push(synced);
        return Promise.resolve();
      },
    });
    assertEquals(files, ["synced"]);
    const stateDir = dirname(writerMarkerPath(dir));
    // The state directory and every directory created on the way to it
    // are synced in their parents, up to the temp directory that existed.
    assert(dirs.includes(stateDir), dirs.join(", "));
    assert(dirs.includes(dir), dirs.join(", "));
    assertEquals((await readWriterMarker(dir))?.pid, Deno.pid);
  });
});

/** A handle that records the recovery it is asked for, and nothing else. */
function recordingHandle(dir: string, calls: number[]): V3Datastore {
  return {
    datastorePath: dir,
    recoverInterruptedWriter: (since: number) => {
      calls.push(since);
      return Promise.resolve([]);
    },
  } as unknown as V3Datastore;
}

Deno.test("recoverInterruptedWriter: a writer recovers an unreadable marker from its modification time, then removes it (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    for (const text of ["", "\0".repeat(80), "null"]) {
      await writeRaw(dir, text);
      const mtime = new Date("2026-10-19T10:00:05.700Z");
      await Deno.utime(writerMarkerPath(dir), mtime, mtime);
      const calls: number[] = [];
      assertEquals(
        await recoverInterruptedWriter(recordingHandle(dir, calls), dir, {
          holdsWriterLock: true,
        }),
        [],
      );
      assertEquals(calls, [recoverySince(mtime.getTime())], text);
      assertEquals(await readWriterMarkerFile(dir), { kind: "absent" });
    }
  });
});

Deno.test("recoverInterruptedWriter: a marker file that changed by the time the lease is taken is left to its new writer (swamp-club#3617)", async () => {
  const since = recoverySince(Date.parse("2026-10-19T10:00:00Z"));
  const marker = (fields: Record<string, unknown>) =>
    JSON.stringify({ hostname: "other-host", pid: 4242, since, ...fields });
  const cases: {
    name: string;
    before: string;
    after: string;
    touch?: boolean;
  }[] = [
    {
      name: "another pid, same since",
      before: marker({ instance: "a" }),
      after: marker({ instance: "a", pid: 4343 }),
    },
    {
      name: "same pid and since, a new instance",
      before: marker({ instance: "a" }),
      after: marker({ instance: "b" }),
    },
    {
      name: "same pid, since and instance, another host",
      before: marker({ instance: "a" }),
      after: marker({ instance: "a", hostname: "third-host" }),
    },
    { name: "unreadable, then a marker", before: "", after: marker({}) },
    { name: "a marker, then unreadable", before: marker({}), after: "{" },
    {
      name: "unreadable, then unreadable with a new mtime",
      before: "",
      after: "",
      touch: true,
    },
  ];
  for (const { name, before, after, touch } of cases) {
    await withTempDir(async (dir) => {
      const path = writerMarkerPath(dir);
      await writeRaw(dir, before);
      const old = new Date("2026-10-19T10:00:05.700Z");
      await Deno.utime(path, old, old);
      const calls: number[] = [];
      let raised = 0;
      const handle = {
        datastorePath: join(dir, "datastore"),
        writerFence: () => undefined,
        // The lease is taken: another command recovers and a new writer
        // writes its marker before this one reads the file again.
        raiseWriterFence: async () => {
          raised++;
          await Deno.writeTextFile(path, after);
          const now = touch ? new Date("2026-10-19T10:00:15.700Z") : old;
          await Deno.utime(path, now, now);
        },
        recoverInterruptedWriter: (from: number) => {
          calls.push(from);
          return Promise.resolve([]);
        },
      } as unknown as V3Datastore;
      await Deno.mkdir(handle.datastorePath, { recursive: true });
      assertEquals(
        await recoverInterruptedWriter(handle, dir, { holdsWriterLock: false }),
        undefined,
        name,
      );
      assertEquals(raised, 1, name);
      assertEquals(calls, [], name);
      assertEquals(await Deno.readTextFile(path), after, name);
    });
  }
});

Deno.test("recoverInterruptedWriter: says it is recovering before the replay starts, and says nothing when there is nothing to recover (swamp-club#3893)", async () => {
  await withTempDir(async (dir) => {
    const events: string[] = [];
    setV3RecoveryProgress((message) => events.push(`progress: ${message}`));
    try {
      const handle = {
        datastorePath: dir,
        recoverInterruptedWriter: () => {
          events.push("replay");
          return Promise.resolve([]);
        },
      } as unknown as V3Datastore;
      await recoverInterruptedWriter(handle, dir, { holdsWriterLock: true });
      assertEquals(events, [], "no marker, no recovery, no line");
      await writeRaw(dir, "");
      await recoverInterruptedWriter(handle, dir, { holdsWriterLock: true });
      assertEquals(events, [
        "progress: Recovering work an interrupted command left in this checkout…",
        "replay",
      ]);
    } finally {
      setV3RecoveryProgress(undefined);
    }
  });
});
