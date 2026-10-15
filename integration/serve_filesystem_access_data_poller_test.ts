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

// Two `swamp serve` instances on one v2 filesystem datastore
// (swamp-club#3371). The grant and group files are shared, but each instance
// holds its own in-memory policy snapshot, and a filesystem datastore has no
// sync service to drive the AccessDataPoller. A grant or revoke made through
// one instance therefore never applied on the other until `access reload` or
// a restart: a revoked user kept access on every peer.
//
// Each test composes the serve side as serve.ts does: a manual-mode
// PolicySnapshotLoader and the poller createAccessDataPoller picks for the
// datastore. The writing side saves grant and group records as its model
// runs do, and publishes the run's event on its own bus only.

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { Data } from "../src/domain/data/data.ts";
import type { AccessPrincipal } from "../src/domain/access/access_decision_service.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import {
  type Grant,
  GRANT_MODEL_TYPE,
} from "../src/domain/models/access/grant_model.ts";
import {
  type Group,
  GROUP_MODEL_TYPE,
} from "../src/domain/models/access/group_model.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import { createModelUpdated } from "../src/domain/events/types.ts";
import { resolverEngine } from "../src/domain/datastore/datastore_path_resolver.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import {
  ACCESS_DATA_SUBDIRS,
  AccessDataPoller,
  createAccessDataPoller,
} from "../src/serve/access_data_poller.ts";
import { FilesystemAccessDataChangeSource } from "../src/serve/filesystem_access_data_change_source.ts";
import { createModelMethodRunDeps } from "../src/serve/deps.ts";
import { libSwampContextForRepo } from "../src/cli/repo_context.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { collect } from "../src/libswamp/testing.ts";

await initializeLogging({});

const POLL_INTERVAL_MS = 20;

type Instance = Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;

const GRANTEE: AccessPrincipal = {
  principal: { kind: "user", id: "fs-peer-grantee" },
  collectives: [],
  groups: [],
};
const RESOURCE = { kind: "model" as const, name: "granted-model", fields: {} };

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-fs-access-poller-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function initRepo(repoDir: string, shared?: string): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  if (shared) {
    const marker = join(repoDir, ".swamp.yaml");
    const existing = await Deno.readTextFile(marker);
    await Deno.writeTextFile(
      marker,
      existing.trimEnd() +
        `\ndatastore:\n  type: filesystem\n  path: '${shared}'\n`,
    );
  }
}

function open(repoDir: string): Promise<Instance> {
  return requireInitializedRepoUnlocked({ repoDir, outputMode: "json" });
}

const LAYOUTS = [
  {
    name: "two checkouts on one shared filesystem path",
    async open(dir: string): Promise<[Instance, Instance]> {
      const shared = join(dir, "shared");
      await initRepo(join(dir, "a"), shared);
      await initRepo(join(dir, "b"), shared);
      return [await open(join(dir, "a")), await open(join(dir, "b"))];
    },
  },
  {
    name: "two instances of one checkout on the default .swamp datastore",
    async open(dir: string): Promise<[Instance, Instance]> {
      await initRepo(join(dir, "repo"));
      return [await open(join(dir, "repo")), await open(join(dir, "repo"))];
    },
  },
];

/** Both instances, with the serve side of B built as serve.ts builds it. */
async function withPair(
  layout: (typeof LAYOUTS)[number],
  fn: (ctx: {
    a: Instance;
    b: Instance;
    loaderB: PolicySnapshotLoader;
    pollerB: AccessDataPoller;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const [a, b] = await layout.open(dir);
    const loaderB = policyLoader(b);
    const pollerB = await createAccessDataPoller({
      syncService: b.syncService,
      pollIntervalMs: POLL_INTERVAL_MS,
      policySnapshotLoader: loaderB,
      catalogInvalidate: () => b.repoContext.catalogStore.invalidate(),
      datastoreConfig: b.datastoreConfig,
      datastoreEngine: resolverEngine(b.datastoreResolver),
      datastoreResolver: b.datastoreResolver,
      eventBus: b.repoContext.eventBus,
    });
    try {
      assert(pollerB, "a v2 filesystem datastore gets an access data poller");
      await loaderB.load();
      await fn({ a, b, loaderB, pollerB });
    } finally {
      await pollerB?.stop();
      await loaderB.dispose();
      a.repoContext.catalogStore.close();
      b.repoContext.catalogStore.close();
    }
  });
}

function policyLoader(instance: Instance): PolicySnapshotLoader {
  return new PolicySnapshotLoader(
    instance.repoContext.unifiedDataRepo,
    instance.repoContext.eventBus,
    "manual",
    { runImpliesApprove: true, runImpliesSignal: true },
  );
}

