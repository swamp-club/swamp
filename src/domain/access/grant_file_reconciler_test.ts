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
      // Keyed by modelId, as the real store's queryFileGrants is.
      grants.set(_modelId, { grant, modelId: _modelId, instanceName });
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

Deno.test("reconcileAllFileGrants: updates methods in place when identity matches", async () => {
  const existingGrant = makeFileGrant({
    source: "file:ops.yaml",
    subject: { kind: "user", name: "monitor" },
    actions: ["run"],
    resource: { kind: "model", pattern: "@acme/my-model" },
    methods: ["read"],
  });
  const existingGrants = new Map([
    ["model-1", {
      grant: existingGrant,
      modelId: "model-1",
      instanceName: "inst-1",
    }],
  ]);
  const store = createMockStore(existingGrants);

  const updatedEntry: GrantFileEntry = {
    subject: { kind: "user", name: "monitor" },
    effect: "allow",
    actions: ["run"],
    resource: { kind: "model", pattern: "@acme/my-model" },
    methods: ["read", "list"],
  };

  const fileEntries = new Map([["ops.yaml", [updatedEntry]]]);
  const result = await reconcileAllFileGrants(fileEntries, store);

  assertEquals(result.totalUpdated, 1);
  assertEquals(result.totalCreated, 0);
  assertEquals(result.totalRevoked, 0);
  assertEquals(result.totalUnchanged, 0);

  const writtenGrant = store.written.get("inst-1")!;
  assertEquals(writtenGrant.methods, ["read", "list"]);
  assertEquals(writtenGrant.id, existingGrant.id);
});

Deno.test("reconcileAllFileGrants: no update when methods unchanged", async () => {
  const existingGrant = makeFileGrant({
    source: "file:ops.yaml",
    subject: { kind: "user", name: "monitor" },
    actions: ["run"],
    resource: { kind: "model", pattern: "@acme/my-model" },
    methods: ["list", "read"],
  });
  const existingGrants = new Map([
    ["model-1", {
      grant: existingGrant,
      modelId: "model-1",
      instanceName: "inst-1",
    }],
  ]);
  const store = createMockStore(existingGrants);

  const entry: GrantFileEntry = {
    subject: { kind: "user", name: "monitor" },
    effect: "allow",
    actions: ["run"],
    resource: { kind: "model", pattern: "@acme/my-model" },
    methods: ["read", "list"],
  };

  const fileEntries = new Map([["ops.yaml", [entry]]]);
  const result = await reconcileAllFileGrants(fileEntries, store);

  assertEquals(result.totalUpdated, 0);
  assertEquals(result.totalUnchanged, 1);
});

Deno.test("reconcileAllFileGrants: reactivation applies updated methods from file entry", async () => {
  const revokedGrant = makeFileGrant({
    source: "file:ops.yaml",
    subject: { kind: "user", name: "monitor" },
    actions: ["run"],
    resource: { kind: "model", pattern: "@acme/my-model" },
    methods: ["read"],
    state: "revoked",
  });
  const existingGrants = new Map([
    ["model-1", {
      grant: revokedGrant,
      modelId: "model-1",
      instanceName: "inst-1",
    }],
  ]);
  const store = createMockStore(existingGrants);

  const entry: GrantFileEntry = {
    subject: { kind: "user", name: "monitor" },
    effect: "allow",
    actions: ["run"],
    resource: { kind: "model", pattern: "@acme/my-model" },
    methods: ["read", "list"],
  };

  const fileEntries = new Map([["ops.yaml", [entry]]]);
  const result = await reconcileAllFileGrants(fileEntries, store);

  assertEquals(result.totalReactivated, 1);
  assertEquals(result.totalUpdated, 0);

  const reactivatedGrant = store.written.get("inst-1")!;
  assertEquals(reactivatedGrant.state, "active");
  assertEquals(reactivatedGrant.methods, ["read", "list"]);
});

