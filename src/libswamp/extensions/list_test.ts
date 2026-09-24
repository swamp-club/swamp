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

Deno.test("createExtensionListDeps reads the given managed lockfile", async () => {
  await withTempDir(async (dir) => {
    const managed = join(dir, "cache", "upstream_extensions.json");
    await Deno.mkdir(join(dir, "cache"), { recursive: true });
    await Deno.writeTextFile(
      managed,
      JSON.stringify({ "@ns/team": { version: "1", pulledAt: "x" } }),
    );
    // The models-dir lockfile is not the managed one and is ignored.
    await Deno.mkdir(join(dir, "extensions", "models"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "extensions", "models", "upstream_extensions.json"),
      JSON.stringify({ "@ns/stale": { version: "2", pulledAt: "y" } }),
    );
    const exts = await listed(await createExtensionListDeps(managed));
    assertEquals(exts.map((e) => [e.name, e.version]), [["@ns/team", "1"]]);
  });
});

Deno.test("createExtensionListDeps retries once when the lockfile is caught mid-write", async () => {
  await withTempDir(async (dir) => {
    const managed = join(dir, "upstream_extensions.json");
    await Deno.writeTextFile(managed, "{ truncated");
    let retries = 0;
    const deps = await createExtensionListDeps(managed, {
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
