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
import { workspaceCreate } from "./create.ts";
import { workspaceRemove } from "./remove.ts";
import { workspaceImport } from "./import.ts";
import { workspaceGet } from "./get.ts";
import { folderState } from "./workspace_store.ts";
import {
  completed,
  ctx,
  errorCode,
  errorOf,
  withWorkspaceFixture,
} from "./workspace_test_helpers.ts";

Deno.test("workspaceCreate: creates a repo under the data dir and registers it", async () => {
  await withWorkspaceFixture(async (f) => {
    const data = await completed(
      workspaceCreate(ctx, f.deps, { name: "prod" }),
    );
    const path = join(f.dataDir, "workspaces", "prod");
    assertEquals(data, { name: "prod", path });
    assertEquals(await f.deps.repo.isRepo(path), true);
    const registry = await f.deps.registry.load();
    assertEquals(registry?.get("prod")?.path, path);
    assertEquals(f.locks, ["prod"]);
  });
});

Deno.test("workspaceCreate: refuses an invalid name", async () => {
  await withWorkspaceFixture(async (f) => {
    assertEquals(
      await errorCode(workspaceCreate(ctx, f.deps, { name: "Bad Name" })),
      "invalid_name",
    );
  });
});

Deno.test("workspaceCreate: refuses a name that is registered", async () => {
  await withWorkspaceFixture(async (f) => {
    await completed(workspaceCreate(ctx, f.deps, { name: "prod" }));
    assertEquals(
      await errorCode(workspaceCreate(ctx, f.deps, { name: "prod" })),
      "name_taken",
    );
  });
});

Deno.test("workspaceCreate: refuses the folder a removed workspace left behind", async () => {
  await withWorkspaceFixture(async (f) => {
    const { path } = await completed(
      workspaceCreate(ctx, f.deps, { name: "prod" }),
    );
    await completed(workspaceRemove(ctx, f.deps, { name: "prod" }));
    assertEquals(
      await errorCode(workspaceCreate(ctx, f.deps, { name: "prod" })),
      "folder_exists",
    );
    assertEquals((await f.deps.registry.load())?.get("prod"), undefined);
    // Importing it brings it back.
    const back = await completed(workspaceImport(ctx, f.deps, { path }));
    assertEquals(back, { name: "prod", path, alreadyRegistered: false });
  });
});

Deno.test("workspaceCreate: refuses a data-dir folder imported under another name", async () => {
  await withWorkspaceFixture(async (f) => {
    // A registry exists, so the folder isn't adopted under its own name.
    await completed(workspaceCreate(ctx, f.deps, { name: "first" }));
    const path = join(f.dataDir, "workspaces", "prod");
    await f.makeRepo(path);
    await completed(workspaceImport(ctx, f.deps, { path, name: "other" }));
    const error = await errorOf(workspaceCreate(ctx, f.deps, { name: "prod" }));
    assertEquals(error.code, "folder_exists");
    assertStringIncludes(error.message, 'registered as the workspace "other"');
  });
});

Deno.test("workspaceCreate: refuses a folder that holds something else", async () => {
  await withWorkspaceFixture(async (f) => {
    // A registry exists, so nothing is adopted.
    await completed(workspaceCreate(ctx, f.deps, { name: "first" }));
    const path = join(f.dataDir, "workspaces", "prod");
    await Deno.mkdir(path, { recursive: true });
    await Deno.writeTextFile(join(path, "notes.txt"), "mine");
    assertEquals(
      await errorCode(workspaceCreate(ctx, f.deps, { name: "prod" })),
      "not_a_workspace",
    );
    assertEquals(await f.deps.repo.isRepo(path), false);
  });
});

Deno.test("workspaceCreate: an existing workspace folder is adopted by the first read, so its name is taken", async () => {
  await withWorkspaceFixture(async (f) => {
    // A folder `swamp start` made before the registry existed.
    await f.makeRepo(join(f.dataDir, "workspaces", "prod"));
    assertEquals(
      await errorCode(workspaceCreate(ctx, f.deps, { name: "prod" })),
      "name_taken",
    );
  });
});

