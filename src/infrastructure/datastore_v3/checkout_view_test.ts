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
import { join, resolve } from "@std/path";
import {
  alignCheckoutView,
  CHECKOUT_VIEW_FILE,
  type CheckoutView,
  checkoutViewOf,
} from "./checkout_view.ts";
import { readModelStateDir } from "./record_path_guard.ts";
import type { V3Datastore } from "./v3_datastore.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-checkout-view-" });
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

function countingHandle(failures = 0): V3Datastore & { rebuilds: number } {
  const handle = {
    datastorePath: "/unused",
    rebuilds: 0,
    recoverInterruptedWriter(since: number) {
      assertEquals(since, 0);
      handle.rebuilds++;
      return handle.rebuilds <= failures
        ? Promise.reject(new Error("rebuild failed"))
        : Promise.resolve([]);
    },
  };
  return handle as unknown as V3Datastore & { rebuilds: number };
}

const SOLO: CheckoutView = {
  kind: "solo",
  datastore: "/data/store",
  namespace: "",
};
const SERVE: Extract<CheckoutView, { kind: "serve" }> = {
  kind: "serve",
  root: "/repo/.swamp/_datastore_v3_copies/serve-1",
  copy: "c".repeat(32),
  caller: "a".repeat(64),
  serverUrl: "http://serve.example.com",
};

Deno.test("alignCheckoutView: a checkout with no view recorded keeps its solo projection, and stamps it", async () => {
  await withTempDir(async (repoDir) => {
    const handle = countingHandle();
    await alignCheckoutView(repoDir, handle, SOLO, { holdsWriterLock: true });
    await alignCheckoutView(repoDir, handle, SOLO, { holdsWriterLock: true });
    assertEquals(handle.rebuilds, 0);
    await alignCheckoutView(repoDir, handle, SERVE, { holdsWriterLock: true });
    assertEquals(handle.rebuilds, 1);
  });
});

Deno.test("alignCheckoutView: a serve view rebuilds a checkout with no view recorded once", async () => {
  await withTempDir(async (repoDir) => {
    const handle = countingHandle();
    await alignCheckoutView(repoDir, handle, SERVE, { holdsWriterLock: true });
    await alignCheckoutView(repoDir, handle, SERVE, { holdsWriterLock: true });
    assertEquals(handle.rebuilds, 1);
  });
});

Deno.test("alignCheckoutView: another caller, copy or datastore rebuilds; switching back rebuilds again", async () => {
  await withTempDir(async (repoDir) => {
    const handle = countingHandle();
    const views: CheckoutView[] = [
      SERVE,
      { ...SERVE, caller: "b".repeat(64) },
      {
        ...SERVE,
        root: "/repo/.swamp/_datastore_v3_copies/serve-2",
        copy: "d".repeat(32),
      },
      SOLO,
      { ...SOLO, namespace: "team" },
      SERVE,
    ];
    for (const view of views) {
      await alignCheckoutView(repoDir, handle, view, { holdsWriterLock: true });
    }
    assertEquals(handle.rebuilds, views.length);
    await alignCheckoutView(
      repoDir,
      handle,
      { ...SERVE, serverUrl: "http://alias.example.com" },
      { holdsWriterLock: true },
    );
    assertEquals(handle.rebuilds, views.length);
  });
});

Deno.test("alignCheckoutView: a serve view recorded before copies had ids rebuilds once (swamp-club#4049)", async () => {
  await withTempDir(async (repoDir) => {
    const handle = countingHandle();
    const { copy: _copy, ...withoutCopy } = SERVE;
    await Deno.mkdir(readModelStateDir(repoDir), { recursive: true });
    await Deno.writeTextFile(
      join(readModelStateDir(repoDir), CHECKOUT_VIEW_FILE),
      JSON.stringify({ view: withoutCopy }),
    );
    await alignCheckoutView(repoDir, handle, SERVE, { holdsWriterLock: true });
    await alignCheckoutView(repoDir, handle, SERVE, { holdsWriterLock: true });
    assertEquals(handle.rebuilds, 1);
  });
});

Deno.test("alignCheckoutView: a rebuild that failed runs again, even for the view it was for", async () => {
  await withTempDir(async (repoDir) => {
    const handle = countingHandle(1);
    await alignCheckoutView(repoDir, handle, SOLO, { holdsWriterLock: true });
    await assertRejects(() =>
      alignCheckoutView(repoDir, handle, SERVE, { holdsWriterLock: true })
    );
    await alignCheckoutView(repoDir, handle, SERVE, { holdsWriterLock: true });
    assertEquals(handle.rebuilds, 2);
    await alignCheckoutView(repoDir, handle, SERVE, { holdsWriterLock: true });
    assertEquals(handle.rebuilds, 2);
  });
});

async function recordedView(repoDir: string): Promise<CheckoutView> {
  return JSON.parse(
    await Deno.readTextFile(
      join(readModelStateDir(repoDir), CHECKOUT_VIEW_FILE),
    ),
  ).view;
}