Deno.test("reconcileAllFileGrants: reports a deleted file only in the reconcile that revokes its grants", async () => {
  const existing = new Map([
    [
      "model-1",
      {
        grant: makeFileGrant({ source: "file:deleted.yaml" }),
        modelId: "model-1",
        instanceName: "inst-1",
      },
    ],
  ]);
  const store = createMockStore(existing);

  const first = await reconcileAllFileGrants(new Map(), store);
  assertEquals(first.perFile.get("deleted.yaml")?.revoked, 1);

  const second = await reconcileAllFileGrants(new Map(), store);
  assertEquals(second.perFile.size, 0);
  assertEquals(second.totalRevoked, 0);
  assertEquals(second.totalUnchanged, 0);
});

Deno.test("reconcileAllFileGrants: does not count revoked grants as unchanged", async () => {
  const existing = new Map([
    [
      "model-1",
      {
        grant: makeFileGrant({ source: "file:team.yaml" }),
        modelId: "model-1",
        instanceName: "inst-1",
      },
    ],
    [
      "model-2",
      {
        grant: makeFileGrant({
          source: "file:team.yaml",
          subject: { kind: "user", name: "former" },
          state: "revoked",
        }),
        modelId: "model-2",
        instanceName: "inst-2",
      },
    ],
  ]);
  const store = createMockStore(existing);

  const entry: GrantFileEntry = {
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "*" },
  };

  const result = await reconcileAllFileGrants(
    new Map([["team.yaml", [entry]]]),
    store,
  );

  assertEquals(result.perFile.get("team.yaml")?.unchanged, 1);
  assertEquals(result.totalUnchanged, 1);
  assertEquals(store.written.size, 0);
});

Deno.test("reconcileAllFileGrants: revokes grants stored under a second source for the same file once", async () => {
  // Grants stored twice before swamp-club#2788: once by bare filename, once
  // by the grants-dir full path.
  const fullPath = "/srv/repo/grants/admin.yaml";
  const existing = new Map([
    [
      "model-1",
      {
        grant: makeFileGrant({ source: "file:admin.yaml" }),
        modelId: "model-1",
        instanceName: "inst-1",
      },
    ],
    [
      "model-2",
      {
        grant: makeFileGrant({ source: `file:${fullPath}` }),
        modelId: "model-2",
        instanceName: "inst-2",
      },
    ],
  ]);
  const store = createMockStore(existing);

  const entry: GrantFileEntry = {
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "*" },
  };
  const fileEntries = new Map([["admin.yaml", [entry]]]);

  const first = await reconcileAllFileGrants(fileEntries, store);
  assertEquals(first.perFile.get("admin.yaml")?.unchanged, 1);
  assertEquals(first.perFile.get(fullPath)?.revoked, 1);
  assertEquals(store.written.get("inst-2")?.state, "revoked");
  assertEquals(store.written.has("inst-1"), false);

  const second = await reconcileAllFileGrants(fileEntries, store);
  assertEquals([...second.perFile.keys()], ["admin.yaml"]);
  assertEquals(second.totalRevoked, 0);
  assertEquals(second.totalUnchanged, 1);
});

function duplicateCopies(
  source: string,
  modelIds: string[],
  overrides: Partial<Grant> = {},
): Map<string, { grant: Grant; modelId: string; instanceName: string }> {
  return new Map(modelIds.map((modelId) => [
    modelId,
    {
      grant: makeFileGrant({ source, ...overrides }),
      modelId,
      instanceName: `inst-${modelId}`,
    },
  ]));
}

const adamEntry: GrantFileEntry = {
  subject: { kind: "user", name: "adam" },
  effect: "allow",
  actions: ["run"],
  resource: { kind: "workflow", pattern: "*" },
};

Deno.test("reconcileAllFileGrants: revokes every active copy of a removed entry", async () => {
  // Two serve instances on one datastore each created a copy
  // (swamp-club#2822).
  const store = createMockStore(
    duplicateCopies("file:team.yaml", ["model-b", "model-a"]),
  );

  const result = await reconcileAllFileGrants(
    new Map([["team.yaml", []]]),
    store,
  );

  assertEquals(result.perFile.get("team.yaml")?.revoked, 2);
  assertEquals(store.written.get("inst-model-a")?.state, "revoked");
  assertEquals(store.written.get("inst-model-b")?.state, "revoked");

  const second = await reconcileAllFileGrants(
    new Map([["team.yaml", []]]),
    store,
  );
  assertEquals(second.totalRevoked, 0);
});

