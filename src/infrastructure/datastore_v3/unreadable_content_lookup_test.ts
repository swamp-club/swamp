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
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { errorPaths, UserError } from "../../domain/errors.ts";
import { isUnreadableContentError } from "../../domain/datastore/unreadable_content.ts";
import { join } from "@std/path";
import {
  type UnreadableRecord,
  unreadableRecordAdvice,
  UnreadableRecordError,
} from "../../domain/datastore_v3/read_model.ts";
import { swampPath } from "../persistence/paths.ts";
import {
  unreadableContentLookup,
  type UnreadableRecordSource,
} from "./unreadable_content_lookup.ts";

const KEY = "data/test/model/m1/cursor/1/raw";

/** A source holding one unreadable record, recording what it was asked. */
function sourceWith(namespace: string, recordKey: string) {
  const asked: [string, string][] = [];
  const source: UnreadableRecordSource = {
    unreadableRecord(ns, key) {
      asked.push([ns, key]);
      if (ns !== namespace || key !== recordKey) {
        return Promise.resolve(undefined);
      }
      const record: UnreadableRecord = {
        namespace,
        recordKey,
        partition: "model:test/model:m1",
        seq: 3,
        position: 7,
        chunk: "ab".repeat(32),
        reason: "missing",
        lastAttempt: new Date(0),
      };
      return Promise.resolve(record);
    },
  };
  return { source, asked };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-unreadable-lookup-" });
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

Deno.test("unreadableContentLookup: a solo record's path returns its UnreadableRecordError", async () => {
  await withTempDir(async (dir) => {
    const { source } = sourceWith("", KEY);
    const error = await unreadableContentLookup(dir, source)(
      join(swampPath(dir), ...KEY.split("/")),
    );
    assertInstanceOf(error, UnreadableRecordError);
    assertEquals(error.code, "datastore_v3_record_unreadable");
    assertEquals(error.record.recordKey, KEY);
  });
});

Deno.test("unreadableContentLookup: a namespaced record's path is looked up under its namespace", async () => {
  await withTempDir(async (dir) => {
    const { source } = sourceWith("team", KEY);
    const error = await unreadableContentLookup(dir, source)(
      join(swampPath(dir), "team", ...KEY.split("/")),
    );
    assertInstanceOf(error, UnreadableRecordError);
    assertEquals(error.record.namespace, "team");
  });
});

Deno.test("unreadableContentLookup: content with no record, or outside the checkout, is absent", async () => {
  await withTempDir(async (dir) => {
    const { source, asked } = sourceWith("", KEY);
    const lookup = unreadableContentLookup(dir, source);
    assertEquals(
      await lookup(join(swampPath(dir), "data", "other", "1", "raw")),
      undefined,
    );
    asked.length = 0;
    assertEquals(
      await lookup(join(dir, "elsewhere", ...KEY.split("/"))),
      undefined,
    );
    assertEquals(asked, []);
  });
});

Deno.test("unreadableContentLookup: a failing source fails the read naming the path, rather than reading as absent", async () => {
  await withTempDir(async (dir) => {
    const lookup = unreadableContentLookup(dir, {
      unreadableRecord: () => Promise.reject(new Error("disk I/O error")),
    });
    const path = join(swampPath(dir), ...KEY.split("/"));
    const error = await assertRejects(() => lookup(path), UserError);
    assertStringIncludes(error.message, path);
    assertStringIncludes(error.message, "disk I/O error");
    assert(!isUnreadableContentError(error));
    assertEquals(errorPaths(error), [path]);
  });
});

Deno.test("unreadableContentLookup: a checkout spelled through a symlink matches a content path spelled through its target, and back (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    // The macOS temp dir is itself a symlink (/var -> /private/var), so the
    // real spelling differs from the temp dir's there too.
    const real = join(await Deno.realPath(dir), "repo");
    await Deno.mkdir(join(real, ".swamp", "data"), { recursive: true });
    const link = join(dir, "link");
    await Deno.symlink(real, link, { type: "dir" });
    const { source } = sourceWith("", KEY);
    // The content file is missing; only its ancestors exist.
    assert(
      await unreadableContentLookup(link, source)(
        join(swampPath(real), ...KEY.split("/")),
      ) instanceof UnreadableRecordError,
    );
    assert(
      await unreadableContentLookup(real, source)(
        join(swampPath(link), ...KEY.split("/")),
      ) instanceof UnreadableRecordError,
    );
    assert(
      await unreadableContentLookup(join(dir, "repo-unresolved"), source)(
        join(swampPath(link), ...KEY.split("/")),
      ) === undefined,
    );
  });
});

