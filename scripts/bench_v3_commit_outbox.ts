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

/**
 * What one v3 commit costs a writer on its success path, outbox included
 * (swamp-club#3586): a root that commits one inline auto-definition, and one
 * that commits a chunked one, through a v3 filesystem datastore's handle.
 * The A/A pair runs the same root twice, so a gap between them is noise.
 * Run on two checkouts to compare:
 *
 * ```
 * deno bench -A scripts/bench_v3_commit_outbox.ts
 * ```
 */

import { join } from "@std/path";
import type { CommitLogUnitOfWork } from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../src/domain/datastore_v3/repository_changes.ts";
import {
  initializeV3Datastore,
  openV3Datastore,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";

const dir = await Deno.makeTempDir({ prefix: "swamp-v3-outbox-bench-" });
const datastorePath = join(dir, "datastore");
await initializeV3Datastore(datastorePath, "bench");
const handle = openV3Datastore({
  repoDir: join(dir, "repo"),
  datastorePath,
  writerFence: () => 1,
});
await handle.raiseWriterFence(1);
const engine = handle.engineFor(() => Promise.resolve(), () => {
  throw new Error("no run repository needed");
});

/** Commits one auto-definition of `bytes` bytes in its own root. */
async function commitOne(bytes: number): Promise<void> {
  const id = crypto.randomUUID();
  await engine.runRoot({}, async () => {
    const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
    await unit.stageOps([
      new AutoDefinitionChanges(id).write(
        recordKeyOf(["auto-definitions", `${id}.yaml`]),
        new Uint8Array(bytes).fill(id.charCodeAt(0)),
      ),
    ]);
    await unit.commit();
  });
}

Deno.bench("commit one inline record (A)", async () => {
  await commitOne(256);
});

Deno.bench("commit one inline record (A/A control)", async () => {
  await commitOne(256);
});

Deno.bench("commit one chunked record", async () => {
  await commitOne(64 * 1024);
});

globalThis.addEventListener("unload", () => {
  Deno.removeSync(dir, { recursive: true });
});
