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

// The legacy unit of work against the in-memory remote, through the mark hook
// the composition root builds (requireInitializedRepoUnlocked wires
// buildMarkDirtyHook over the test datastore's sync service). The same script
// of writes, removes and marks runs twice, once calling the hook directly as
// repositories do today and once through the adapter's stage, each against
// its own remote. The remotes must see the same operations, plan the same
// push and end up with the same files: the adapter changes nothing
// (swamp-club#2970, datastore rework Phase 1).

import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  createInMemoryRemote,
  type InMemoryRemote,
  type InMemoryRemoteOpRecord,
  type InMemorySyncService,
} from "@swamp-club/swamp-testing";
import type { StagedChange } from "../src/domain/datastore/unit_of_work.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { getRegisteredLockKeys } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { createLegacyUnitOfWork } from "../src/infrastructure/persistence/legacy_unit_of_work.ts";
import {
  configureTestDatastore,
  registerTestDatastoreType,
} from "../src/infrastructure/testing/test_datastore_type.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";

await initializeLogging({});

type Mark = (change: StagedChange) => Promise<void>;
type Push = () => Promise<void>;
type Op = Omit<InMemoryRemoteOpRecord, "instance">;

/**
 * Pushes the way core does for the advertised capability: two-phase
 * (preparePush then commitPush) when the service supports it, otherwise a
 * single pushChanged.
 */
function pushFor(service: InMemorySyncService, twoPhaseSync: boolean): Push {
  return twoPhaseSync
    ? async () => {
      await service.commitPush(await service.preparePush());
    }
    : async () => {
      await service.pushChanged();
    };
}

/**
 * Writes and removes real files in the cache, marking each change before it
 * happens. Includes a removal of a pushed file (absence on disk means delete)
 * and path marks after a bulk mark, which the S3 and GCS extensions drop.
 */
async function runScript(
  cacheDir: string,
  mark: Mark,
  push: Push,
): Promise<void> {
  const file = (name: string) => join(cacheDir, "data", name);
  const write = async (name: string, body: string) => {
    await mark({ kind: "write", path: file(name) });
    await Deno.mkdir(dirname(file(name)), { recursive: true });
    await Deno.writeTextFile(file(name), body);
  };
  const remove = async (name: string) => {
    await mark({ kind: "remove", path: file(name) });
    await Deno.remove(file(name));
  };

  await write("a.txt", "a");
  await write("b.txt", "b");
  await write("c.txt", "c");
  await push();
  await remove("a.txt");
  await write("b.txt", "b2");
  await push();
  await mark({ kind: "bulk", reason: "test bulk" });
  await write("d.txt", "d");
  await remove("c.txt");
}

interface Observed {
  ops: Op[];
  pending: Awaited<ReturnType<InMemoryRemote["pendingPush"]>>;
  files: Record<string, string>;
}

async function observe(
  twoPhaseSync: boolean,
  dir: string,
  via: "direct" | "adapter",
): Promise<Observed> {
  const remote = createInMemoryRemote({
    capabilities: twoPhaseSync ? { twoPhaseSync: true } : {},
  });
  // Keep the service core connects, so the test can push it two-phase.
  const services: InMemorySyncService[] = [];
  const type = registerTestDatastoreType({
    connect: (cacheDir) => {
      const service = remote.connect(cacheDir);
      services.push(service);
      return service;
    },
  });
  try {
    const repoDir = join(dir, via);
    await Deno.mkdir(repoDir, { recursive: true });
    const homeDir = join(repoDir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(repoDir), { tools: [] });
    await configureTestDatastore(repoDir, type.typeName);

    const ctx = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: "json",
    });
    try {
      const hook = ctx.repoContext.markDirty;
      assert(hook !== undefined, "expected the composition-built mark hook");
      assert(ctx.syncService !== undefined, "expected a sync service");
      assertEquals(services.length, 1, "expected one connected sync service");
      assert(
        (ctx.syncService as unknown) === services[0],
        "expected the hook and the pushes to share one sync service",
      );
      const push = pushFor(services[0], twoPhaseSync);
      const cacheDir = join(repoDir, ".test-cache");

      let mark: Mark;
      if (via === "direct") {
        mark = (change) =>
          hook(change.kind === "bulk" ? undefined : change.path);
      } else {
        const unit = createLegacyUnitOfWork(hook, { flush: undefined });
        mark = (change) => unit.stage(change);
      }
      const opsBefore = remote.ops().length;
      await runScript(cacheDir, mark, push);

      const pending = await remote.pendingPush(cacheDir);
      await push();
      // Each remote names its own instance; compare everything else.
      const ops = remote.ops().slice(opsBefore).map(
        ({ instance: _instance, ...rest }) => rest,
      );
      const decoder = new TextDecoder();
      const files = Object.fromEntries(
        [...remote.files()].map((
          [path, bytes],
        ) => [path, decoder.decode(bytes)])
          .sort(([a], [b]) => a.localeCompare(b)),
      );
      return { ops, pending, files };
    } finally {
      ctx.repoContext.catalogStore.close();
    }
  } finally {
    type.dispose();
  }
}

for (const twoPhaseSync of [true, false]) {
  Deno.test(`legacy unit of work: the remote sees what direct hook calls produce (twoPhaseSync=${twoPhaseSync})`, async () => {
    assertEquals(getRegisteredLockKeys(), [], "a previous test leaked a sync");
    const dir = await Deno.makeTempDir({ prefix: "swamp-legacy-uow-" });
    try {
      const direct = await observe(twoPhaseSync, dir, "direct");
      const adapter = await observe(twoPhaseSync, dir, "adapter");

      assertEquals(adapter.ops, direct.ops);
      assertEquals(adapter.pending, direct.pending);
      assertEquals(adapter.files, direct.files);
      // The script reached the remote: the bulk mark is in the op log, the
      // removal of a pushed file was deleted remotely, and the writes landed.
      assert(direct.ops.some((op) => (op as { bulk?: boolean }).bulk === true));
      assertEquals(direct.files["data/a.txt"], undefined);
      // A bulk mark makes the next push a full walk that deletes nothing, so
      // the removal of c.txt after it never reaches the remote (pinned legacy
      // behaviour; the adapter must reproduce it exactly).
      assertEquals(direct.files["data/c.txt"], "c");
      assertEquals(direct.files["data/b.txt"], "b2");
      assertEquals(direct.files["data/d.txt"], "d");
      // The push style really ran: two-phase pushes record prepare and
      // commit and never a push carrying paths; single-phase the reverse.
      const ran = (op: Op["op"]) => direct.ops.some((o) => o.op === op);
      const pathPush = direct.ops.some((o) =>
        o.op === "push" && (o.paths.length > 0 || o.deleted.length > 0)
      );
      assertEquals(
        { prepare: ran("prepare"), commit: ran("commit"), pathPush },
        twoPhaseSync
          ? { prepare: true, commit: true, pathPush: false }
          : { prepare: false, commit: false, pathPush: true },
      );
    } finally {
      if (Deno.build.os === "windows") {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    }
    assertEquals(getRegisteredLockKeys(), [], "a datastore sync was left held");
  });
}