/** A source listing `records` by key prefix, recording what it was asked. */
function listingSource(records: readonly UnreadableRecord[]) {
  const asked: [string, string][] = [];
  const source: UnreadableRecordSource = {
    unreadableRecord: () => Promise.resolve(undefined),
    unreadableRecordsUnder(ns, prefix) {
      asked.push([ns, prefix]);
      return Promise.resolve(
        records.filter((r) =>
          r.namespace === ns && r.recordKey.startsWith(`${prefix}/`)
        ),
      );
    },
  };
  return { source, asked };
}

function recordAt(namespace: string, recordKey: string): UnreadableRecord {
  return {
    namespace,
    recordKey,
    partition: "p",
    seq: 1,
    position: 1,
    reason: "damaged",
    lastAttempt: new Date(0),
  };
}

Deno.test("unreadableContentLookup.under: lists a directory's records as the solo or namespaced keys under it, spelled under the directory, with their errors and advice (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const { source, asked } = listingSource([
      recordAt("", "outputs/t/m/a.yaml"),
      recordAt("team", "outputs/t/m/b.yaml"),
      recordAt("", "outputsx/c.yaml"),
    ]);
    const under = unreadableContentLookup(dir, source).under;
    assert(under !== undefined);
    const solo = await under(join(swampPath(dir), "outputs"));
    assertEquals(solo.map((e) => e.path), [
      join(swampPath(dir), "outputs", "t", "m", "a.yaml"),
    ]);
    assertInstanceOf(solo[0].error, UnreadableRecordError);
    assertEquals(solo[0].error.record.recordKey, "outputs/t/m/a.yaml");
    assertEquals(solo[0].advice, unreadableRecordAdvice("outputs/t/m/a.yaml"));
    assertEquals(asked, [["", "outputs"]]);

    asked.length = 0;
    const team = await under(join(swampPath(dir), "team", "outputs", "t"));
    assertEquals(team.map((e) => e.path), [
      join(swampPath(dir), "team", "outputs", "t", "m", "b.yaml"),
    ]);
    assertEquals(asked, [["", "team/outputs/t"], ["team", "outputs/t"]]);

    // A directory outside the checkout asks nothing.
    asked.length = 0;
    assertEquals(await under(join(dir, "elsewhere")), []);
    assertEquals(asked, []);
  });
});

Deno.test("unreadableContentLookup.under: a checkout spelled through a symlink lists the records under the directory as the caller spelled it (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const real = join(await Deno.realPath(dir), "repo");
    await Deno.mkdir(join(real, ".swamp"), { recursive: true });
    const link = join(dir, "link");
    await Deno.symlink(real, link, { type: "dir" });
    const { source } = listingSource([recordAt("", "workflow-runs/w/r.yaml")]);
    // The directory itself is missing: every run of it is unreadable.
    const runsDir = join(swampPath(real), "workflow-runs");
    const listed = await unreadableContentLookup(link, source).under!(runsDir);
    assertEquals(listed.map((e) => e.path), [join(runsDir, "w", "r.yaml")]);
  });
});

Deno.test("unreadableContentLookup.under: absent when the source cannot list; a failing listing throws naming the directory (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const { source } = sourceWith("", KEY);
    assertEquals(unreadableContentLookup(dir, source).under, undefined);
    const failing = unreadableContentLookup(dir, {
      unreadableRecord: () => Promise.resolve(undefined),
      unreadableRecordsUnder: () => Promise.reject(new Error("disk I/O error")),
    });
    const outputs = join(swampPath(dir), "outputs");
    const error = await assertRejects(() => failing.under!(outputs), UserError);
    assertStringIncludes(error.message, outputs);
    assertStringIncludes(error.message, "disk I/O error");
    assertEquals(errorPaths(error), [outputs]);
  });
});