function decision(loader: PolicySnapshotLoader): string {
  return loader.decisionService.decide(GRANTEE, "read", RESOURCE)?.effect ??
    "deny";
}

function grant(id: string, state: Grant["state"], subject: Grant["subject"]) {
  return {
    id,
    subject,
    effect: "allow",
    actions: ["read"],
    resource: { kind: "model", pattern: RESOURCE.name },
    state,
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  } satisfies Grant;
}

function group(members: Group["members"]): Group {
  return {
    name: "fs-team",
    members,
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

/** Saves a grant or group record as its model run does. */
async function save(
  writer: Instance,
  type: ModelType,
  modelId: string,
  content: Grant | Group,
): Promise<{ name: string; version: number }> {
  const name = type === GRANT_MODEL_TYPE ? "grant-main" : "group-main";
  const { version } = await writer.repoContext.unifiedDataRepo.save(
    type,
    modelId,
    Data.create({
      name,
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName: modelId },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: `${type.normalized}:${modelId}`,
      },
    }),
    new TextEncoder().encode(JSON.stringify(content)),
  );
  return { name, version };
}

/** Saves the record and publishes the run's event on the writer's bus. */
async function saveAsRun(
  writer: Instance,
  type: ModelType,
  modelId: string,
  content: Grant | Group,
): Promise<void> {
  const written = await save(writer, type, modelId, content);
  await writer.repoContext.eventBus.publish(
    createModelUpdated(type.normalized, modelId, modelId, [written]),
  );
}

async function untilDecision(
  loader: PolicySnapshotLoader,
  effect: string,
  label: string,
): Promise<void> {
  await waitFor(() => decision(loader) === effect, label);
}

for (const layout of LAYOUTS) {
  Deno.test(`AccessDataPoller: a grant and its revoke through A reach B after one poll each (${layout.name})`, async () => {
    await withPair(layout, async ({ a, loaderB, pollerB }) => {
      const modelId = crypto.randomUUID();
      const user = { kind: "user" as const, name: GRANTEE.principal.id };

      await saveAsRun(
        a,
        GRANT_MODEL_TYPE,
        modelId,
        grant(modelId, "active", user),
      );
      // Negative control: B's policy is unchanged until a poll.
      assertEquals(decision(loaderB), "deny");
      pollerB.start();
      await untilDecision(loaderB, "allow", "B enforces A's grant");

      await saveAsRun(
        a,
        GRANT_MODEL_TYPE,
        modelId,
        grant(modelId, "revoked", user),
      );
      await untilDecision(loaderB, "deny", "B enforces A's revoke");
    });
  });

  Deno.test(`AccessDataPoller: a group membership change through A reaches B (${layout.name})`, async () => {
    await withPair(layout, async ({ a, loaderB, pollerB }) => {
      const grantId = crypto.randomUUID();
      const groupId = crypto.randomUUID();
      await saveAsRun(
        a,
        GRANT_MODEL_TYPE,
        grantId,
        grant(grantId, "active", { kind: "group", name: "fs-team" }),
      );
      pollerB.start();

      await saveAsRun(
        a,
        GROUP_MODEL_TYPE,
        groupId,
        group([{ kind: "user", id: GRANTEE.principal.id }]),
      );
      await untilDecision(loaderB, "allow", "B sees the new member");

      await saveAsRun(a, GROUP_MODEL_TYPE, groupId, group([]));
      await untilDecision(loaderB, "deny", "B sees the member removed");
    });
  });
}

/**
 * A's serve side, with a counted change source so a test can wait for whole
 * poll cycles on A.
 */
async function withCountedServeSide(
  instance: Instance,
  fn: (side: {
    loader: PolicySnapshotLoader;
    poller: AccessDataPoller;
    cycles: () => number;
  }) => Promise<void>,
): Promise<void> {
  const loader = policyLoader(instance);
  const changeSource = new FilesystemAccessDataChangeSource({
    dirs: ACCESS_DATA_SUBDIRS.map((subdir) => {
      const [root, ...rest] = subdir.split("/");
      return instance.datastoreResolver.resolvePath(root, ...rest);
    }),
    eventBus: instance.repoContext.eventBus,
  });
  await changeSource.prime();
  let cycles = 0;
  const detect = changeSource.detect.bind(changeSource);
  changeSource.detect = async () => {
    const count = await detect();
    cycles++;
    return count;
  };
  const poller = new AccessDataPoller({
    changeSource,
    policySnapshotLoader: loader,
    catalogInvalidate: () => instance.repoContext.catalogStore.invalidate(),
    pollIntervalMs: POLL_INTERVAL_MS,
  });
  try {
    await loader.load();
    await fn({ loader, poller, cycles: () => cycles });
  } finally {
    await poller.stop();
    await loader.dispose();
  }
}

