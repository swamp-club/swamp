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
 * Integration tests for grant-file usernames (swamp-club#3123): grant files
 * on a real repository, the real grant store, reconciler and policy
 * snapshot, and the pin store over an encrypted control-plane vault on
 * disk. A load runs what serve startup and a reload run: read the files,
 * resolve their usernames, reconcile, load the snapshot.
 */

import { join } from "@std/path";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { ControlPlaneVaultProvider } from "../src/domain/vaults/control_plane_vault_provider.ts";
import { readServeGrantFiles } from "../src/domain/access/grant_file_loader.ts";
import type { GrantFileError } from "../src/domain/access/grant_file.ts";
import {
  type GrantUsernameResolver,
  type ParsedGrantSource,
  resolveGrantFileUsernames,
} from "../src/domain/access/grant_username_resolution.ts";
import {
  reconcileAllFileGrants,
  type ReconcileAllResult,
} from "../src/domain/access/grant_file_reconciler.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import type { AccessResource } from "../src/domain/access/access_decision_service.ts";
import { validateGrantCondition } from "../src/infrastructure/cel/grant_condition_environment.ts";
import {
  createGrantWriteTracking,
  type GrantWriteTracking,
} from "../src/serve/grant_write_tracking.ts";
import {
  createOAuthGrantUsernameResolver,
  type GrantUsernameLookup,
  type GrantUsernamePinStore,
  vaultGrantUsernamePinStore,
} from "../src/serve/oauth_grant_username_pins.ts";
import { UsernameNotFoundError } from "../src/serve/oauth_client.ts";
import { OAUTH_RESOLVED_ADMINS_KEY } from "../src/serve/oauth_registration.ts";

// Import models barrel to trigger built-in registration.
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const PROVIDER = "https://club.example";
const DEPLOY: AccessResource = { kind: "workflow", name: "deploy", fields: {} };

/** The provider's directory: username to sub, editable mid-test. */
type Directory = Record<string, string>;

interface Harness {
  repoDir: string;
  vault: ControlPlaneVaultProvider;
  pinStore: GrantUsernamePinStore;
  tracking: GrantWriteTracking;
  loader: PolicySnapshotLoader;
  directory: Directory;
  asked: string[];
  /** A serve instance's resolver; each call is a fresh process. */
  newResolver(
    options?: { lookup?: GrantUsernameLookup | null },
  ): GrantUsernameResolver;
  writeGrants(name: string, yaml: string): Promise<void>;
  /** What startup or a reload does with the grant files. */
  load(resolver: GrantUsernameResolver): Promise<LoadResult>;
  decide(sub: string): Promise<string | undefined>;
}

interface LoadResult {
  errors: GrantFileError[];
  reconcile: ReconcileAllResult;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-grant-usernames-" });
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    await Deno.mkdir(join(repoDir, "grants"));
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
    const vault = new ControlPlaneVaultProvider(
      new FileSystemControlPlaneStore(join(repoDir, "control")),
    );
    await vault.initialize();
    const pinStore = vaultGrantUsernamePinStore({
      list: () => vault.list(),
      get: (key) => vault.get(key),
      put: (key, value) => vault.put(key, value),
    });
    const directory: Directory = {};
    const asked: string[] = [];
    const providerLookup: GrantUsernameLookup = (username) => {
      asked.push(username);
      return Object.hasOwn(directory, username)
        ? Promise.resolve(directory[username])
        : Promise.reject(new UsernameNotFoundError(username, PROVIDER));
    };

    const harness: Harness = {
      repoDir: resolved,
      vault,
      pinStore,
      tracking,
      loader,
      directory,
      asked,
      newResolver: (options) =>
        createOAuthGrantUsernameResolver({
          store: pinStore,
          providerUrl: PROVIDER,
          lookup: () =>
            options?.lookup === undefined ? providerLookup : options.lookup,
          noLookupMessage: "no credential",
        }),
      writeGrants: (name, yaml) =>
        Deno.writeTextFile(join(resolved, "grants", name), yaml),
      async load(resolver) {
        const files = await readServeGrantFiles(resolved, {
          validateCondition: validateGrantCondition,
        });
        const parsed = new Map<string, ParsedGrantSource>();
        const unavailable = new Set<string>();
        for (const [name, result] of files.repo) {
          if (result.errors.length > 0) {
            unavailable.add(name);
            continue;
          }
          parsed.set(name, { filename: name, entries: result.entries });
        }
        const resolution = await resolveGrantFileUsernames(parsed, resolver, {
          complete: unavailable.size === 0,
        });
        const errors: GrantFileError[] = [];
        const valid = new Map();
        for (const [name, source] of resolution.sources) {
          if (source.errors.length > 0) {
            errors.push(...source.errors);
            unavailable.add(name);
            continue;
          }
          valid.set(name, source.entries);
        }
        const reconcile = await reconcileAllFileGrants(
          valid,
          tracking.fileGrantStore,
          { isSourceUnavailable: (name) => unavailable.has(name) },
        );
        return { errors, reconcile };
      },
      async decide(sub) {
        await loader.load();
        return loader.decisionService.decide(
          { principal: { kind: "user", id: sub }, collectives: [], groups: [] },
          "run",
          DEPLOY,
        )?.effect;
      },
    };
    try {
      await fn(harness);
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

function grantsFor(subject: string, effect: "allow" | "deny" = "allow") {
  return `grants:
  - subject: "${subject}"
    effect: ${effect}
    actions: [run]
    resource: "workflow:*"
`;
}

Deno.test("grant file usernames: a username grant matches the principal by its sub, not by its name", async () => {
  await withHarness(async (h) => {
    h.directory.alice = "sub-alice";
    await h.writeGrants("team.yaml", grantsFor("username:alice"));
    const { errors } = await h.load(h.newResolver());
    assertEquals(errors, []);
    assertEquals(await h.decide("sub-alice"), "allow");
    // A token-auth principal named alice is a different principal.
    assertEquals(await h.decide("alice"), undefined);
  });
});

Deno.test("grant file usernames: renaming the entry to the account's new name changes no grant", async () => {
  await withHarness(async (h) => {
    h.directory.alice = "sub-alice";
    await h.writeGrants("team.yaml", grantsFor("username:alice"));
    await h.load(h.newResolver());

    // The account is renamed, and the file follows it.
    delete h.directory.alice;
    h.directory["alice-r"] = "sub-alice";
    await h.writeGrants("team.yaml", grantsFor("username:alice-r"));
    const { errors, reconcile } = await h.load(h.newResolver());
    assertEquals(errors, []);
    assertEquals(reconcile.totalCreated, 0);
    assertEquals(reconcile.totalRevoked, 0);
    assertEquals(await h.decide("sub-alice"), "allow");
  });
});

Deno.test("grant file usernames: a pinned name is never looked up again, so a re-registered name is not re-pointed", async () => {
  await withHarness(async (h) => {
    h.directory.alice = "sub-alice";
    await h.writeGrants("team.yaml", grantsFor("username:alice"));
    await h.load(h.newResolver());

    // alice's account is deleted and someone else registers the name.
    h.directory.alice = "sub-new-owner";
    h.asked.length = 0;
    await h.writeGrants(
      "team.yaml",
      grantsFor("username:alice") + `  - subject: "username:bob"
    effect: allow
    actions: [run]
    resource: "workflow:*"
`,
    );
    h.directory.bob = "sub-bob";
    const { errors } = await h.load(h.newResolver());
    assertEquals(errors, []);
    assertEquals(h.asked, ["bob"]);
    assertEquals(await h.decide("sub-alice"), "allow");
    assertEquals(await h.decide("sub-new-owner"), undefined);
  });
});

Deno.test("grant file usernames: a name that never resolved rejects its file and keeps its stored grants", async () => {
  await withHarness(async (h) => {
    await h.writeGrants("team.yaml", grantsFor("user:sub-ops", "deny"));
    await h.load(h.newResolver());
    assertEquals(await h.decide("sub-ops"), "deny");

    await h.writeGrants("team.yaml", grantsFor("username:mallory", "deny"));
    const { errors, reconcile } = await h.load(h.newResolver());
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].message, 'Subject "username:mallory"');
    assertEquals(reconcile.totalRevoked, 0);
    // The deny the file held before is still in force.
    assertEquals(await h.decide("sub-ops"), "deny");
  });
});

Deno.test("grant file usernames: a name first seen missing stays rejected after it is registered, across a refused start", async () => {
  await withHarness(async (h) => {
    await h.writeGrants("team.yaml", grantsFor("username:alcie"));
    // Startup refuses on this error; the record is already written.
    const first = await h.load(h.newResolver());
    assertEquals(first.errors.length, 1);

    // Someone registers the typo, then serve restarts.
    h.directory.alcie = "sub-attacker";
    h.asked.length = 0;
    const second = await h.load(h.newResolver());
    assertEquals(second.errors.length, 1);
    assertStringIncludes(second.errors[0].message, "when first looked up");
    assertEquals(h.asked, []);
    assertEquals(await h.decide("sub-attacker"), undefined);
  });
});

Deno.test("grant file usernames: a file held back for a parse error keeps its pins", async () => {
  await withHarness(async (h) => {
    h.directory.alice = "sub-alice";
    await h.writeGrants("team.yaml", grantsFor("username:alice"));
    await h.load(h.newResolver());

    await h.writeGrants("team.yaml", "grants: [");
    const heldBack = await h.load(h.newResolver());
    assertEquals(heldBack.reconcile.totalRevoked, 0);

    // The name changes hands while the file is broken; once it loads again
    // the pin still names the original account.
    h.directory.alice = "sub-new-owner";
    h.asked.length = 0;
    await h.writeGrants("team.yaml", grantsFor("username:alice"));
    const { errors } = await h.load(h.newResolver());
    assertEquals(errors, []);
    assertEquals(h.asked, []);
    assertEquals(await h.decide("sub-alice"), "allow");
  });
});

Deno.test("grant file usernames: a provider outage keeps stored grants and records nothing", async () => {
  await withHarness(async (h) => {
    h.directory.alice = "sub-alice";
    await h.writeGrants("team.yaml", grantsFor("username:alice"));
    await h.load(h.newResolver());

    await h.writeGrants(
      "team.yaml",
      grantsFor("username:alice") + `  - subject: "username:bob"
    effect: allow
    actions: [run]
    resource: "workflow:*"
`,
    );
    const down: GrantUsernameLookup = () =>
      Promise.reject(new Error("connection refused"));
    const { errors, reconcile } = await h.load(h.newResolver({ lookup: down }));
    assertStringIncludes(errors[0].message, "connection refused");
    assertEquals(reconcile.totalRevoked, 0);
    assertEquals(await h.decide("sub-alice"), "allow");
    assertEquals(Object.keys((await h.pinStore.read()).missing), []);

    // Back up: bob is looked up and pinned.
    h.directory.bob = "sub-bob";
    assertEquals((await h.load(h.newResolver())).errors, []);
    assertEquals(await h.decide("sub-bob"), "allow");
  });
});

Deno.test("grant file usernames: without a credential a new name is held back, a pinned one still loads", async () => {
  await withHarness(async (h) => {
    h.directory.alice = "sub-alice";
    await h.writeGrants("a.yaml", grantsFor("username:alice"));
    await h.load(h.newResolver());

    h.directory.bob = "sub-bob";
    await h.writeGrants("b.yaml", grantsFor("username:bob"));
    const { errors } = await h.load(h.newResolver({ lookup: null }));
    assertEquals(errors.map((e) => e.filename), ["b.yaml"]);
    assertStringIncludes(errors[0].message, "no credential");
    assertEquals(await h.decide("sub-alice"), "allow");
    assertEquals(await h.decide("sub-bob"), undefined);
  });
});

Deno.test("grant file usernames: grant pins and the admin resolutions live in separate keys", async () => {
  await withHarness(async (h) => {
    await h.vault.put(
      OAUTH_RESOLVED_ADMINS_KEY,
      JSON.stringify({ admin: "sub-admin" }),
    );
    h.directory.alice = "sub-alice";
    await h.writeGrants("team.yaml", grantsFor("username:alice"));
    await h.load(h.newResolver());
    assertEquals(
      JSON.parse(await h.vault.get(OAUTH_RESOLVED_ADMINS_KEY)),
      { admin: "sub-admin" },
    );
    // The admin path rewrites its whole key; grant pins are untouched.
    await h.vault.put(OAUTH_RESOLVED_ADMINS_KEY, JSON.stringify({}));
    assertEquals((await h.pinStore.read()).pinned.alice, "sub-alice");
  });
});

Deno.test("grant file usernames: a pin another instance wrote wins over a fresh lookup", async () => {
  await withHarness(async (h) => {
    // Instance A pins alice; instance B, sharing the control plane, then
    // sees a different answer from the provider for the same name.
    h.directory.alice = "sub-alice";
    await h.writeGrants("team.yaml", grantsFor("username:alice"));
    const instanceB = h.newResolver();
    await h.load(h.newResolver());
    h.directory.alice = "sub-other";
    h.asked.length = 0;
    const { errors } = await h.load(instanceB);
    assertEquals(errors, []);
    assertEquals(h.asked, []);
    assertEquals(await h.decide("sub-alice"), "allow");
  });
});
