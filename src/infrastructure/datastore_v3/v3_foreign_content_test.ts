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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import { swampPath } from "../persistence/paths.ts";
import { v3ForeignContentFetcher } from "./v3_foreign_content.ts";

const KEY = "data/test/model/m-1/state/1/raw";

async function withCheckout(
  fn: (repoDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-v3-foreign-" });
  try {
    await fn(repoDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

async function plant(root: string, text: string): Promise<string> {
  const path = join(root, ...KEY.split("/"));
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, text);
  return path;
}

Deno.test("v3ForeignContentFetcher: a record the read model could not materialise throws its error, even over a file at its path", async () => {
  await withCheckout(async (repoDir) => {
    const path = await plant(swampPath(repoDir, "beta"), "stale");
    const asked: string[] = [];
    const unreadable = new UserError(
      "record unreadable",
      "datastore_v3_record_unreadable",
    );
    const fetcher = v3ForeignContentFetcher(
      repoDir,
      { namespace: "alpha" },
      (absPath) => {
        asked.push(absPath);
        return Promise.resolve(unreadable);
      },
    );

    const error = await assertRejects(() => fetcher("beta", KEY), UserError);
    assertEquals(error, unreadable);
    assertEquals(asked, [path]);
  });
});

Deno.test("v3ForeignContentFetcher: reads the namespace's file when the lookup knows no unreadable record, and null when it is absent", async () => {
  await withCheckout(async (repoDir) => {
    await plant(swampPath(repoDir, "beta"), "beta");
    const fetcher = v3ForeignContentFetcher(
      repoDir,
      { namespace: "alpha" },
      () => Promise.resolve(undefined),
    );

    assertEquals(
      new TextDecoder().decode((await fetcher("beta", KEY))!),
      "beta",
    );
    assertEquals(await fetcher("gamma", KEY), null);
    assertEquals(fetcher.readsSoloNamespace, true);
  });
});

Deno.test("v3ForeignContentFetcher: a refused namespace or key never reaches the lookup", async () => {
  await withCheckout(async (repoDir) => {
    let asked = 0;
    const fetcher = v3ForeignContentFetcher(
      repoDir,
      { namespace: "alpha", directories: ["data"] },
      () => {
        asked++;
        return Promise.resolve(undefined);
      },
    );

    assertEquals(await fetcher("data", KEY), null, "reserved namespace");
    assertEquals(await fetcher("beta", "../x"), null, "unsafe key");
    assertEquals(
      await fetcher("", "workflow-runs/x/y.yaml"),
      null,
      "a solo key outside this checkout's directories",
    );
    assertEquals(
      await fetcher("beta", "_read_model_v3/_catalog_v3.db"),
      null,
      "a key the read model never materialises",
    );
    assertEquals(asked, 0);
  });
});