Deno.test("alignCheckoutView: a serve copy moved with its checkout keeps its view, and the record follows the move (swamp-club#4702)", async () => {
  await withTempDir(async (repoDir) => {
    const handle = countingHandle();
    await alignCheckoutView(repoDir, handle, SERVE, { holdsWriterLock: true });
    assertEquals(handle.rebuilds, 1);
    const moved = {
      ...SERVE,
      root: "/moved/.swamp/_datastore_v3_copies/serve-1",
    };
    await alignCheckoutView(repoDir, handle, moved, { holdsWriterLock: true });
    assertEquals(handle.rebuilds, 1);
    assertEquals(await recordedView(repoDir), moved);
    await alignCheckoutView(
      repoDir,
      handle,
      { ...moved, copy: "e".repeat(32) },
      {
        holdsWriterLock: true,
      },
    );
    assertEquals(handle.rebuilds, 2);
  });
});

Deno.test("alignCheckoutView: a serve view keeps the principal serve named when a later view does not carry it (swamp-club#4702)", async () => {
  await withTempDir(async (repoDir) => {
    const handle = countingHandle();
    await alignCheckoutView(
      repoDir,
      handle,
      { ...SERVE, principal: "user:1" },
      {
        holdsWriterLock: true,
      },
    );
    const moved = { ...SERVE, root: "/moved/serve-1" };
    await alignCheckoutView(repoDir, handle, moved, { holdsWriterLock: true });
    assertEquals(handle.rebuilds, 1);
    assertEquals(await recordedView(repoDir), {
      ...moved,
      principal: "user:1",
    });
  });
});

const KEYED: CheckoutView = {
  kind: "solo",
  datastore: "/repo/.swamp",
  namespace: "",
  repoId: "11111111-2222-4333-8444-555555555555",
  location: ".swamp",
};

Deno.test("alignCheckoutView: a solo checkout moved with its datastore keeps its view; another repo, location or namespace rebuilds (swamp-club#4702)", async () => {
  await withTempDir(async (repoDir) => {
    const handle = countingHandle();
    await alignCheckoutView(repoDir, handle, KEYED, { holdsWriterLock: true });
    const moved = { ...KEYED, datastore: "/moved/.swamp" };
    await alignCheckoutView(repoDir, handle, moved, { holdsWriterLock: true });
    assertEquals(handle.rebuilds, 0);
    assertEquals(await recordedView(repoDir), moved);
    const others: CheckoutView[] = [
      { ...moved, repoId: "99999999-2222-4333-8444-555555555555" },
      { ...moved, location: "/elsewhere/store", datastore: "/elsewhere/store" },
      {
        ...moved,
        location: "/elsewhere/store",
        datastore: "/elsewhere/store",
        namespace: "team",
      },
    ];
    for (const view of others) {
      await alignCheckoutView(repoDir, handle, view, { holdsWriterLock: true });
    }
    assertEquals(handle.rebuilds, others.length);
  });
});

Deno.test("alignCheckoutView: a solo view without a repoId is its path, so moving it rebuilds (swamp-club#4702)", async () => {
  await withTempDir(async (repoDir) => {
    const handle = countingHandle();
    await alignCheckoutView(repoDir, handle, SOLO, { holdsWriterLock: true });
    await alignCheckoutView(repoDir, handle, {
      ...SOLO,
      datastore: "/moved/store",
    }, {
      holdsWriterLock: true,
    });
    assertEquals(handle.rebuilds, 1);
  });
});

Deno.test("alignCheckoutView: a solo view recorded before repoIds were kept is upgraded in place, not rebuilt (swamp-club#4702)", async () => {
  await withTempDir(async (repoDir) => {
    const handle = countingHandle();
    await Deno.mkdir(readModelStateDir(repoDir), { recursive: true });
    await Deno.writeTextFile(
      join(readModelStateDir(repoDir), CHECKOUT_VIEW_FILE),
      JSON.stringify({
        view: { kind: "solo", datastore: KEYED.datastore, namespace: "" },
      }),
    );
    await alignCheckoutView(repoDir, handle, KEYED, { holdsWriterLock: true });
    assertEquals(handle.rebuilds, 0);
    assertEquals(await recordedView(repoDir), KEYED);
    await alignCheckoutView(repoDir, handle, {
      ...KEYED,
      datastore: "/moved/.swamp",
    }, {
      holdsWriterLock: true,
    });
    assertEquals(handle.rebuilds, 0);
  });
});

Deno.test("checkoutViewOf: a solo datastore inside the checkout is keyed by its relative location, one outside by its path (swamp-club#4702)", () => {
  const repoId = KEYED.repoId!;
  const inside = checkoutViewOf(
    join("/a", "repo", ".swamp"),
    "",
    undefined,
    undefined,
    {
      repoDir: join("/a", "repo"),
      repoId,
    },
  );
  const movedInside = checkoutViewOf(
    join("/b", "r2", ".swamp"),
    "",
    undefined,
    undefined,
    {
      repoDir: join("/b", "r2"),
      repoId,
    },
  );
  assertEquals(inside.kind === "solo" && inside.location, ".swamp");
  assertEquals(movedInside.kind === "solo" && movedInside.location, ".swamp");
  const outside = checkoutViewOf(
    join("/a", "shared"),
    "",
    undefined,
    undefined,
    {
      repoDir: join("/a", "repo"),
      repoId,
    },
  );
  assertEquals(
    outside.kind === "solo" && outside.location,
    resolve(join("/a", "shared")),
  );
  const noId = checkoutViewOf(
    join("/a", "repo", ".swamp"),
    "",
    undefined,
    undefined,
    {
      repoDir: join("/a", "repo"),
    },
  );
  assertEquals(noId.kind === "solo" && noId.repoId, undefined);
});