Deno.test("reconcileAllFileGrants: revokes every active copy of a deleted file", async () => {
  const store = createMockStore(
    duplicateCopies("file:admin.yaml", ["model-a", "model-b"]),
  );

  const result = await reconcileAllFileGrants(new Map(), store);

  assertEquals(result.perFile.get("admin.yaml")?.revoked, 2);
  assertEquals(store.written.get("inst-model-a")?.state, "revoked");
  assertEquals(store.written.get("inst-model-b")?.state, "revoked");
});

Deno.test("reconcileAllFileGrants: keeps the lowest-modelId copy of a desired entry and revokes the others", async () => {
  const store = createMockStore(
    duplicateCopies("file:team.yaml", ["model-c", "model-a", "model-b"]),
  );

  const result = await reconcileAllFileGrants(
    new Map([["team.yaml", [adamEntry]]]),
    store,
  );

  const perFile = result.perFile.get("team.yaml");
  assertEquals(perFile?.unchanged, 1);
  assertEquals(perFile?.revoked, 2);
  assertEquals(store.written.has("inst-model-a"), false);
  assertEquals(store.written.get("inst-model-b")?.state, "revoked");
  assertEquals(store.written.get("inst-model-c")?.state, "revoked");

  const second = await reconcileAllFileGrants(
    new Map([["team.yaml", [adamEntry]]]),
    store,
  );
  assertEquals(second.totalRevoked, 0);
  assertEquals(second.totalUnchanged, 1);
});

Deno.test("reconcileAllFileGrants: keeps an active copy over a lower-modelId revoked one", async () => {
  const existing = duplicateCopies("file:team.yaml", ["model-b"]);
  existing.set("model-a", {
    grant: makeFileGrant({ source: "file:team.yaml", state: "revoked" }),
    modelId: "model-a",
    instanceName: "inst-model-a",
  });
  const store = createMockStore(existing);

  const result = await reconcileAllFileGrants(
    new Map([["team.yaml", [adamEntry]]]),
    store,
  );

  assertEquals(result.totalUnchanged, 1);
  assertEquals(result.totalReactivated, 0);
  assertEquals(store.written.size, 0);
});

Deno.test("reconcileAllFileGrants: reactivates only one of several revoked copies", async () => {
  const store = createMockStore(
    duplicateCopies("file:team.yaml", ["model-b", "model-a"], {
      state: "revoked",
    }),
  );

  const result = await reconcileAllFileGrants(
    new Map([["team.yaml", [adamEntry]]]),
    store,
  );

  assertEquals(result.totalReactivated, 1);
  assertEquals(store.written.get("inst-model-a")?.state, "active");
  assertEquals(store.written.has("inst-model-b"), false);
});

Deno.test("reconcileAllFileGrants: updates methods on the kept copy and revokes the stale duplicate", async () => {
  const store = createMockStore(
    duplicateCopies("file:team.yaml", ["model-a", "model-b"]),
  );

  const result = await reconcileAllFileGrants(
    new Map([["team.yaml", [{ ...adamEntry, methods: ["read"] }]]]),
    store,
  );

  assertEquals(result.totalUpdated, 1);
  assertEquals(result.totalRevoked, 1);
  assertEquals(store.written.get("inst-model-a")?.methods, ["read"]);
  assertEquals(store.written.get("inst-model-b")?.state, "revoked");
});

Deno.test("reconcileAllFileGrants: leaves the grants of an unavailable source unchanged", async () => {
  // A file that failed to read or validate is not a deleted file
  // (swamp-club#2823).
  const existing = duplicateCopies("file:deny.yaml", ["model-a"], {
    effect: "deny",
  });
  for (const [id, copy] of duplicateCopies("file:gone.yaml", ["model-g"])) {
    existing.set(id, copy);
  }
  const store = createMockStore(existing);

  const result = await reconcileAllFileGrants(new Map(), store, {
    isSourceUnavailable: (filename) => filename === "deny.yaml",
  });

  assertEquals(result.perFile.has("deny.yaml"), false);
  assertEquals(store.written.has("inst-model-a"), false);
  assertEquals(result.perFile.get("gone.yaml")?.revoked, 1);
  assertEquals(store.written.get("inst-model-g")?.state, "revoked");
});
