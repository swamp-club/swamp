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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { Grant } from "../models/access/grant_model.ts";
import type { GrantFileEntry } from "./grant_file.ts";
import {
  type FileGrantStore,
  reconcileAllFileGrants,
} from "./grant_file_reconciler.ts";

await initializeLogging({});

function makeFileGrant(
  overrides: Partial<Grant> & { source: string },
): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "*" },
    state: "active",
    createdBy: { kind: "user", id: "system" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function createMockStore(
  existingGrants: Map<
    string,
    { grant: Grant; modelId: string; instanceName: string }
  > = new Map(),
): FileGrantStore & {
  written: Map<string, Grant>;
  definitions: Set<string>;
} {
  const written = new Map<string, Grant>();
  const definitions = new Set<string>();
  const grants = new Map(existingGrants);

  return {
    written,
    definitions,
    queryFileGrants() {
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
      grants.set(instanceName, { grant, modelId: _modelId, instanceName });
      return Promise.resolve();
    },
  };
}

const entry1: GrantFileEntry = {
  subject: { kind: "idp-group", name: "platform-eng" },
  effect: "allow",
  actions: ["run"],
  resource: { kind: "workflow", pattern: "@acme/*" },
};

const entry2: GrantFileEntry = {
  subject: { kind: "idp-group", name: "developers" },
  effect: "allow",
  actions: ["read"],
  resource: { kind: "data", pattern: "*" },
};

Deno.test("reconcileAllFileGrants: creates grants for new entries", async () => {
  const store = createMockStore();
  const result = await reconcileAllFileGrants(
    new Map([["platform-team.yaml", [entry1]]]),
    store,
  );

  assertEquals(result.totalCreated, 1);
  assertEquals(result.totalRevoked, 0);
  assertEquals(result.totalReactivated, 0);
  assertEquals(result.totalUnchanged, 0);
  assertEquals(store.written.size, 1);

  const grant = [...store.written.values()][0];
  assertEquals(grant.subject, { kind: "idp-group", name: "platform-eng" });
  assertEquals(grant.source, "file:platform-team.yaml");
  assertEquals(grant.state, "active");
});

Deno.test("reconcileAllFileGrants: leaves unchanged grants untouched", async () => {
  const existing = new Map([
    [
      "model-1",
      {
        grant: makeFileGrant({
          source: "file:team.yaml",
          subject: { kind: "idp-group", name: "platform-eng" },
          actions: ["run"],
          resource: { kind: "workflow", pattern: "@acme/*" },
        }),
        modelId: "model-1",
        instanceName: "inst-1",
      },
    ],
  ]);
  const store = createMockStore(existing);

  const result = await reconcileAllFileGrants(
    new Map([["team.yaml", [entry1]]]),
    store,
  );

  assertEquals(result.totalCreated, 0);
  assertEquals(result.totalRevoked, 0);
  assertEquals(result.totalReactivated, 0);
  assertEquals(result.totalUnchanged, 1);
  assertEquals(store.written.size, 0);
});

Deno.test("reconcileAllFileGrants: revokes grants removed from file", async () => {
  const existing = new Map([
    [
      "model-1",
      {
        grant: makeFileGrant({
          source: "file:team.yaml",
          subject: { kind: "idp-group", name: "platform-eng" },
          actions: ["run"],
          resource: { kind: "workflow", pattern: "@acme/*" },
        }),
        modelId: "model-1",
        instanceName: "inst-1",
      },
    ],
    [
      "model-2",
      {
        grant: makeFileGrant({
          source: "file:team.yaml",
          subject: { kind: "idp-group", name: "developers" },
          actions: ["read"],
          resource: { kind: "data", pattern: "*" },
        }),
        modelId: "model-2",
        instanceName: "inst-2",
      },
    ],
  ]);
  const store = createMockStore(existing);

  const result = await reconcileAllFileGrants(
    new Map([["team.yaml", [entry1]]]),
    store,
  );

  assertEquals(result.totalCreated, 0);
  assertEquals(result.totalRevoked, 1);
  assertEquals(result.totalUnchanged, 1);

  const revokedGrant = store.written.get("inst-2")!;
  assertEquals(revokedGrant.state, "revoked");
});

Deno.test("reconcileAllFileGrants: reactivates revoked grant when re-added", async () => {
  const existing = new Map([
    [
      "model-1",
      {
        grant: makeFileGrant({
          source: "file:team.yaml",
          subject: { kind: "idp-group", name: "platform-eng" },
          actions: ["run"],
          resource: { kind: "workflow", pattern: "@acme/*" },
          state: "revoked",
        }),
        modelId: "model-1",
        instanceName: "inst-1",
      },
    ],
  ]);
  const store = createMockStore(existing);

  const result = await reconcileAllFileGrants(
    new Map([["team.yaml", [entry1]]]),
    store,
  );

  assertEquals(result.totalCreated, 0);
  assertEquals(result.totalRevoked, 0);
  assertEquals(result.totalReactivated, 1);
  assertEquals(result.totalUnchanged, 0);

  const reactivated = store.written.get("inst-1")!;
  assertEquals(reactivated.state, "active");
});

Deno.test("reconcileAllFileGrants: does not touch method or config grants", async () => {
  const existing = new Map([
    [
      "model-1",
      {
        grant: makeFileGrant({
          source: "method",
          subject: { kind: "user", name: "sarah" },
          actions: ["run"],
          resource: { kind: "workflow", pattern: "*" },
        }),
        modelId: "model-1",
        instanceName: "inst-1",
      },
    ],
    [
      "model-2",
      {
        grant: makeFileGrant({
          source: "config",
          subject: { kind: "user", name: "admin" },
          actions: ["admin"],
          resource: { kind: "access", pattern: "*" },
        }),
        modelId: "model-2",
        instanceName: "inst-2",
      },
    ],
  ]);
  const store = createMockStore(existing);

  const result = await reconcileAllFileGrants(
    new Map([["team.yaml", []]]),
    store,
  );

  assertEquals(result.totalCreated, 0);
  assertEquals(result.totalRevoked, 0);
  assertEquals(store.written.size, 0);
});

Deno.test("reconcileAllFileGrants: matches with different action order", async () => {
  const existing = new Map([
    [
      "model-1",
      {
        grant: makeFileGrant({
          source: "file:team.yaml",
          subject: { kind: "user", name: "adam" },
          actions: ["read", "run"],
          resource: { kind: "workflow", pattern: "*" },
        }),
        modelId: "model-1",
        instanceName: "inst-1",
      },
    ],
  ]);
  const store = createMockStore(existing);

  const entry: GrantFileEntry = {
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["run", "read"],
    resource: { kind: "workflow", pattern: "*" },
  };

  const result = await reconcileAllFileGrants(
    new Map([["team.yaml", [entry]]]),
    store,
  );

  assertEquals(result.totalUnchanged, 1);
  assertEquals(result.totalCreated, 0);
  assertEquals(store.written.size, 0);
});

Deno.test("reconcileAllFileGrants: matches with trimmed condition whitespace", async () => {
  const existing = new Map([
    [
      "model-1",
      {
        grant: makeFileGrant({
          source: "file:team.yaml",
          subject: { kind: "user", name: "adam" },
          actions: ["run"],
          resource: { kind: "workflow", pattern: "*" },
          condition: '  tags.env == "prod"  ',
        }),
        modelId: "model-1",
        instanceName: "inst-1",
      },
    ],
  ]);
  const store = createMockStore(existing);

  const entry: GrantFileEntry = {
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "*" },
    condition: 'tags.env == "prod"',
  };

  const result = await reconcileAllFileGrants(
    new Map([["team.yaml", [entry]]]),
    store,
  );

  assertEquals(result.totalUnchanged, 1);
  assertEquals(result.totalCreated, 0);
  assertEquals(store.written.size, 0);
});

