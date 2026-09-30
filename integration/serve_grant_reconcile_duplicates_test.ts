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
 * Integration tests for duplicate grants (swamp-club#2822). Two serve
 * instances starting against one datastore each create their own copy of
 * every file and admin grant. Revoking through a grants file or --admins
 * must revoke every copy, in a real repository with the real stores and
 * policy snapshot.
 */

import { join } from "@std/path";
import { assertEquals, assertNotEquals } from "@std/assert";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { parseGrantFile } from "../src/domain/access/grant_file.ts";
import {
  type FileGrantStore,
  reconcileAllFileGrants,
} from "../src/domain/access/grant_file_reconciler.ts";
import {
  type AdminGrantStore,
  hashPrincipal,
  instanceNameForAdmin,
  materializeAdmins,
} from "../src/domain/access/admin_materializer.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import type { Action } from "../src/domain/access/action.ts";
import type { AccessResource } from "../src/domain/access/access_decision_service.ts";
import { validateGrantCondition } from "../src/infrastructure/cel/grant_condition_environment.ts";
import {
  createGrantWriteCommit,
  createGrantWriteTracking,
  type GrantWriteTracking,
} from "../src/serve/grant_write_tracking.ts";
import { createSyncGate } from "../src/serve/sync_gate.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const TEAM_YAML = `grants:
  - subject: user:alice
    effect: allow
    actions: [run]
    resource: "workflow:@acme/*"
  - subject: user:alice
    effect: allow
    actions: [read]
    resource: "model:*"
`;

const TEAM_YAML_WITHOUT_READ = `grants:
  - subject: user:alice
    effect: allow
    actions: [run]
    resource: "workflow:@acme/*"
`;

const ALL_ACCESS: AccessResource = { kind: "access", name: "*", fields: {} };
const MODEL_FOO: AccessResource = { kind: "model", name: "foo", fields: {} };

interface Harness {
  tracking: GrantWriteTracking;
  loader: PolicySnapshotLoader;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-grant-dupes-" });
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    const { repoDir: resolved, repoContext } =
      await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
    const tracking = createGrantWriteTracking(
      repoContext.definitionRepo,
      new YamlDefinitionRepository(
        resolved,
        undefined,
        repoContext.autoDefinitionsDir,
        false,
        repoContext.markDirty,
      ),
      repoContext.unifiedDataRepo,
    );
    const loader = new PolicySnapshotLoader(
      repoContext.unifiedDataRepo,
      repoContext.eventBus,
      "manual",
      { runImpliesApprove: true },
    );
    try {
      await fn({ tracking, loader });
    } finally {
      await loader.dispose();
    }
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function teamEntries(yaml: string) {
  const parsed = parseGrantFile("team.yaml", yaml, validateGrantCondition);
  assertEquals(parsed.errors, []);
  return new Map([["team.yaml", parsed.entries]]);
}

/** A peer that has not pulled this instance's grants sees none of them. */
function peerFileStore(store: FileGrantStore): FileGrantStore {
  return { ...store, queryFileGrants: () => Promise.resolve(new Map()) };
}

/**
 * A peer's admin grant: its definition file shares the name-derived path,
 * so once both peers' writes meet, the peer's copy has no definition here.
 */
function peerAdminStore(store: AdminGrantStore): AdminGrantStore {
  return {
    ...store,
    queryConfigGrants: () => Promise.resolve(new Map()),
    ensureDefinition: () => Promise.resolve(crypto.randomUUID()),
  };
}

async function decide(
  loader: PolicySnapshotLoader,
  user: string,
  action: Action,
  resource: AccessResource,
): Promise<string | undefined> {
  await loader.load();
  return loader.decisionService.decide(
    { principal: { kind: "user", id: user }, collectives: [], groups: [] },
    action,
    resource,
  )?.effect;
}

async function activeFileCopies(store: FileGrantStore): Promise<number> {
  const grants = await store.queryFileGrants();
  return [...grants.values()].filter((g) => g.grant.state === "active")
    .length;
}

Deno.test("duplicate file grants: removing an entry revokes every copy", async () => {
  await withHarness(async ({ tracking, loader }) => {
    const store = tracking.fileGrantStore;
    await reconcileAllFileGrants(teamEntries(TEAM_YAML), store);
    await reconcileAllFileGrants(teamEntries(TEAM_YAML), peerFileStore(store));
    assertEquals(await activeFileCopies(store), 4);
    assertEquals(await decide(loader, "alice", "read", MODEL_FOO), "allow");

    const result = await reconcileAllFileGrants(
      teamEntries(TEAM_YAML_WITHOUT_READ),
      store,
    );

    // Two copies of the removed read grant, one duplicate of the run grant.
    assertEquals(result.totalRevoked, 3);
    assertEquals(await activeFileCopies(store), 1);
    assertNotEquals(
      await decide(loader, "alice", "read", MODEL_FOO),
      "allow",
    );

    const again = await reconcileAllFileGrants(
      teamEntries(TEAM_YAML_WITHOUT_READ),
      store,
    );
    assertEquals(again.totalRevoked, 0);
    assertEquals(again.totalUnchanged, 1);
  });
});

Deno.test("duplicate admin grants: dropping an admin revokes every copy", async () => {
  await withHarness(async ({ tracking, loader }) => {
    const store = tracking.adminGrantStore;
    await materializeAdmins("token", ["user:admin"], store);
    await materializeAdmins("token", ["user:admin"], peerAdminStore(store));
    assertEquals(
      await decide(loader, "admin", "admin", ALL_ACCESS),
      "allow",
    );

    const result = await materializeAdmins("token", ["user:bob"], store);

    assertEquals(result.revoked, 2);
    assertNotEquals(
      await decide(loader, "admin", "admin", ALL_ACCESS),
      "allow",
    );
    assertEquals(await decide(loader, "bob", "admin", ALL_ACCESS), "allow");
  });
});

Deno.test("duplicate admin grants: re-adding an admin reactivates the definition-backed copy", async () => {
  await withHarness(async ({ tracking, loader }) => {
    const store = tracking.adminGrantStore;
    await materializeAdmins("token", ["user:admin"], store);
    await materializeAdmins("token", ["user:admin"], peerAdminStore(store));
    await materializeAdmins("token", ["user:bob"], store);

    const result = await materializeAdmins("token", ["user:admin"], store);

    assertEquals(result.reactivated, 1);
    const instanceName = instanceNameForAdmin(
      await hashPrincipal("user:admin"),
    );
    const copies = (await store.queryConfigGrants()).get(instanceName) ?? [];
    const active = copies.filter((c) => c.grant.state === "active");
    assertEquals(active.length, 1);
    assertEquals(
      active[0].modelId,
      await store.findDefinitionId(instanceName),
    );
    assertEquals(
      await decide(loader, "admin", "admin", ALL_ACCESS),
      "allow",
    );
  });
});

Deno.test("grant write commit: marks every grant write and pushes once inside the gate", async () => {
  await withHarness(async ({ tracking }) => {
    const gate = createSyncGate();
    const marked: string[] = [];
    const pushes: { namespace?: string; gateHeld: boolean }[] = [];
    const commit = createGrantWriteCommit(gate, tracking, {
      syncService: {
        pushChanged(options) {
          pushes.push({
            namespace: options?.namespace,
            gateHeld: gate.exclusiveHeld,
          });
          return Promise.resolve(0);
        },
      },
      markDirty(path) {
        if (path) marked.push(path);
        return Promise.resolve();
      },
      namespace: "infra",
    });

    await commit(async () => {
      await materializeAdmins(
        "token",
        ["user:admin"],
        tracking.adminGrantStore,
      );
      await reconcileAllFileGrants(
        teamEntries(TEAM_YAML),
        tracking.fileGrantStore,
      );
    });

    assertEquals(pushes, [{ namespace: "infra", gateHeld: true }]);
    // One admin and two file grants: a definition and a data dir each.
    assertEquals(marked.filter((p) => p.includes("grant-main")).length, 3);
    assertEquals(marked.length, 6);

    await commit(async () => {
      await reconcileAllFileGrants(
        teamEntries(TEAM_YAML),
        tracking.fileGrantStore,
      );
    });
    assertEquals(pushes.length, 1);
  });
});
