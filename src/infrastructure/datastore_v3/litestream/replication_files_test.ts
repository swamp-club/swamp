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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../../../domain/errors.ts";
import {
  clearReplacementMarks,
  ensurePrivateDir,
  ensureSharedDir,
  isMarkedForReplacement,
  markForReplacement,
  readLineage,
  readPresence,
  removeLineage,
  removeOwnPresence,
  renderLitestreamConfig,
  replicationPathsFor,
  writeLineage,
  writePresence,
} from "./replication_files.ts";

const UNIX = Deno.build.os !== "windows";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  // Under /tmp, as in production: macOS TMPDIR is too long for a socket.
  const dir = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "swamp-ls-files-",
  });
  try {
    await fn(await Deno.realPath(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function database(dir: string): Promise<string> {
  const db = join(dir, "datastore", "commits.db");
  await Deno.mkdir(join(dir, "datastore"));
  await Deno.writeTextFile(db, "");
  return db;
}

Deno.test({
  name:
    "replicationPathsFor: two spellings of one database name the same paths",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const db = await database(dir);
      await Deno.symlink(join(dir, "datastore"), join(dir, "link"), {
        type: "dir",
      });
      const priv = join(dir, "priv");
      const direct = await replicationPathsFor(db, priv);
      const linked = await replicationPathsFor(
        join(dir, "link", "commits.db"),
        priv,
      );
      assertEquals(linked, direct);
      assertEquals(
        direct.sharedDir,
        join(dir, "datastore", ".commits.db-replication"),
      );
      assertEquals(direct.socket.startsWith(priv), true);
    });
  },
});

Deno.test({
  name: "replicationPathsFor: refuses a socket path past the AF_UNIX limit",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const db = await database(dir);
      await assertRejects(
        () => replicationPathsFor(db, join(dir, "x".repeat(120))),
        UserError,
        "longer than this platform allows",
      );
    });
  },
});

Deno.test({
  name:
    "ensurePrivateDir: creates 0700 directories and refuses one open to others",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const paths = await replicationPathsFor(
        await database(dir),
        join(dir, "priv"),
      );
      await ensurePrivateDir(paths);
      assertEquals((await Deno.stat(paths.privateDir)).mode! & 0o777, 0o700);
      await Deno.chmod(join(dir, "priv"), 0o755);
      await assertRejects(() => ensurePrivateDir(paths), UserError, "0700");
    });
  },
});

Deno.test({
  name: "ensurePrivateDir: refuses a symlink in place of the directory",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const target = join(dir, "elsewhere");
      await Deno.mkdir(target, { mode: 0o700 });
      await Deno.symlink(target, join(dir, "priv"), { type: "dir" });
      const paths = await replicationPathsFor(
        await database(dir),
        join(dir, "priv"),
      );
      await assertRejects(() => ensurePrivateDir(paths), UserError);
    });
  },
});

Deno.test({
  name:
    "presence: written atomically, read back, and removed only by its supervisor",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const paths = await replicationPathsFor(
        await database(dir),
        join(dir, "priv"),
      );
      assertEquals(await ensureSharedDir(paths), "own");
      assertEquals(await readPresence(paths), { kind: "missing" });
      const record = {
        supervisorPid: 10,
        litestreamPid: 11,
        uid: Deno.uid(),
        hostname: "h",
        lineageFence: 3,
        replicaPath: "/r/_litestream/000000000003",
      };
      await writePresence(paths, record);
      assertEquals(await readPresence(paths), { kind: "found", record });
      await removeOwnPresence(paths, 99);
      assertEquals((await readPresence(paths)).kind, "found");
      await removeOwnPresence(paths, 10);
      assertEquals(await readPresence(paths), { kind: "missing" });
      await Deno.writeTextFile(paths.presence, "{torn");
      assertEquals(await readPresence(paths), { kind: "missing" });
    });
  },
});

Deno.test({
  name: "replacement marks: one per supervisor, cleared at a new start",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const paths = await replicationPathsFor(
        await database(dir),
        join(dir, "priv"),
      );
      await ensureSharedDir(paths);
      assertEquals(await isMarkedForReplacement(paths, 10), false);
      await markForReplacement(paths, 10);
      await markForReplacement(paths, 10);
      assert(await isMarkedForReplacement(paths, 10));
      assertEquals(await isMarkedForReplacement(paths, 11), false);
      await clearReplacementMarks(paths);
      assertEquals(await isMarkedForReplacement(paths, 10), false);
    });
  },
});

Deno.test({
  name: "lineage: round-trips, and a torn or removed record reads as none",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const paths = await replicationPathsFor(
        await database(dir),
        join(dir, "priv"),
      );
      await ensureSharedDir(paths);
      const lineage = {
        replicaRoot: "file:/r",
        lineageFence: 2,
        lastFence: 4,
        previousLineages: [{ replicaRoot: "file:/r", fence: 1 }],
      };
      await writeLineage(paths, lineage);
      assertEquals(await readLineage(paths), lineage);
      await Deno.writeTextFile(paths.lineage, "nope");
      assertEquals(await readLineage(paths), undefined);
      await removeLineage(paths);
      await removeLineage(paths);
      assertEquals(await readLineage(paths), undefined);
    });
  },
});

Deno.test("renderLitestreamConfig: a file replica, quoted, with no checkpoint option", () => {
  const config = renderLitestreamConfig(
    { commitsDb: "/d/commits.db", socket: "/tmp/s/ls.sock" },
    { type: "file", path: "/r" },
    "/r/_litestream/000000000003",
  );
  assertStringIncludes(config, 'path: "/tmp/s/ls.sock"');
  assertStringIncludes(config, '- path: "/d/commits.db"');
  assertStringIncludes(config, "type: file");
  assertEquals(/checkpoint/i.test(config), false);
});

Deno.test("renderLitestreamConfig: an s3 replica with an endpoint uses path-style requests", () => {
  const config = renderLitestreamConfig(
    { commitsDb: "/d/commits.db", socket: "/s" },
    {
      type: "s3",
      bucket: "b",
      path: "p",
      endpoint: "http://e",
      region: "us-east-1",
    },
    "p/_litestream/000000000001",
  );
  assertStringIncludes(config, 'bucket: "b"');
  assertStringIncludes(config, 'endpoint: "http://e"');
  assertStringIncludes(config, "force-path-style: true");
  assertEquals(/secret|access/i.test(config), false);
});

Deno.test({
  name: "ensureSharedDir: a directory other users can write is not trusted",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const paths = await replicationPathsFor(
        await database(dir),
        join(dir, "priv"),
      );
      assertEquals(await ensureSharedDir(paths), "own");
      await Deno.chmod(paths.sharedDir, 0o777);
      assertEquals(await ensureSharedDir(paths), "foreign");
    });
  },
});
