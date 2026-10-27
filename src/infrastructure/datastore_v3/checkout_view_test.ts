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
import { alignCheckoutView, type CheckoutView } from "./checkout_view.ts";
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

/** A handle that counts its rebuilds, failing the first `failures`. */
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
const SERVE: CheckoutView = {
  kind: "serve",
  root: "/repo/.swamp/_datastore_v3_copies/serve-1",
  caller: "a".repeat(64),
  serverUrl: "http://serve.example.com",
};

Deno.test("alignCheckoutView: a checkout with no view recorded keeps its solo projection, and stamps it", async () => {
  await withTempDir(async (repoDir) => {
    const handle = countingHandle();
    await alignCheckoutView(repoDir, handle, SOLO, { holdsWriterLock: true });
    await alignCheckoutView(repoDir, handle, SOLO, { holdsWriterLock: true });
    assertEquals(handle.rebuilds, 0);
    // Stamped: another view now rebuilds.
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

Deno.test("alignCheckoutView: another caller, root or datastore rebuilds; switching back rebuilds again", async () => {
  await withTempDir(async (repoDir) => {
    const handle = countingHandle();
    const views: CheckoutView[] = [
      SERVE,
      { ...SERVE, caller: "b".repeat(64) },
      { ...SERVE, root: "/repo/.swamp/_datastore_v3_copies/serve-2" },
      SOLO,
      { ...SOLO, namespace: "team" },
      SERVE,
    ];
    for (const view of views) {
      await alignCheckoutView(repoDir, handle, view, { holdsWriterLock: true });
    }
    assertEquals(handle.rebuilds, views.length);
    // The serve address alone, which names no other root, is no change.
    await alignCheckoutView(
      repoDir,
      handle,
      { ...SERVE, serverUrl: "http://alias.example.com" },
      { holdsWriterLock: true },
    );
    assertEquals(handle.rebuilds, views.length);
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
