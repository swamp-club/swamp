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
import { EmbeddedDenoRuntime } from "../src/infrastructure/runtime/embedded_deno_runtime.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  linkSharedSwampDenoCache,
  SHARED_SWAMP_DENO_CACHE,
} from "./test_helpers.ts";

// Creating a symlink on Windows needs a privilege the helper may not have.
const ignore = Deno.build.os === "windows";

async function withSwampHome(
  fn: (home: string) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "swamp_3461_home_" });
  try {
    await fn(home);
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name:
    "linkSharedSwampDenoCache: the bundler's DENO_DIR under a mocked SWAMP_HOME is the shared cache",
  ignore,
  fn: async () => {
    await withSwampHome(async (home) => {
      await linkSharedSwampDenoCache(home);
      const denoDir = withMockedEnv(
        { SWAMP_HOME: home },
        () => new EmbeddedDenoRuntime().getDenoEnv().DENO_DIR,
      );
      assertEquals(
        await Deno.realPath(denoDir),
        await Deno.realPath(SHARED_SWAMP_DENO_CACHE),
      );
    });
  },
});

Deno.test({
  name:
    "linkSharedSwampDenoCache: removing the swamp home leaves the shared cache in place",
  ignore,
  fn: async () => {
    const sentinel = join(
      SHARED_SWAMP_DENO_CACHE,
      `.swamp-3461-${crypto.randomUUID()}`,
    );
    try {
      await withSwampHome(async (home) => {
        await linkSharedSwampDenoCache(home);
        await Deno.writeTextFile(sentinel, "");
      });
      assertEquals((await Deno.stat(sentinel)).isFile, true);
    } finally {
      await Deno.remove(sentinel).catch(() => {});
    }
  },
});
