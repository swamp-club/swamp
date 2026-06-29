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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { Grant } from "../models/access/grant_model.ts";
import {
  type AdminGrantStore,
  hashPrincipal,
  instanceNameForAdmin,
  materializeAdmins,
  migrateGrantDefinitions,
} from "./admin_materializer.ts";

await initializeLogging({});

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["admin"],
    resource: { kind: "access", pattern: "*" },
    state: "active",
    source: "config",
    createdBy: { kind: "user", id: "system" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function createMockStore(
  existingGrants: Map<string, { grant: Grant; modelId: string }> = new Map(),
): AdminGrantStore & {
  written: Map<string, Grant>;
  definitions: Set<string>;
} {
  const written = new Map<string, Grant>();
  const definitions = new Set<string>();
  const grants = new Map(existingGrants);

  return {
    written,
    definitions,
    queryConfigGrants() {
      return Promise.resolve(new Map(grants));
    },
    ensureDefinition(instanceName: string) {
      definitions.add(instanceName);
      return Promise.resolve(`model-id-for-${instanceName}`);
    },
    writeGrant(
      _modelId: string,
      instanceName: string,
      grant: Grant,
    ) {
      written.set(instanceName, grant);
      grants.set(instanceName, { grant, modelId: _modelId });
      return Promise.resolve();
    },
  };
}

Deno.test("materializeAdmins: creates grants for new admins", async () => {
  const store = createMockStore();
  const result = await materializeAdmins("token", ["user:adam"], store);

  assertEquals(result.created, 1);
  assertEquals(result.revoked, 0);
  assertEquals(result.reactivated, 0);
  assertEquals(result.unchanged, 0);

  const hash = await hashPrincipal("user:adam");
  const instanceName = instanceNameForAdmin(hash);
  const grant = store.written.get(instanceName)!;
  assertEquals(grant.subject, { kind: "user", name: "adam" });
  assertEquals(grant.effect, "allow");
  assertEquals(grant.actions, ["admin"]);
  assertEquals(grant.resource, { kind: "access", pattern: "*" });
  assertEquals(grant.state, "active");
  assertEquals(grant.source, "config");
  assertEquals(grant.createdBy, { kind: "user", id: "system" });
  assertEquals(store.definitions.has(instanceName), true);
});

Deno.test("materializeAdmins: idempotent on second run with same admins", async () => {
  const hash = await hashPrincipal("user:adam");
  const instanceName = instanceNameForAdmin(hash);
  const existing = new Map([
    [instanceName, { grant: makeGrant(), modelId: "model-1" }],
  ]);
  const store = createMockStore(existing);

  const result = await materializeAdmins("token", ["user:adam"], store);

  assertEquals(result.created, 0);
  assertEquals(result.revoked, 0);
  assertEquals(result.reactivated, 0);
  assertEquals(result.unchanged, 1);
  assertEquals(store.written.size, 0);
});

Deno.test("materializeAdmins: revokes grants for removed admins", async () => {
  const hashAdam = await hashPrincipal("user:adam");
  const hashSarah = await hashPrincipal("user:sarah");
  const nameAdam = instanceNameForAdmin(hashAdam);
  const nameSarah = instanceNameForAdmin(hashSarah);
  const existing = new Map([
    [nameAdam, { grant: makeGrant(), modelId: "model-1" }],
    [
      nameSarah,
      {
        grant: makeGrant({ subject: { kind: "user", name: "sarah" } }),
        modelId: "model-2",
      },
    ],
  ]);
  const store = createMockStore(existing);

  const result = await materializeAdmins("token", ["user:adam"], store);

  assertEquals(result.created, 0);
  assertEquals(result.revoked, 1);
  assertEquals(result.unchanged, 1);

  const revokedGrant = store.written.get(nameSarah)!;
  assertEquals(revokedGrant.state, "revoked");
});

Deno.test("materializeAdmins: idempotent after revocation", async () => {
  const hashAdam = await hashPrincipal("user:adam");
  const hashSarah = await hashPrincipal("user:sarah");
  const nameAdam = instanceNameForAdmin(hashAdam);
  const nameSarah = instanceNameForAdmin(hashSarah);
  const existing = new Map([
    [nameAdam, { grant: makeGrant(), modelId: "model-1" }],
    [
      nameSarah,
      {
        grant: makeGrant({
          subject: { kind: "user", name: "sarah" },
          state: "revoked",
        }),
        modelId: "model-2",
      },
    ],
  ]);
  const store = createMockStore(existing);

  const result = await materializeAdmins("token", ["user:adam"], store);

  assertEquals(result.created, 0);
  assertEquals(result.revoked, 0);
  assertEquals(result.reactivated, 0);
  assertEquals(result.unchanged, 2);
  assertEquals(store.written.size, 0);
});

Deno.test("materializeAdmins: re-activates grant after add-remove-re-add cycle", async () => {
  const hash = await hashPrincipal("user:adam");
  const instanceName = instanceNameForAdmin(hash);

  const store = createMockStore();

  const r1 = await materializeAdmins("token", ["user:adam"], store);
  assertEquals(r1.created, 1);

  const r2 = await materializeAdmins("token", [], store);
  assertEquals(r2.revoked, 1);
  const revokedGrant = store.written.get(instanceName)!;
  assertEquals(revokedGrant.state, "revoked");

  const r3 = await materializeAdmins("token", ["user:adam"], store);
  assertEquals(r3.reactivated, 1);
  const reactivatedGrant = store.written.get(instanceName)!;
  assertEquals(reactivatedGrant.state, "active");
});

Deno.test("materializeAdmins: runtime source:method grants are untouched", async () => {
  // Source:method grants are filtered out by queryConfigGrants,
  // so the materializer never sees them. Verify it only creates
  // the requested admin grant and doesn't touch other instances.
  const store = createMockStore();

  const result = await materializeAdmins("token", ["user:adam"], store);

  assertEquals(result.created, 1);
  assertEquals(result.revoked, 0);

  const hash = await hashPrincipal("user:adam");
  const instanceName = instanceNameForAdmin(hash);
  assertEquals(store.written.has(instanceName), true);
  assertEquals(store.written.has("grant-tom"), false);
});

Deno.test("materializeAdmins: mode none skips entirely", async () => {
  const store = createMockStore();
  const result = await materializeAdmins("none", ["user:adam"], store);

  assertEquals(result.created, 0);
  assertEquals(result.revoked, 0);
  assertEquals(result.reactivated, 0);
  assertEquals(result.unchanged, 0);
  assertEquals(store.written.size, 0);
  assertEquals(store.definitions.size, 0);
});

Deno.test("materializeAdmins: handles multiple admins", async () => {
  const store = createMockStore();
  const result = await materializeAdmins(
    "token",
    ["user:adam", "user:sarah", "user:agent-1"],
    store,
  );

  assertEquals(result.created, 3);
  assertEquals(store.written.size, 3);
  assertEquals(store.definitions.size, 3);
});

Deno.test("materializeAdmins: works with oauth mode", async () => {
  const store = createMockStore();
  const result = await materializeAdmins("oauth", ["user:adam"], store);

  assertEquals(result.created, 1);
});

Deno.test("hashPrincipal: deterministic across calls", async () => {
  const h1 = await hashPrincipal("user:adam");
  const h2 = await hashPrincipal("user:adam");
  assertEquals(h1, h2);
});

Deno.test("hashPrincipal: different principals produce different hashes", async () => {
  const h1 = await hashPrincipal("user:adam");
  const h2 = await hashPrincipal("user:sarah");
  assertEquals(h1 !== h2, true);
});

Deno.test("instanceNameForAdmin: produces grant-config- prefix", () => {
  assertEquals(
    instanceNameForAdmin("abc123").startsWith("grant-config-"),
    true,
  );
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
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

Deno.test("migrateGrantDefinitions: moves YAML files from source to destination", async () => {
  await withTempDir(async (dir) => {
    const sourceDir = join(dir, "models", "swamp", "grant");
    const destDir = join(dir, ".swamp", "auto-definitions", "swamp", "grant");

    await ensureDir(sourceDir);
    await Deno.writeTextFile(
      join(sourceDir, "abc-123.yaml"),
      "name: grant-config-abc\ntype: swamp/grant\n",
    );
    await Deno.writeTextFile(
      join(sourceDir, "def-456.yaml"),
      "name: grant-config-def\ntype: swamp/grant\n",
    );

    const result = await migrateGrantDefinitions(sourceDir, destDir);

    assertEquals(result.moved, 2);
    assertEquals(result.skipped, 0);

    const destContent1 = await Deno.readTextFile(
      join(destDir, "abc-123.yaml"),
    );
    assertEquals(destContent1, "name: grant-config-abc\ntype: swamp/grant\n");

    const destContent2 = await Deno.readTextFile(
      join(destDir, "def-456.yaml"),
    );
    assertEquals(destContent2, "name: grant-config-def\ntype: swamp/grant\n");
  });
});

Deno.test("migrateGrantDefinitions: no-op when source directory does not exist", async () => {
  await withTempDir(async (dir) => {
    const sourceDir = join(dir, "models", "swamp", "grant");
    const destDir = join(dir, ".swamp", "auto-definitions", "swamp", "grant");

    const result = await migrateGrantDefinitions(sourceDir, destDir);

    assertEquals(result.moved, 0);
    assertEquals(result.skipped, 0);
  });
});

Deno.test("migrateGrantDefinitions: skips files that already exist at destination", async () => {
  await withTempDir(async (dir) => {
    const sourceDir = join(dir, "models", "swamp", "grant");
    const destDir = join(dir, ".swamp", "auto-definitions", "swamp", "grant");

    await ensureDir(sourceDir);
    await ensureDir(destDir);

    await Deno.writeTextFile(
      join(sourceDir, "abc-123.yaml"),
      "source version",
    );
    await Deno.writeTextFile(
      join(destDir, "abc-123.yaml"),
      "dest version",
    );
    await Deno.writeTextFile(
      join(sourceDir, "def-456.yaml"),
      "only in source",
    );

    const result = await migrateGrantDefinitions(sourceDir, destDir);

    assertEquals(result.moved, 1);
    assertEquals(result.skipped, 1);

    const destExisting = await Deno.readTextFile(
      join(destDir, "abc-123.yaml"),
    );
    assertEquals(destExisting, "dest version");

    const destMoved = await Deno.readTextFile(join(destDir, "def-456.yaml"));
    assertEquals(destMoved, "only in source");
  });
});

Deno.test("migrateGrantDefinitions: ignores non-YAML files", async () => {
  await withTempDir(async (dir) => {
    const sourceDir = join(dir, "models", "swamp", "grant");
    const destDir = join(dir, ".swamp", "auto-definitions", "swamp", "grant");

    await ensureDir(sourceDir);
    await Deno.writeTextFile(
      join(sourceDir, "abc-123.yaml"),
      "content",
    );
    await Deno.writeTextFile(
      join(sourceDir, "notes.txt"),
      "not a definition",
    );

    const result = await migrateGrantDefinitions(sourceDir, destDir);

    assertEquals(result.moved, 1);
    assertEquals(result.skipped, 0);
  });
});
