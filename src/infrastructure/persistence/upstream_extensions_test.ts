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
import { relative as win32Relative } from "@std/path/windows";
import {
  canonicalLockfileEntry,
  canonicalLockfilePath,
  lockfileRelative,
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

Deno.test("readUpstreamExtensions: reads a lockfile written on Windows with forward slashes and no bundle paths (swamp-club#3569)", async () => {
  const written = {
    "@ns/ext": {
      version: "2026.01.01.1",
      pulledAt: "2026-01-01",
      files: [
        ".swamp\\bundles\\2f6574ec\\ext.js",
        ".swamp\\pulled-extensions\\@ns\\ext\\models\\ext.ts",
        ".swamp/vault-bundles/464e926c/v.js",
      ],
      include: ["models\\_lib\\x.ts"],
      futureField: ["a\\b"],
    },
  };
  await withLockfile(JSON.stringify(written), async (lockfilePath) => {
    const read: Record<string, unknown> = await readUpstreamExtensions(
      lockfilePath,
    );
    assertEquals(read, {
      "@ns/ext": {
        version: "2026.01.01.1",
        pulledAt: "2026-01-01",
        files: [".swamp/pulled-extensions/@ns/ext/models/ext.ts"],
        include: ["models/_lib/x.ts"],
        futureField: ["a\\b"],
      },
    });
    assertEquals(
      Object.keys(read["@ns/ext"] as object),
      Object.keys(written["@ns/ext"]),
    );
  });
});

Deno.test("canonicalLockfileEntry: keeps non-string items, array order and non-object entries", () => {
  assertEquals(
    canonicalLockfileEntry({ files: ["b\\x", 7, "a/y", null] }),
    { files: ["b/x", 7, "a/y", null] },
  );
  assertEquals(canonicalLockfileEntry({ files: "a\\b" }), { files: "a\\b" });
  assertEquals(canonicalLockfileEntry(null), null);
  assertEquals(canonicalLockfileEntry(["a\\b"]), ["a\\b"]);
});

Deno.test("readUpstreamExtensions: a __proto__ key stays data", async () => {
  await withLockfile(
    '{"__proto__": {"version": "1", "files": ["a\\\\b"]}}',
    async (lockfilePath) => {
      const read = await readUpstreamExtensions(lockfilePath);
      assertEquals(Object.getPrototypeOf(read), Object.prototype);
      assertEquals(Object.hasOwn(read, "__proto__"), true);
      assertEquals(read["__proto__"].files, ["a/b"]);
    },
  );
});

Deno.test("lockfileRelative: gives a repo-relative path with forward slashes", () => {
  const repo = join("work", "repo");
  assertEquals(
    lockfileRelative(repo, join(repo, ".claude", "skills", "foo", "SKILL.md")),
    ".claude/skills/foo/SKILL.md",
  );
});

Deno.test("canonicalLockfilePath: turns a Windows relative() result into the lockfile form", () => {
  const rel = win32Relative(
    "C:\\work\\repo",
    "C:\\work\\repo\\.swamp\\bundles\\2f6574ec",
  );
  assertEquals(rel, ".swamp\\bundles\\2f6574ec");
  assertEquals(canonicalLockfilePath(rel), ".swamp/bundles/2f6574ec");
});
