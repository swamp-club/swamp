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

// reproduces the migration race best-effort: a worker commits holdMs after the
// store opens, so a slower run passes without exercising it, never failing
// falsely

import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { ensureDirSync } from "@std/fs";
import { waitFor } from "@swamp-club/swamp-testing";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import type {
  LockWorkerMessage,
  LockWorkerRequest,
} from "./extension_catalog_migration_lock_worker.ts";

const V3_MIGRATION_KEY = "migration_applied:per-extension-aggregate-v3";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-ext-catalog-race-" });
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      // EBUSY can fire on windows before V8 frees native sqlite handles; the
      // temp dir is ephemeral
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

function seedPendingCatalog(repoRoot: string): string {
  ensureDirSync(join(repoRoot, ".swamp"));
  const dbPath = join(repoRoot, ".swamp", "_extension_catalog.db");
  const store = new ExtensionCatalogStore(dbPath);
  store.upsert({
    source_path: join(
      repoRoot,
      ".swamp",
      "pulled-extensions",
      "@scope",
      "foo",
      "models",
      "x.ts",
    ),
    type_normalized: "@scope/foo/x",
    kind: "model",
    bundle_path: "/b/x.js",
    version: "1.0.0",
    description: "",
    extends_type: "",
    source_mtime: "",
  });
  store.markPopulated("model");
  store.close();
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM bundle_meta WHERE key = ?").run(V3_MIGRATION_KEY);
  db.close();
  return dbPath;
}

Deno.test("ExtensionCatalogStore: a writer committing during the v3 data migration does not wipe the catalog", async () => {
  await withTempDir(async (repoRoot) => {
    const dbPath = seedPendingCatalog(repoRoot);
    const worker = new Worker(
      new URL("./extension_catalog_migration_lock_worker.ts", import.meta.url)
        .href,
      { type: "module" },
    );
    const received: LockWorkerMessage[] = [];
    worker.onmessage = (event: MessageEvent<LockWorkerMessage>) => {
      received.push(event.data);
    };
    try {
      worker.postMessage(
        { kind: "lock", dbPath } satisfies LockWorkerRequest,
      );
      await waitFor(() => received.includes("locked"), "worker holds the lock");

      worker.postMessage(
        { kind: "opening", holdMs: 300 } satisfies LockWorkerRequest,
      );
      const store = new ExtensionCatalogStore(dbPath);
      try {
        assertEquals(store.count(), 1);
        assertEquals(store.isPopulated("model"), true);
      } finally {
        store.close();
      }
      await waitFor(
        () => received.includes("committed"),
        "worker committed",
      );

      const db = new DatabaseSync(dbPath);
      try {
        const marker = db.prepare(
          "SELECT value FROM bundle_meta WHERE key = ?",
        ).get(V3_MIGRATION_KEY) as { value: string } | undefined;
        assertEquals(marker?.value, "true");
        const otherWrite = db.prepare(
          "SELECT value FROM bundle_meta WHERE key = ?",
        ).get("test:other-process-write") as { value: string } | undefined;
        assertEquals(otherWrite?.value, "true");
      } finally {
        db.close();
      }
    } finally {
      worker.terminate();
    }
  });
});