Deno.test("workspaceCreate: fails when the name is registered elsewhere while the folder is made", async () => {
  await withWorkspaceFixture(async (f) => {
    await completed(workspaceCreate(ctx, f.deps, { name: "first" }));
    const elsewhere = join(f.dir, "code", "prod");
    await f.makeRepo(elsewhere);
    const init = f.deps.repo.init;
    const deps = {
      ...f.deps,
      repo: {
        ...f.deps.repo,
        // Another process imports a folder as "prod" meanwhile.
        init: async (path: string) => {
          await init(path);
          await completed(
            workspaceImport(ctx, f.deps, { path: elsewhere, name: "prod" }),
          );
        },
      },
    };
    const events = [];
    for await (const event of workspaceCreate(ctx, deps, { name: "prod" })) {
      events.push(event);
    }
    assertEquals(events.map((e) => e.kind), ["error"]);
    assertEquals((await f.deps.registry.load())?.get("prod")?.path, elsewhere);
    // The folder it made is removed, not left behind unregistered.
    assertEquals(
      await folderState(join(f.dataDir, "workspaces", "prod")),
      "missing",
    );
  });
});

Deno.test("workspaceCreate: --path creates the workspace in <dir>/<name>, registered as created", async () => {
  await withWorkspaceFixture(async (f) => {
    const parent = join(f.dir, "dev");
    await Deno.mkdir(parent);
    const data = await completed(
      workspaceCreate(ctx, f.deps, { name: "prod", parent }),
    );
    const path = join(parent, "prod");
    assertEquals(data, { name: "prod", path });
    assertEquals(await f.deps.repo.isRepo(path), true);
    const entry = (await f.deps.registry.load())?.get("prod");
    assertEquals(entry?.path, path);
    assertEquals(entry?.origin, "created");
    assertEquals(f.locks, ["prod"]);
    // Outside the data dir, but made by Swamp: not an import.
    const got = await completed(workspaceGet(ctx, f.deps, { name: "prod" }));
    assertEquals(got.imported, false);
  });
});

Deno.test("workspaceCreate: a relative --path is taken from relativeTo, ~ from the home folder", async () => {
  await withWorkspaceFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "dev"));
    const relative = await completed(
      workspaceCreate(ctx, f.deps, {
        name: "one",
        parent: "dev",
        relativeTo: f.dir,
      }),
    );
    assertEquals(relative.path, join(f.dir, "dev", "one"));
    const home = await completed(
      workspaceCreate(ctx, f.deps, { name: "two", parent: "~/dev" }),
    );
    assertEquals(home.path, join(f.dir, "dev", "two"));
  });
});

Deno.test("workspaceCreate: refuses a relative --path with nothing to resolve it against", async () => {
  await withWorkspaceFixture(async (f) => {
    assertEquals(
      await errorCode(
        workspaceCreate(ctx, f.deps, { name: "prod", parent: "dev" }),
      ),
      "parent_not_absolute",
    );
  });
});

Deno.test("workspaceCreate: refuses a --path that is missing or not a folder, creating nothing", async () => {
  await withWorkspaceFixture(async (f) => {
    const missing = join(f.dir, "nope");
    assertEquals(
      await errorCode(
        workspaceCreate(ctx, f.deps, { name: "prod", parent: missing }),
      ),
      "parent_not_found",
    );
    assertEquals(await folderState(missing), "missing");
    const file = join(f.dir, "file.txt");
    await Deno.writeTextFile(file, "x");
    assertEquals(
      await errorCode(
        workspaceCreate(ctx, f.deps, { name: "prod", parent: file }),
      ),
      "parent_not_a_folder",
    );
    assertEquals(await f.deps.registry.load(), null);
  });
});

