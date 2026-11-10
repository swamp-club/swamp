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
import { fromFileUrl, join } from "@std/path";
import { assertPathEquals } from "../persistence/path_test_helpers.ts";
import {
  findResourceRoot,
  resourcePath,
  resourceRoot,
  resourceRootUrl,
} from "./resource_root.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-resource-root-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't released a handle yet.
      // Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("findResourceRoot: resolves the same root from start directories at two depths", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, ".claude", "skills"), { recursive: true });
    const shallow = join(dir, "src");
    const deep = join(dir, "src", "infrastructure", "runtime", "chunks");
    await Deno.mkdir(deep, { recursive: true });

    assertPathEquals(findResourceRoot(shallow), dir);
    assertPathEquals(findResourceRoot(deep), dir);
  });
});

Deno.test("findResourceRoot: the nearest ancestor holding the marker wins", async () => {
  await withTempDir(async (dir) => {
    const inner = join(dir, "nested");
    await Deno.mkdir(join(dir, ".claude", "skills"), { recursive: true });
    await Deno.mkdir(join(inner, ".claude", "skills"), { recursive: true });
    const start = join(inner, "src", "serve");
    await Deno.mkdir(start, { recursive: true });

    assertPathEquals(findResourceRoot(start), inner);
  });
});

Deno.test("findResourceRoot: a file named .claude/skills is not the marker", async () => {
  await withTempDir(async (dir) => {
    const inner = join(dir, "nested");
    await Deno.mkdir(join(dir, ".claude", "skills"), { recursive: true });
    await Deno.mkdir(join(inner, ".claude"), { recursive: true });
    await Deno.writeTextFile(join(inner, ".claude", "skills"), "");

    assertPathEquals(findResourceRoot(inner), dir);
  });
});

Deno.test("findResourceRoot: a file named .claude does not stop the walk", async () => {
  await withTempDir(async (dir) => {
    const inner = join(dir, "nested");
    await Deno.mkdir(join(dir, ".claude", "skills"), { recursive: true });
    await Deno.mkdir(inner, { recursive: true });
    await Deno.writeTextFile(join(inner, ".claude"), "");

    assertPathEquals(findResourceRoot(inner), dir);
  });
});

Deno.test("resourceRoot: resolves to the repository root holding .claude/skills", () => {
  const repoRoot = fromFileUrl(new URL("../../../", import.meta.url));
  assertPathEquals(
    join(resourceRoot(), "deno.json"),
    join(repoRoot, "deno.json"),
  );
  assertPathEquals(
    resourcePath(".claude", "skills"),
    join(repoRoot, ".claude", "skills"),
  );
});

Deno.test("resourceRootUrl: matches the source root the unscoped-write diagnostic used before", () => {
  assertEquals(resourceRootUrl(), new URL("../../../", import.meta.url).href);
});