Deno.test("reconcileAllFileGrants: reconciles multiple files", async () => {
  const store = createMockStore();
  const fileEntries = new Map<string, GrantFileEntry[]>([
    ["platform-team.yaml", [entry1]],
    ["compliance.yaml", [entry2]],
  ]);

  const result = await reconcileAllFileGrants(fileEntries, store);

  assertEquals(result.filesProcessed, 2);
  assertEquals(result.totalCreated, 2);
  assertEquals(result.totalRevoked, 0);
  assertEquals(result.perFile.size, 2);
  assertEquals(result.perFile.get("platform-team.yaml")!.created, 1);
  assertEquals(result.perFile.get("compliance.yaml")!.created, 1);
});

Deno.test("reconcileAllFileGrants: empty file map is no-op", async () => {
  const store = createMockStore();
  const result = await reconcileAllFileGrants(new Map(), store);

  assertEquals(result.filesProcessed, 0);
  assertEquals(result.totalCreated, 0);
  assertEquals(result.totalRevoked, 0);
});

Deno.test("reconcileAllFileGrants: revokes grants from deleted files", async () => {
  const existing = new Map([
    [
      "model-1",
      {
        grant: makeFileGrant({
          source: "file:deleted.yaml",
          subject: { kind: "idp-group", name: "interns" },
          actions: ["run"],
          resource: { kind: "workflow", pattern: "@acme/*" },
        }),
        modelId: "model-1",
        instanceName: "inst-1",
      },
    ],
  ]);
  const store = createMockStore(existing);

  const result = await reconcileAllFileGrants(new Map(), store);

  assertEquals(result.totalRevoked, 1);
  assertEquals(result.totalCreated, 0);

  const revokedGrant = store.written.get("inst-1")!;
  assertEquals(revokedGrant.state, "revoked");
});

Deno.test("reconcileAllFileGrants: does not touch other files' grants when one is deleted", async () => {
  const existing = new Map([
    [
      "model-1",
      {
        grant: makeFileGrant({
          source: "file:keep.yaml",
          subject: { kind: "user", name: "adam" },
          actions: ["run"],
          resource: { kind: "workflow", pattern: "*" },
        }),
        modelId: "model-1",
        instanceName: "inst-1",
      },
    ],
    [
      "model-2",
      {
        grant: makeFileGrant({
          source: "file:deleted.yaml",
          subject: { kind: "idp-group", name: "interns" },
          actions: ["run"],
          resource: { kind: "workflow", pattern: "@acme/*" },
        }),
        modelId: "model-2",
        instanceName: "inst-2",
      },
    ],
  ]);
  const store = createMockStore(existing);

  const keepEntry: GrantFileEntry = {
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "*" },
  };

  const result = await reconcileAllFileGrants(
    new Map([["keep.yaml", [keepEntry]]]),
    store,
  );

  assertEquals(result.totalUnchanged, 1);
  assertEquals(result.totalRevoked, 1);
  assertEquals(result.totalCreated, 0);

  const revokedGrant = store.written.get("inst-2")!;
  assertEquals(revokedGrant.state, "revoked");
  assertEquals(store.written.has("inst-1"), false);
});