Deno.test("AccessDataPoller: in manual mode the writing instance keeps its own grant staged while a peer applies it", async () => {
  await withPair(LAYOUTS[0], async ({ a, loaderB, pollerB }) => {
    await withCountedServeSide(
      a,
      async ({ loader: loaderA, poller, cycles }) => {
        const modelId = crypto.randomUUID();
        await saveAsRun(
          a,
          GRANT_MODEL_TYPE,
          modelId,
          grant(modelId, "active", {
            kind: "user",
            name: GRANTEE.principal.id,
          }),
        );
        poller.start();
        pollerB.start();

        await untilDecision(loaderB, "allow", "B applies A's grant");
        const after = cycles();
        await waitFor(() => cycles() >= after + 2, "two more cycles on A");
        assertEquals(decision(loaderA), "deny", "A's own grant stays staged");

        await loaderA.load();
        assertEquals(decision(loaderA), "allow", "access reload applies it");
      },
    );
  });
});

Deno.test("AccessDataPoller: a grant created by a real method run through A stays staged on A and reaches B", async () => {
  // The run publishes ModelUpdated with the data versions it wrote, and it
  // also writes its method-summary report into the grant's directory after
  // that event. Neither may read as a peer change on A.
  //
  // A polls only once the run has finished. A cycle that lands between the
  // run's write and its event counts the record as a peer change by design
  // (the change source's unit tests pin that), so polling A during the run
  // would race it (swamp-club#3393).
  await withPair(LAYOUTS[0], async ({ a, loaderB, pollerB }) => {
    await withCountedServeSide(
      a,
      async ({ loader: loaderA, poller, cycles }) => {
        pollerB.start();
        const deps = await createModelMethodRunDeps(a.repoDir, a.repoContext, {
          directExecution: true,
        });
        const events = await collect(
          modelMethodRun(libSwampContextForRepo(a.repoContext), deps, {
            modelIdOrName: `@${GRANT_MODEL_TYPE.normalized}`,
            methodName: "create",
            inputs: {
              subject: `user:${GRANTEE.principal.id}`,
              effect: "allow",
              actions: ["read"],
              resourceKind: "model",
              resourcePattern: RESOURCE.name,
              source: "method",
              createdBy: "user:admin",
            },
            lastEvaluated: false,
            typeArg: `@${GRANT_MODEL_TYPE.normalized}`,
            definitionName: `fs-grant-${crypto.randomUUID()}`,
          }),
        );
        assertEquals(events.filter((e) => e.kind === "error"), []);
        // The report really landed beside grant-main, after the event.
        const grantDir = a.datastoreResolver.resolvePath(
          "data",
          "swamp",
          "grant",
        );
        const dataNames: string[] = [];
        for await (const record of Deno.readDir(grantDir)) {
          for await (const entry of Deno.readDir(join(grantDir, record.name))) {
            dataNames.push(entry.name);
          }
        }
        assert(dataNames.includes("grant-main"), dataNames.join(", "));
        assert(
          dataNames.some((name) => name.startsWith("report-")),
          `expected a report beside grant-main: ${dataNames.join(", ")}`,
        );

        poller.start();
        await untilDecision(loaderB, "allow", "B applies A's run");
        const after = cycles();
        await waitFor(() => cycles() >= after + 2, "two more cycles on A");
        assertEquals(decision(loaderA), "deny", "A's own run stays staged");

        await loaderA.load();
        assertEquals(decision(loaderA), "allow", "access reload applies it");
      },
    );
  });
});

Deno.test("AccessDataPoller: a grant another process writes without an event (a local CLI) reaches serve", async () => {
  // A local `swamp access grant` (no --server) writes the shared files from
  // its own process, so serve treats it as a peer change, as on S3/GCS.
  await withPair(LAYOUTS[1], async ({ a, loaderB, pollerB }) => {
    const modelId = crypto.randomUUID();
    await save(
      a,
      GRANT_MODEL_TYPE,
      modelId,
      grant(modelId, "active", { kind: "user", name: GRANTEE.principal.id }),
    );
    pollerB.start();
    await untilDecision(loaderB, "allow", "B applies the CLI's grant");
  });
});

// --- Records that cannot be read (swamp-club#3386) ---

/** chmod has no effect for root, and Windows has no POSIX modes. */
const IGNORE_CHMOD = Deno.build.os === "windows" || Deno.uid() === 0;

/** A path inside one grant record of the shared datastore. */
function grantPath(instance: Instance, modelId: string, ...rest: string[]) {
  return instance.datastoreResolver.resolvePath(
    "data",
    "swamp",
    "grant",
    modelId,
    ...rest,
  );
}

