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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createExtensionListDeps,
  extensionList,
  type ExtensionListDeps,
  type ExtensionListEvent,
} from "./list.ts";
import { join } from "@std/path";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { resolvePulledExtensionsRoot } from "../../infrastructure/persistence/paths.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";
import type { UpstreamExtensionsMap } from "../../infrastructure/persistence/upstream_extensions.ts";

function makeDeps(upstream?: UpstreamExtensionsMap): ExtensionListDeps {
  const cache: UpstreamExtensionsMap = upstream ?? {
    "@ns/beta": { version: "1.0.0", pulledAt: "2026-01-02" },
    "@ns/alpha": {
      version: "2.0.0",
      pulledAt: "2026-01-01",
      files: ["a.ts"],
    },
  };
  return {
    lockfileRepository: new LockfileRepository(
      "/test/repo/upstream_extensions.json",
      cache,
    ),
  };
}

Deno.test("extensionList yields sorted extensions", async () => {
  const deps = makeDeps();
  const events = await collect<ExtensionListEvent>(
    extensionList(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ExtensionListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.extensions.length, 2);
  assertEquals(completed.data.extensions[0].name, "@ns/alpha");
  assertEquals(completed.data.extensions[1].name, "@ns/beta");
});

Deno.test("extensionList yields empty list when no extensions", async () => {
  const deps = makeDeps({});
  const events = await collect<ExtensionListEvent>(
    extensionList(createLibSwampContext(), deps),
  );

  const completed = events[1] as Extract<
    ExtensionListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.extensions.length, 0);
});

async function listed(deps: ExtensionListDeps) {
  const events = await collect<ExtensionListEvent>(
    extensionList(createLibSwampContext(), deps),
  );
  return (events[1] as Extract<ExtensionListEvent, { kind: "completed" }>)
    .data.extensions;
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp_list_" });
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

Deno.test("extensionList flags an on-disk version that differs from the lockfile pin", async () => {
  const deps: ExtensionListDeps = {
    ...makeDeps({
      "@ns/skewed": { version: "1.0.0", pulledAt: "2026-01-01" },
      "@ns/matching": { version: "2.0.0", pulledAt: "2026-01-01" },
      "@ns/unknown": { version: "3.0.0", pulledAt: "2026-01-01" },
    }),
    readOnDiskVersion: (name) =>
      name === "@ns/skewed"
        ? "1.1.0"
        : name === "@ns/matching"
        ? "2.0.0"
        : null,
  };
  const exts = await listed(deps);
  const byName = Object.fromEntries(exts.map((e) => [e.name, e]));
  assertEquals(byName["@ns/skewed"].onDiskVersion, "1.1.0");
  assertEquals("onDiskVersion" in byName["@ns/matching"], false);
  assertEquals("onDiskVersion" in byName["@ns/unknown"], false);
});

Deno.test("extensionList does not flag skew for an entry without a pinned version", async () => {
  const deps: ExtensionListDeps = {
    ...makeDeps({
      "@ns/unpinned": { version: "", pulledAt: "2026-01-01" },
    }),
    readOnDiskVersion: () => "1.1.0",
  };
  const exts = await listed(deps);
  assertEquals("onDiskVersion" in exts[0], false);
});

Deno.test("extensionList does not flag skew for a version-constraint pin", async () => {
  const deps: ExtensionListDeps = {
    ...makeDeps({
      "@ns/ranged": { version: "^1.0.0", pulledAt: "2026-01-01" },
    }),
    readOnDiskVersion: () => "1.2.0",
  };
  const exts = await listed(deps);
  assertEquals("onDiskVersion" in exts[0], false);
});

Deno.test("createExtensionListDeps reads the given managed lockfile and the transitional local one", async () => {
  await withTempDir(async (dir) => {
    const managed = join(dir, "cache", "upstream_extensions.json");
    const local = join(dir, ".swamp", "config", "upstream_extensions.json");
    await Deno.mkdir(join(dir, "cache"), { recursive: true });
    await Deno.mkdir(join(dir, ".swamp", "config"), { recursive: true });
    await Deno.mkdir(join(resolvePulledExtensionsRoot(dir), "@ns", "auto"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      managed,
      JSON.stringify({ "@ns/team": { version: "1", pulledAt: "x" } }),
    );
    // @ns/gone has no directory and no files left, so it awaits reinstall;
    // @ns/null is malformed.
    await Deno.writeTextFile(
      local,
      JSON.stringify({
        "@ns/auto": {
          version: "2",
          pulledAt: "y",
          files: [".swamp/pulled-extensions/skills/auto/SKILL.md"],
        },
        "@ns/team": { version: "local", pulledAt: "z" },
        "@ns/gone": {
          version: "3",
          pulledAt: "w",
          files: [".swamp/bundles/abc/gone.js"],
        },
        "@ns/null": null,
      }),
    );
    const exts = await listed(
      await createExtensionListDeps(dir, managed, local),
    );
    assertEquals(exts.map((e) => [e.name, e.version, e.autoResolved]), [
      ["@ns/auto", "2", true],
      ["@ns/team", "1", undefined],
    ]);
    // Only the auto-resolved entry says what to delete to reinstall it.
    assertEquals(exts[0].removeToReinstall?.length, 2);
    assertPathEquals(
      exts[0].removeToReinstall?.[1] ?? "",
      ".swamp/pulled-extensions/skills/auto",
    );
    assertEquals("removeToReinstall" in exts[1], false);
  });
});

Deno.test("createExtensionListDeps retries once when the lockfile is caught mid-write", async () => {
  await withTempDir(async (dir) => {
    const managed = join(dir, "upstream_extensions.json");
    await Deno.writeTextFile(managed, "{ truncated");
    let retries = 0;
    const deps = await createExtensionListDeps(dir, managed, undefined, {
      // The writer finishes while the reader waits to retry.
      waitBeforeRetry: async () => {
        retries++;
        await Deno.writeTextFile(
          managed,
          JSON.stringify({ "@ns/team": { version: "1", pulledAt: "x" } }),
        );
      },
    });
    assertEquals(retries, 1);
    assertEquals((await listed(deps)).map((e) => e.name), ["@ns/team"]);
  });
});
