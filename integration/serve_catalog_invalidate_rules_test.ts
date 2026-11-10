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

import { join } from "@std/path";
import {
  assertPinnedSet,
  countedKeys,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
  topLevelOwners,
} from "./arch_fitness_helpers.ts";

const PINNED = [
  // v2 sync callbacks and the token GC pull: each needs a sync service, which a v3 serve lacks.
  "src/cli/commands/serve.ts :: serveCommand (x8)",
  // Calls its callback only after a pull, and is built only with a sync service.
  "src/serve/access_data_poller.ts :: AccessDataPoller",
  // Cache hydration pulls through the sync service; never built on v3.
  "src/serve/boot_reconciliation.ts :: hydrateLocalCache",
  // Invalidates only when it holds a sync service.
  "src/serve/config_poller.ts :: ConfigPoller",
  // Only when the lock pulled: acquireModelLocks syncs a v2 custom datastore only.
  "src/serve/delegation_store.ts :: DelegationStore (x2)",
  "src/serve/deps.ts :: createStepLockHook",
  // Inside the sync-service branch of the mint.
  "src/serve/device_auth_handler.ts :: mintServerTokenImpl",
  // Inside the sync-service branch, after a pull that changed files.
  "src/serve/handlers/access_handlers.ts :: handleAccessReload",
  // Returns first without a sync service.
  "src/serve/handlers/access_handlers.ts :: pullBeforeTokenWrite",
  // Datastore setup refuses a v3 datastore before it invalidates.
  "src/serve/handlers/admin_handlers.ts :: serveDatastoreSetupDeps",
  // Only when the run's lock pulled, which a v3 datastore never does; a first
  // integration register locks its id the same way.
  "src/serve/handlers/model_handlers.ts :: handleModelMethodRun (x3)",
  // pullModelsUnlocked returns false on anything but a v2 custom datastore.
  "src/serve/handlers/model_handlers.ts :: pullBeforeUnlockedRun",
  // Built only with a sync service.
  "src/serve/runtime_data_poller.ts :: RuntimeDataPoller",
  // Inside the sync-service branch of the migration lock.
  "src/serve/token_secret_migration.ts :: createTokenMigrationLockDeps",
];

const INVALIDATES =
  /\.invalidate\b|#?\b(?:catalogInvalidate|invalidateCatalog)\(/;

async function* serveSources(): AsyncGenerator<string> {
  yield* productionSourceFiles(join(SRC_DIR, "serve"));
  yield join(SRC_DIR, "cli", "commands", "serve.ts");
}

Deno.test("serve: every catalog invalidate on serve's paths is pinned with why it is safe on v3 (swamp-club#4387)", async () => {
  const keys: string[] = [];
  for await (const file of serveSources()) {
    const lines = (await Deno.readTextFile(file)).split("\n");
    const owners = topLevelOwners(lines);
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (INVALIDATES.test(line)) {
        keys.push(`${repoRelative(file)} :: ${owners[i]}`);
      }
    });
  }
  assertPinnedSet(
    countedKeys(keys.sort()),
    PINNED,
    "Catalog invalidates on serve's paths",
    "On a v3 datastore a catalog invalidate makes the read model replay " +
      "every commit. The read model's catch-up writes the catalog rows, so " +
      "a v3 path needs none. Pin a new one only when it cannot run on v3, " +
      "and say why in a comment.",
  );
});