/** Runs `fn` with `path` unreadable, restoring its mode afterwards. */
async function whileUnreadable(
  path: string,
  fn: (restore: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const mode = ((await Deno.stat(path)).mode ?? 0o755) & 0o777;
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await Deno.chmod(path, mode);
  };
  await Deno.chmod(path, 0o000);
  try {
    await fn(restore);
  } finally {
    await restore();
  }
}

function decisionFor(loader: PolicySnapshotLoader, id: string): string {
  const principal: AccessPrincipal = {
    principal: { kind: "user", id },
    collectives: [],
    groups: [],
  };
  return loader.decisionService.decide(principal, "read", RESOURCE)?.effect ??
    "deny";
}

for (const layout of LAYOUTS) {
  Deno.test({
    name:
      `AccessDataPoller: with an unrelated grant record unreadable, a grant and its revoke through A still reach B (${layout.name})`,
    ignore: IGNORE_CHMOD,
    fn: async () => {
      await withPair(layout, async ({ a, loaderB, pollerB }) => {
        const unrelated = crypto.randomUUID();
        await save(
          a,
          GRANT_MODEL_TYPE,
          unrelated,
          grant(unrelated, "active", { kind: "user", name: "someone-else" }),
        );
        await whileUnreadable(
          grantPath(a, unrelated, "grant-main", "1"),
          async () => {
            pollerB.start();
            const modelId = crypto.randomUUID();
            const user = { kind: "user" as const, name: GRANTEE.principal.id };
            await saveAsRun(
              a,
              GRANT_MODEL_TYPE,
              modelId,
              grant(modelId, "active", user),
            );
            await untilDecision(loaderB, "allow", "B enforces A's grant");
            await saveAsRun(
              a,
              GRANT_MODEL_TYPE,
              modelId,
              grant(modelId, "revoked", user),
            );
            await untilDecision(loaderB, "deny", "B enforces A's revoke");
          },
        );
      });
    },
  });

  Deno.test({
    name:
      `AccessDataPoller: a deny B loaded stays enforced after its record turns unreadable, while a revoke elsewhere applies (${layout.name})`,
    ignore: IGNORE_CHMOD,
    fn: async () => {
      await withPair(layout, async ({ a, loaderB, pollerB }) => {
        const user = { kind: "user" as const, name: GRANTEE.principal.id };
        const other = "fs-peer-other";
        const allowId = crypto.randomUUID();
        const denyId = crypto.randomUUID();
        const otherId = crypto.randomUUID();
        await save(
          a,
          GRANT_MODEL_TYPE,
          allowId,
          grant(allowId, "active", user),
        );
        await save(a, GRANT_MODEL_TYPE, denyId, {
          ...grant(denyId, "active", user),
          effect: "deny",
        });
        await save(
          a,
          GRANT_MODEL_TYPE,
          otherId,
          grant(otherId, "active", { kind: "user", name: other }),
        );
        pollerB.start();
        await waitFor(
          () => decisionFor(loaderB, other) === "allow",
          "B loads the grants",
        );
        assertEquals(decision(loaderB), "deny", "the deny beats the allow");

        await whileUnreadable(
          grantPath(a, denyId, "grant-main", "1"),
          async () => {
            await saveAsRun(
              a,
              GRANT_MODEL_TYPE,
              otherId,
              grant(otherId, "revoked", { kind: "user", name: other }),
            );
            await waitFor(
              () => decisionFor(loaderB, other) === "deny",
              "B applies the revoke elsewhere",
            );
            assertEquals(
              loaderB.unreadable.map((r) => r.outcome),
              ["kept-last-known-deny"],
            );
            assertEquals(decision(loaderB), "deny", "the deny stays enforced");
          },
        );
      });
    },
  });

  Deno.test({
    name:
      `AccessDataPoller: a grant whose content file turns readable again is applied with no other change (${layout.name})`,
    ignore: IGNORE_CHMOD,
    fn: async () => {
      await withPair(layout, async ({ a, loaderB, pollerB }) => {
        const modelId = crypto.randomUUID();
        const user = { kind: "user" as const, name: GRANTEE.principal.id };
        await saveAsRun(
          a,
          GRANT_MODEL_TYPE,
          modelId,
          grant(modelId, "active", user),
        );
        await whileUnreadable(
          grantPath(a, modelId, "grant-main", "1", "raw"),
          async (restore) => {
            pollerB.start();
            await waitFor(
              () => loaderB.unreadable.length === 1,
              "B finds the grant unreadable",
            );
            assertEquals(
              decision(loaderB),
              "deny",
              "an unreadable allow is left out",
            );
            // A mode change moves only the file's ctime: the change source
            // cannot see it, so only the retry of a degraded snapshot can.
            await restore();
            await untilDecision(
              loaderB,
              "allow",
              "B applies the grant once readable",
            );
            assertEquals(loaderB.unreadable, []);
          },
        );
      });
    },
  });
}
