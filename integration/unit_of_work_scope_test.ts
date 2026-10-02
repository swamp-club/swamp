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

// The ambient unit of work across real repository contexts (swamp-club#2971,
// datastore rework Phase 1). Each repo runs on its own per-run test datastore
// type over its own in-memory remote, wired by the composition root, so the
// remote's recorded marks show where each repository's signal went. A
// repository stages into an ambient unit only when the unit wraps its own
// context's hook; everything else keeps calling the hook as before.

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  createInMemoryRemote,
  type InMemoryRemote,
} from "@swamp-club/swamp-testing";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import type { MarkDirtyHook } from "../src/domain/datastore/datastore_sync_service.ts";
import type { UnitOfWork } from "../src/domain/datastore/unit_of_work.ts";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createLegacyUnitOfWork } from "../src/infrastructure/persistence/legacy_unit_of_work.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  currentUnitOfWork,
  runInUnitOfWork,
} from "../src/infrastructure/persistence/unit_of_work_scope.ts";
import {
  configureTestDatastore,
  registerTestDatastoreType,
} from "../src/infrastructure/testing/test_datastore_type.ts";

await initializeLogging({});

const TYPE = ModelType.create("command/shell");

interface Peer {
  repoContext: RepositoryContext;
  hook: MarkDirtyHook;
  remote: InMemoryRemote;
  cacheDir: string;
}

/** Opens one repo per name, each on its own remote and datastore type. */
async function withRepos(
  names: readonly string[],
  fn: (peers: Record<string, Peer>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-uow-scope-" });
  const disposers: Array<() => void> = [];
  const contexts: RepositoryContext[] = [];
  try {
    const peers: Record<string, Peer> = {};
    for (const name of names) {
      const remote = createInMemoryRemote({ capabilities: {} });
      const type = registerTestDatastoreType({
        connect: (cache) => remote.connect(cache, { instance: name }),
      });
      disposers.push(() => type.dispose());
      const repoDir = join(dir, name.toLowerCase());
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
      contexts.push(ctx.repoContext);
      const hook = ctx.repoContext.markDirty;
      assert(hook !== undefined, "expected the composition-built mark hook");
      peers[name] = {
        repoContext: ctx.repoContext,
        hook,
        remote,
        cacheDir: join(repoDir, ".test-cache"),
      };
    }
    await fn(peers);
  } finally {
    for (const ctx of contexts) ctx.catalogStore.close();
    for (const dispose of disposers) dispose();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function makeData(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
  });
}

async function save(peer: Peer, modelId: string, name: string): Promise<void> {
  await peer.repoContext.unifiedDataRepo.save(
    TYPE,
    modelId,
    makeData(name),
    new TextEncoder().encode(JSON.stringify({ name })),
  );
}

/** The path marks `peer`'s remote recorded, sorted. */
async function marksOn(peer: Peer): Promise<string[]> {
  return [...(await peer.remote.pendingPush(peer.cacheDir)).marked].sort();
}

/** The data names whose files a unit staged, sorted and deduplicated. */
function stagedNames(uow: UnitOfWork, modelId: string): string[] {
  const names = new Set<string>();
  for (const change of uow.staged()) {
    assert(change.kind !== "bulk", "expected per-path changes only");
    const rest = change.path.split(modelId)[1];
    assert(rest !== undefined, `expected a path under ${modelId}`);
    names.add(rest.split(/[\\/]/)[1]);
  }
  return [...names].sort();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => resolve = r);
  return { promise, resolve };
}

