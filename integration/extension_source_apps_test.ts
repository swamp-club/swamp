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
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { resolveMountedSourceRoots } from "../src/infrastructure/persistence/swamp_sources_repository.ts";
import { FilesystemAppCatalog } from "../src/infrastructure/persistence/filesystem_app_catalog.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createSourceAddDeps, sourceAdd } from "../src/libswamp/sources/add.ts";
import {
  createSourceListDeps,
  sourceList,
} from "../src/libswamp/sources/list.ts";

await initializeLogging({});

const ctx = createLibSwampContext({});

Deno.test("source add: an apps-only extension is mounted and its app is catalogued", async () => {
  const root = await Deno.makeTempDir({ prefix: "swamp_source_apps_" });
  try {
    const repo = join(root, "repo");
    const ext = join(root, "apps-ext");
    await Deno.mkdir(repo, { recursive: true });
    const appDir = join(ext, "extensions", "apps", "hello");
    await Deno.mkdir(appDir, { recursive: true });
    await Deno.writeTextFile(
      join(appDir, "app.yaml"),
      'name: "@acme/hello"\ntitle: Hello\nbridge: 1\ncapabilities: [runs:read]\n',
    );

    const addDeps = await createSourceAddDeps(repo, undefined, []);
    const added = [];
    for await (const event of sourceAdd(ctx, addDeps, ext)) added.push(event);
    assertEquals(added.at(-1)?.kind, "completed");

    const catalog = new FilesystemAppCatalog({
      repoDir: repo,
      sourceDirs: () => resolveMountedSourceRoots(repo),
    });
    const { apps, problems } = await catalog.list();
    assertEquals(problems, []);
    assertEquals(
      apps.map((app) => [app.descriptor.name, app.origin]),
      [["@acme/hello", "source"]],
    );

    const listed = [];
    for await (
      const event of sourceList(ctx, await createSourceListDeps(repo))
    ) {
      listed.push(event);
    }
    const completed = listed.at(-1);
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.sources[0].status, "valid");
      assertEquals(completed.data.sources[0].hasApps, true);
    }
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