Deno.test("alignCheckoutView: a solo record from before repoIds were kept, moved with its checkout, keeps its view and is upgraded; one elsewhere in the checkout rebuilds (swamp-club#4702)", async () => {
  const oldShape = (datastore: string) => ({
    view: { kind: "solo", datastore, namespace: "" },
  });
  const moved: CheckoutView = {
    ...KEYED,
    datastore: "/moved/.swamp",
    location: ".swamp",
  };
  for (
    const [label, recorded, view, rebuilds] of [
      ["moved, same place", "/repo/.swamp", moved, 0],
      ["moved, another place", "/repo/other", moved, 1],
      ["at the checkout's root", "/repo", {
        ...moved,
        datastore: "/moved",
        location: "",
      }, 1],
    ] as const
  ) {
    await withTempDir(async (repoDir) => {
      const handle = countingHandle();
      await Deno.mkdir(readModelStateDir(repoDir), { recursive: true });
      await Deno.writeTextFile(
        join(readModelStateDir(repoDir), CHECKOUT_VIEW_FILE),
        JSON.stringify(oldShape(recorded)),
      );
      await alignCheckoutView(repoDir, handle, view, { holdsWriterLock: true });
      assertEquals(handle.rebuilds, rebuilds, label);
      assertEquals(await recordedView(repoDir), view, label);
    });
  }
});

Deno.test({
  name:
    "alignCheckoutView: a solo record from before repoIds were kept whose path still holds another datastore rebuilds; one reaching this datastore by another path keeps its view (swamp-club#4702)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (root) => {
      const here = join(root, "here");
      const other = join(root, "other");
      for (const dir of [here, other]) {
        await Deno.mkdir(join(dir, ".swamp"), { recursive: true });
      }
      const alias = join(root, "alias");
      await Deno.symlink(here, alias, { type: "dir" });
      const view: CheckoutView = {
        ...KEYED,
        datastore: join(here, ".swamp"),
        location: ".swamp",
      };
      for (
        const [label, recorded, rebuilds] of [
          ["another datastore still there", join(other, ".swamp"), 1],
          ["this datastore by another path", join(alias, ".swamp"), 0],
        ] as const
      ) {
        const repoDir = join(root, `repo-${rebuilds}`);
        const handle = countingHandle();
        await Deno.mkdir(readModelStateDir(repoDir), { recursive: true });
        await Deno.writeTextFile(
          join(readModelStateDir(repoDir), CHECKOUT_VIEW_FILE),
          JSON.stringify({
            view: { kind: "solo", datastore: recorded, namespace: "" },
          }),
        );
        await alignCheckoutView(repoDir, handle, view, {
          holdsWriterLock: true,
        });
        assertEquals(handle.rebuilds, rebuilds, label);
      }
    });
  },
});

Deno.test({
  name:
    "alignCheckoutView: a current view whose record cannot be rewritten (a read-only checkout) still aligns, and a recorded path that cannot be read rebuilds rather than failing (swamp-club#4702)",
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withTempDir(async (root) => {
      const stateDir = readModelStateDir(join(root, "readonly"));
      await Deno.mkdir(stateDir, { recursive: true });
      await Deno.writeTextFile(
        join(stateDir, CHECKOUT_VIEW_FILE),
        JSON.stringify({ view: SOLO }),
      );
      await Deno.chmod(stateDir, 0o555);
      try {
        const handle = countingHandle();
        await alignCheckoutView(
          join(root, "readonly"),
          handle,
          { ...SOLO, repoId: KEYED.repoId, location: "store" },
          { holdsWriterLock: true },
        );
        assertEquals(handle.rebuilds, 0);
      } finally {
        await Deno.chmod(stateDir, 0o755);
      }

      const sealed = join(root, "sealed");
      await Deno.mkdir(join(sealed, "old", ".swamp"), { recursive: true });
      await Deno.chmod(sealed, 0o000);
      try {
        const repoDir = join(root, "repo");
        await Deno.mkdir(readModelStateDir(repoDir), { recursive: true });
        await Deno.writeTextFile(
          join(readModelStateDir(repoDir), CHECKOUT_VIEW_FILE),
          JSON.stringify({
            view: {
              kind: "solo",
              datastore: join(sealed, "old", ".swamp"),
              namespace: "",
            },
          }),
        );
        const handle = countingHandle();
        await alignCheckoutView(repoDir, handle, {
          ...KEYED,
          datastore: join(root, "here", ".swamp"),
          location: ".swamp",
        }, { holdsWriterLock: true });
        assertEquals(handle.rebuilds, 1);
      } finally {
        await Deno.chmod(sealed, 0o755);
      }
    });
  },
});