Deno.test("runInUnitOfWork: a write through another context's repository goes to that context's hook, not the scope", async () => {
  await withRepos(["A", "B"], async ({ A, B }) => {
    const modelId = crypto.randomUUID();
    const uow = createLegacyUnitOfWork(A.hook, { flush: undefined });
    await runInUnitOfWork(uow, async () => {
      await save(B, modelId, "from-b");
      await save(A, modelId, "from-a");
    });

    assertEquals(stagedNames(uow, modelId), ["from-a"]);
    const markedA = await marksOn(A);
    const markedB = await marksOn(B);
    assert(markedA.length > 0, "A's own write reached A's hook");
    assert(markedB.length > 0, "B's write reached B's hook");
    assert(markedA.every((m) => m.includes("from-a")), `A: ${markedA}`);
    assert(markedB.every((m) => m.includes("from-b")), `B: ${markedB}`);
  });
});

Deno.test("runInUnitOfWork: nested scopes stage into the innermost, and the outer is active again after", async () => {
  await withRepos(["A"], async ({ A }) => {
    const modelId = crypto.randomUUID();
    const outer = createLegacyUnitOfWork(A.hook, { flush: undefined });
    const inner = createLegacyUnitOfWork(A.hook, { flush: undefined });
    await runInUnitOfWork(outer, async () => {
      await save(A, modelId, "before");
      await runInUnitOfWork(inner, () => save(A, modelId, "inside"));
      assertEquals(currentUnitOfWork(), outer);
      await save(A, modelId, "after");
    });
    assertEquals(stagedNames(outer, modelId), ["after", "before"]);
    assertEquals(stagedNames(inner, modelId), ["inside"]);
  });
});

Deno.test("runInUnitOfWork: two scopes running concurrently never see each other's changes", async () => {
  await withRepos(["A"], async ({ A }) => {
    const modelId = crypto.randomUUID();
    const first = createLegacyUnitOfWork(A.hook, { flush: undefined });
    const second = createLegacyUnitOfWork(A.hook, { flush: undefined });
    const firstSaved = deferred();
    const secondSaved = deferred();
    // Interleave: first, second, first, second.
    await Promise.all([
      runInUnitOfWork(first, async () => {
        await save(A, modelId, "one-a");
        firstSaved.resolve();
        await secondSaved.promise;
        await save(A, modelId, "one-b");
      }),
      runInUnitOfWork(second, async () => {
        await firstSaved.promise;
        await save(A, modelId, "two-a");
        secondSaved.resolve();
        await save(A, modelId, "two-b");
      }),
    ]);
    assertEquals(stagedNames(first, modelId), ["one-a", "one-b"]);
    assertEquals(stagedNames(second, modelId), ["two-a", "two-b"]);
  });
});

// Expected AsyncLocalStorage behaviour: the scope travels with the async call
// chain, not with the lexical block, so a promise started inside a scope keeps
// that scope even when it runs on after the scope has returned.
Deno.test("runInUnitOfWork: a promise started inside a scope and awaited after it stays with that scope", async () => {
  await withRepos(["A"], async ({ A }) => {
    const modelId = crypto.randomUUID();
    const uow = createLegacyUnitOfWork(A.hook, { flush: undefined });
    const gate = deferred();
    const late = await runInUnitOfWork(uow, () => {
      const started = (async () => {
        await gate.promise;
        await save(A, modelId, "late");
      })();
      return Promise.resolve({ started });
    });
    assertEquals(currentUnitOfWork(), undefined);
    gate.resolve();
    await late.started;
    assertEquals(stagedNames(uow, modelId), ["late"]);
  });
});

Deno.test("runInUnitOfWork: a write that escapes its scope and lands after the unit commits rejects", async () => {
  await withRepos(["A"], async ({ A }) => {
    const modelId = crypto.randomUUID();
    const uow = createLegacyUnitOfWork(A.hook, { flush: undefined });
    const gate = deferred();
    const late = await runInUnitOfWork(uow, () => {
      const started = (async () => {
        await gate.promise;
        await save(A, modelId, "too-late");
      })();
      return Promise.resolve({ started });
    });
    await uow.commit();
    gate.resolve();
    await assertRejects(
      () => late.started,
      Error,
      "unit of work already committed",
    );
    assertEquals(uow.staged(), []);
  });
});
