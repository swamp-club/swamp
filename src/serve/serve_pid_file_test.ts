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
import {
  probeServePid,
  readServePidSidecar,
  removePidFileIfOurs,
  type ServePidProbeDeps,
  servePidSidecarPath,
  writeServePidFiles,
} from "./serve_pid_file.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "pid-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("removePidFileIfOurs: removes the file that names this process", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "serve.pid");
    await Deno.writeTextFile(path, "4242\n");
    assertEquals(await removePidFileIfOurs(path, 4242), true);
    assertEquals(await Deno.stat(path).then(() => true, () => false), false);
  });
});

Deno.test("removePidFileIfOurs: keeps a file a later serve wrote", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "serve.pid");
    await Deno.writeTextFile(path, "5151");
    assertEquals(await removePidFileIfOurs(path, 4242), false);
    assertEquals(await Deno.readTextFile(path), "5151");
  });
});

Deno.test("removePidFileIfOurs: a missing file is not an error", async () => {
  await withTempDir(async (dir) => {
    assertEquals(
      await removePidFileIfOurs(join(dir, "serve.pid"), 4242),
      false,
    );
  });
});

const exists = (started?: string): ServePidProbeDeps => ({
  processExists: () => true,
  startTime: () => Promise.resolve(started),
});

Deno.test("writeServePidFiles: serve.pid stays a bare PID and the sidecar records the start time", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "serve.pid");
    await writeServePidFiles(path, { pid: 4242, startTime: "Tue Nov 10" });
    assertEquals(await Deno.readTextFile(path), "4242");
    assertEquals(await readServePidSidecar(path), {
      pid: 4242,
      startTime: "Tue Nov 10",
    });
  });
});

Deno.test("readServePidSidecar: a missing or malformed sidecar reads as none", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "serve.pid");
    assertEquals(await readServePidSidecar(path), undefined);
    await Deno.writeTextFile(servePidSidecarPath(path), "not json");
    assertEquals(await readServePidSidecar(path), undefined);
    await Deno.writeTextFile(servePidSidecarPath(path), '{"pid":"4242"}');
    assertEquals(await readServePidSidecar(path), undefined);
  });
});

Deno.test("removePidFileIfOurs: removes this serve's sidecar and keeps a later serve's", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "serve.pid");
    await writeServePidFiles(path, { pid: 4242, startTime: "t" });
    assertEquals(await removePidFileIfOurs(path, 4242), true);
    assertEquals(await readServePidSidecar(path), undefined);

    await writeServePidFiles(path, { pid: 5151, startTime: "t" });
    assertEquals(await removePidFileIfOurs(path, 4242), false);
    assertEquals(await readServePidSidecar(path), {
      pid: 5151,
      startTime: "t",
    });
  });
});

Deno.test("probeServePid: the same start time is the serve that wrote the files", async () => {
  assertEquals(
    await probeServePid(4242, { pid: 4242, startTime: "t1" }, exists("t1")),
    "match",
  );
});

Deno.test("probeServePid: a reused pid or a vanished process is a stale file", async () => {
  assertEquals(
    await probeServePid(4242, { pid: 4242, startTime: "t1" }, exists("t2")),
    "reused",
  );
  assertEquals(
    await probeServePid(4242, { pid: 4242, startTime: "t1" }, {
      processExists: () => false,
      startTime: () => Promise.resolve(undefined),
    }),
    "gone",
  );
});

Deno.test("probeServePid: what this machine cannot tell is unknown, never stale", async () => {
  // ps missing or busybox: no start time
  assertEquals(
    await probeServePid(4242, { pid: 4242, startTime: "t1" }, exists()),
    "unknown",
  );
  // a serve started before the sidecar existed
  assertEquals(await probeServePid(4242, undefined, exists("t1")), "unknown");
  // a sidecar naming another pid, or written without a start time
  assertEquals(
    await probeServePid(4242, { pid: 5151, startTime: "t1" }, exists("t1")),
    "unknown",
  );
  assertEquals(
    await probeServePid(4242, { pid: 4242 }, exists("t1")),
    "unknown",
  );
});
