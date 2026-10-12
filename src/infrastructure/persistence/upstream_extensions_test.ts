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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  readPublishedChannel,
  readUpstreamExtensions,
} from "./upstream_extensions.ts";

async function withLockfile(
  content: string | null,
  fn: (lockfilePath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lockfile-test-" });
  try {
    const lockfilePath = join(dir, "upstream_extensions.json");
    if (content !== null) await Deno.writeTextFile(lockfilePath, content);
    await fn(lockfilePath);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("readUpstreamExtensions: a missing lockfile reads as empty", async () => {
  await withLockfile(null, async (lockfilePath) => {
    assertEquals(await readUpstreamExtensions(lockfilePath), {});
  });
});

Deno.test("readUpstreamExtensions: returns the parsed entries", async () => {
  const entries = {
    "@ns/ext": { version: "2026.01.01.1", pulledAt: "2026-01-01" },
  };
  await withLockfile(JSON.stringify(entries), async (lockfilePath) => {
    assertEquals(await readUpstreamExtensions(lockfilePath), entries);
  });
});

Deno.test("readUpstreamExtensions: rejects a lockfile containing null, naming the file", async () => {
  await withLockfile("null\n", async (lockfilePath) => {
    const error = await assertRejects(
      () => readUpstreamExtensions(lockfilePath),
      SyntaxError,
    );
    assertStringIncludes(error.message, lockfilePath);
    assertStringIncludes(error.message, "found null");
  });
});

Deno.test("readUpstreamExtensions: rejects a lockfile containing an array", async () => {
  await withLockfile("[]", async (lockfilePath) => {
    const error = await assertRejects(
      () => readUpstreamExtensions(lockfilePath),
      SyntaxError,
    );
    assertStringIncludes(error.message, "found an array");
  });
});

Deno.test("readUpstreamExtensions: rejects unparseable JSON, naming the file", async () => {
  await withLockfile("{\n", async (lockfilePath) => {
    const error = await assertRejects(
      () => readUpstreamExtensions(lockfilePath),
      SyntaxError,
    );
    assertStringIncludes(
      error.message,
      `Cannot parse lockfile ${lockfilePath}`,
    );
  });
});

Deno.test("readPublishedChannel: answers a release channel name", () => {
  assertEquals(readPublishedChannel({ publishedChannel: "rc" }), "rc");
});

Deno.test("readPublishedChannel: an absent or hand-edited value reads as null", () => {
  assertEquals(readPublishedChannel({}), null);
  assertEquals(readPublishedChannel({ publishedChannel: "nightly" }), null);
  assertEquals(
    readPublishedChannel({ publishedChannel: "\u001b[31mbeta" }),
    null,
  );
  assertEquals(
    readPublishedChannel({ publishedChannel: 7 as unknown as string }),
    null,
  );
});
