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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { consumeStream } from "../src/libswamp/stream.ts";
import {
  appApprove,
  type AppDeps,
  appLaunch,
  type AppLaunchData,
  appList,
  type AppListData,
  appRevoke,
} from "../src/libswamp/apps/apps.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { APP_SOURCE_DIR } from "../src/domain/apps/app_descriptor.ts";
import type { AppLaunchKey } from "../src/domain/apps/app_launch.ts";
import { initializeControlPlaneVault } from "../src/domain/vaults/control_plane_vault_init.ts";
import { ControlPlaneAppApprovalRepository } from "../src/infrastructure/persistence/control_plane_app_store.ts";
import { FilesystemAppCatalog } from "../src/infrastructure/persistence/filesystem_app_catalog.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { serveAppRoute } from "../src/serve/app_assets.ts";
import {
  APP_LAUNCH_KEY_SECRET,
  VaultAppLaunchKey,
} from "../src/serve/app_launch_key.ts";

const ctx = createLibSwampContext();

type ServeAppDeps = AppDeps & { launchKey: AppLaunchKey };

async function withInstance(
  body: (
    one: ServeAppDeps,
    two: ServeAppDeps,
    repoDir: string,
  ) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir();
  try {
    const app = join(repoDir, APP_SOURCE_DIR, "cost");
    await Deno.mkdir(join(app, "dist"), { recursive: true });
    await Deno.writeTextFile(
      join(app, "app.yaml"),
      'name: "@acme/cost"\ntitle: Cost\nbridge: 1\ncapabilities: [runs:read]\n',
    );
    await Deno.writeTextFile(join(app, "dist", "index.html"), "<html>");
    // each serve opens the shared control plane on its own
    const instance = async (at: string): Promise<ServeAppDeps> => {
      const store = new FileSystemControlPlaneStore(join(repoDir, ".swamp"));
      const { provider } = await initializeControlPlaneVault(store, false);
      return {
        catalog: new FilesystemAppCatalog({ repoDir }),
        approvals: new ControlPlaneAppApprovalRepository(store),
        launchKey: new VaultAppLaunchKey(provider),
        now: () => new Date(at),
      };
    };
    // apart by a minute, so an approval on each is a different approval
    await body(
      await instance("2026-11-04T00:00:00.000Z"),
      await instance("2026-11-04T00:01:00.000Z"),
      repoDir,
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

async function list(deps: AppDeps): Promise<AppListData> {
  let data: AppListData | undefined;
  await consumeStream(appList(ctx, deps), {
    completed: (e) => {
      data = e.data;
    },
    error: (e) => {
      throw new Error(e.error.message);
    },
  });
  return data!;
}

async function launch(deps: ServeAppDeps): Promise<AppLaunchData> {
  let data: AppLaunchData | undefined;
  await consumeStream(appLaunch(ctx, deps, { name: "@acme/cost" }), {
    completed: (e) => {
      data = e.data;
    },
    error: (e) => {
      throw new Error(e.error.message);
    },
  });
  return data!;
}

async function approve(deps: AppDeps, capabilityKey?: string): Promise<void> {
  await consumeStream(
    appApprove(ctx, deps, {
      name: "@acme/cost",
      approvedBy: "user:operator",
      capabilityKey,
    }),
    {
      completed: () => {},
      error: (e) => {
        throw new Error(e.error.message);
      },
    },
  );
}

async function revoke(deps: AppDeps): Promise<void> {
  await consumeStream(appRevoke(ctx, deps, { name: "@acme/cost" }), {
    completed: () => {},
    error: (e) => {
      throw new Error(e.error.message);
    },
  });
}

function fetchFile(deps: ServeAppDeps, url: string) {
  return serveAppRoute(new Request(`http://serve.test${url}`), deps);
}

Deno.test("apps: an installed app stays off until approved", async () => {
  await withInstance(async (one) => {
    assertEquals((await list(one)).apps[0].state, "pending");
    let refused = "";
    await launch(one).catch((error: Error) => {
      refused = error.message;
    });
    assert(refused.includes("not enabled"));
  });
});

Deno.test("apps: an approval on one instance applies on the other", async () => {
  await withInstance(async (one, two) => {
    await approve(one);
    assertEquals((await list(two)).apps[0].state, "enabled");
    const { url } = await launch(two);
    assertEquals((await fetchFile(one, url))?.status, 200);
  });
});

Deno.test("apps: a launch signed on one instance opens on the other with one shared key", async () => {
  await withInstance(async (one, two, repoDir) => {
    await approve(one);
    const first = await launch(one);
    const second = await launch(two);
    assertEquals((await fetchFile(two, first.url))?.status, 200);
    assertEquals((await fetchFile(one, second.url))?.status, 200);
    const store = new FileSystemControlPlaneStore(join(repoDir, ".swamp"));
    const { provider } = await initializeControlPlaneVault(store, false);
    assertEquals(
      (await provider.list()).filter((name) => name === APP_LAUNCH_KEY_SECRET)
        .length,
      1,
    );
  });
});

Deno.test("apps: a launch from before a revoke stays dead after the app is approved again", async () => {
  await withInstance(async (one, two) => {
    await approve(one);
    const { url } = await launch(one);
    await revoke(two);
    await approve(two);
    assertEquals((await fetchFile(one, url))?.status, 404);
    assertEquals((await fetchFile(one, (await launch(two)).url))?.status, 200);
  });
});

Deno.test("apps: a revoke on one instance stops a frame on the other at once", async () => {
  await withInstance(async (one, two) => {
    await approve(one);
    const { url } = await launch(one);
    assertEquals((await fetchFile(two, url))?.status, 200);
    await revoke(two);
    assertEquals((await fetchFile(one, url))?.status, 404);
    assertEquals((await list(one)).apps[0].state, "pending");
  });
});

Deno.test("apps: a code update with the same capabilities stays enabled", async () => {
  await withInstance(async (one, _two, repoDir) => {
    await approve(one);
    await Deno.writeTextFile(
      join(repoDir, APP_SOURCE_DIR, "cost", "dist", "index.html"),
      "<html>new build",
    );
    assertEquals((await list(one)).apps[0].state, "enabled");
  });
});

Deno.test("apps: a new capability goes back for review and stops serving", async () => {
  await withInstance(async (one, _two, repoDir) => {
    await approve(one);
    const { url } = await launch(one);
    await Deno.writeTextFile(
      join(repoDir, APP_SOURCE_DIR, "cost", "app.yaml"),
      'name: "@acme/cost"\ntitle: Cost\nbridge: 1\ncapabilities: [runs:read, data:read]\n',
    );
    assertEquals((await list(one)).apps[0].state, "changed");
    assertEquals((await fetchFile(one, url))?.status, 404);
  });
});

Deno.test("apps: an approval for what an operator saw is refused if it changed", async () => {
  await withInstance(async (one) => {
    let refused = "";
    await approve(one, "stale").catch((error: Error) => {
      refused = error.message;
    });
    assert(refused.includes("changed what it asks for"));
    assertEquals((await list(one)).apps[0].state, "pending");
  });
});