Deno.test("workspaceCreate: refuses a folder at the chosen location that holds something else or an unregistered repo", async () => {
  await withWorkspaceFixture(async (f) => {
    const parent = join(f.dir, "dev");
    await Deno.mkdir(join(parent, "busy"), { recursive: true });
    await Deno.writeTextFile(join(parent, "busy", "notes.txt"), "x");
    assertEquals(
      await errorCode(
        workspaceCreate(ctx, f.deps, { name: "busy", parent }),
      ),
      "not_a_workspace",
    );
    await f.makeRepo(join(parent, "old"));
    const error = await errorOf(
      workspaceCreate(ctx, f.deps, { name: "old", parent }),
    );
    assertEquals(error.code, "folder_exists");
    assertStringIncludes(error.message, "swamp workspace import");
  });
});

Deno.test("workspaceCreate: uses the configured folder when no --path is given", async () => {
  await withWorkspaceFixture(async (f) => {
    const parent = join(f.dir, "projects");
    await Deno.mkdir(parent);
    f.configure(parent);
    const data = await completed(
      workspaceCreate(ctx, f.deps, { name: "prod" }),
    );
    assertEquals(data.path, join(parent, "prod"));
    // --path still wins over the setting.
    const other = join(f.dir, "other");
    await Deno.mkdir(other);
    const chosen = await completed(
      workspaceCreate(ctx, f.deps, { name: "dev", parent: other }),
    );
    assertEquals(chosen.path, join(other, "dev"));
  });
});

Deno.test("workspaceCreate: a configured folder that is gone says how to reset it", async () => {
  await withWorkspaceFixture(async (f) => {
    f.configure(join(f.dir, "gone"));
    const error = await errorOf(workspaceCreate(ctx, f.deps, { name: "prod" }));
    assertEquals(error.code, "parent_not_found");
    assertStringIncludes(
      error.message,
      "swamp config set workspaces.dir default",
    );
  });
});

Deno.test("workspaceCreate: --path naming the data dir's own folder creates it there as the default", async () => {
  await withWorkspaceFixture(async (f) => {
    const root = join(f.dataDir, "workspaces");
    await Deno.mkdir(root, { recursive: true });
    const data = await completed(
      workspaceCreate(ctx, f.deps, { name: "prod", parent: root }),
    );
    assertEquals(data.path, join(root, "prod"));
  });
});

Deno.test({
  name: "workspaceCreate: a --path through a symlink registers the real folder",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withWorkspaceFixture(async (f) => {
      const real = join(f.dir, "real");
      await Deno.mkdir(real);
      const link = join(f.dir, "link");
      await Deno.symlink(real, link, { type: "dir" });
      const data = await completed(
        workspaceCreate(ctx, f.deps, { name: "prod", parent: link }),
      );
      assertEquals(data.path, join(real, "prod"));
      assertEquals(
        (await f.deps.registry.load())?.get("prod")?.path,
        join(real, "prod"),
      );
    });
  },
});

Deno.test("workspaceCreate: a failed registration removes a folder it made but keeps an empty one the user made", async () => {
  await withWorkspaceFixture(async (f) => {
    const parent = join(f.dir, "dev");
    await Deno.mkdir(join(parent, "mine"), { recursive: true });
    const real = f.deps.registry;
    let registering = false;
    const deps = {
      ...f.deps,
      registry: {
        load: () => real.load(),
        update: <T>(change: Parameters<typeof real.update<T>>[0]) => {
          if (registering) return Promise.reject(new Error("registry busy"));
          return real.update(change);
        },
      },
      repo: {
        ...f.deps.repo,
        init: async (path: string) => {
          await f.makeRepo(path);
          registering = true;
        },
      },
    };
    await assertRejects(() =>
      completed(workspaceCreate(ctx, deps, { name: "fresh", parent }))
    );
    assertEquals(await folderState(join(parent, "fresh")), "missing");
    registering = false;
    await assertRejects(() =>
      completed(workspaceCreate(ctx, deps, { name: "mine", parent }))
    );
    assertEquals(await folderState(join(parent, "mine")), "empty");
  });
});

Deno.test("workspaceCreate: refuses an over-long --path with its own code", async () => {
  await withWorkspaceFixture(async (f) => {
    assertEquals(
      await errorCode(
        workspaceCreate(ctx, f.deps, {
          name: "prod",
          parent: "/" + "a".repeat(5000),
        }),
      ),
      "parent_too_long",
    );
  });
});
