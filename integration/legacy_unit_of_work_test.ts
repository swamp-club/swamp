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

function pushFor(service: InMemorySyncService, twoPhaseSync: boolean): Push {
  return twoPhaseSync
    ? async () => {
      await service.commitPush(await service.preparePush());
    }
    : async () => {
      await service.pushChanged();
    };
}

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
      // the datastore format check connects one sync service of its own first,
      // to read the marker; it writes nothing
      assertEquals(
        services.length,
        2,
        "expected the format check's sync service and the command's",
      );
      assert(
        (ctx.syncService as unknown) === services[1],
        "expected the hook and the pushes to share one sync service",
      );
      const push = pushFor(services[1], twoPhaseSync);
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
      assert(direct.ops.some((op) => (op as { bulk?: boolean }).bulk === true));
      assertEquals(direct.files["data/a.txt"], undefined);
      // a bulk mark makes the next push a full walk that deletes nothing, so
      // removing c.txt after it never reaches the remote; the adapter must
      // reproduce this
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
