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

import { assertEquals, assertRejects } from "@std/assert";
import {
  createLibSwampContext,
  type ModelDeleteDeps,
} from "../libswamp/mod.ts";
import { Definition } from "../domain/definitions/definition.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { DataRecord } from "../domain/data/data_record.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../domain/models/access/server_token_model.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../domain/vaults/control_plane_vault_provider.ts";
import {
  createServerTokenGcDeps,
  type ServerTokenGcDepsInput,
} from "./server_token_gc_deps.ts";
import type { TokenGcInfo } from "./server_token_gc_service.ts";
import { createSyncGate, withSyncGate } from "./sync_gate.ts";

const TOKEN_DEF_ID = "00000000-0000-4000-8000-000000000001";
const USER_DEF_ID = "00000000-0000-4000-8000-000000000002";

function tokenRecord(
  name: string,
  overrides: Record<string, unknown> = {},
  modelName = name,
): DataRecord {
  return {
    modelId: TOKEN_DEF_ID,
    modelName,
    attributes: {
      name,
      principalId: "user:alice",
      principalEmail: "alice@example.com",
      state: "revoked",
      createdAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
      revokedAt: "2026-09-02T00:00:00.000Z",
      vaultName: TOKEN_SECRETS_VAULT_NAME,
      secretKey: `server-token-${name}`,
      ...overrides,
    },
  } as unknown as DataRecord;
}

function token(overrides: Partial<TokenGcInfo> = {}): TokenGcInfo {
  return {
    name: "ci",
    definitionId: TOKEN_DEF_ID,
    state: "revoked",
    expiresAt: "2026-10-01T00:00:00.000Z",
    vaultName: TOKEN_SECRETS_VAULT_NAME,
    secretKey: "server-token-ci",
    ...overrides,
  };
}

interface Harness {
  input: ServerTokenGcDepsInput;
  deletedSecrets: Array<[string, string]>;
  deletedDefinitions: Array<[string, string]>;
  pushes: number;
}

function harness(opts: {
  records?: DataRecord[];
  deleteVaults?: string[];
  vaultDeleteError?: Error;
  tokenDefinition?: Definition | null;
} = {}): Harness {
  const deletedSecrets: Array<[string, string]> = [];
  const deletedDefinitions: Array<[string, string]> = [];
  const deleteVaults = new Set(opts.deleteVaults ?? [TOKEN_SECRETS_VAULT_NAME]);
  const tokenDefinition = opts.tokenDefinition !== undefined
    ? opts.tokenDefinition
    : Definition.create({ id: TOKEN_DEF_ID, name: "ci", version: 1 });
  // A user model that shares the token's name. modelDelete's default lookup
  // would find it; the adapter must never reach it.
  const userDefinition = Definition.create({
    id: USER_DEF_ID,
    name: "ci",
    version: 1,
  });
  const userType = ModelType.create("command/shell");

  const modelDeleteDeps: ModelDeleteDeps = {
    lookupDefinition: () =>
      Promise.resolve({ definition: userDefinition, type: userType }),
    findAllWorkflows: () => Promise.resolve([]),
    findDataArtifacts: () => Promise.resolve([]),
    findOutputs: () => Promise.resolve([]),
    getDefinitionPath: () => "/repo/definition.yaml",
    deleteOutput: () => Promise.resolve(),
    deleteData: () => Promise.resolve(),
    deleteDefinition: (type, id) => {
      deletedDefinitions.push([type.normalized, id]);
      return Promise.resolve();
    },
    deleteEvaluatedDefinition: () => Promise.resolve(),
  };

  const h: Harness = {
    deletedSecrets,
    deletedDefinitions,
    pushes: 0,
    input: {
      intervalMs: 1000,
      gracePeriodMs: 1000,
      dataQueryService: {
        query: () => Promise.resolve(opts.records ?? []),
      },
      definitionRepo: {
        findByName: (type, name) =>
          Promise.resolve(
            type.normalized === SERVER_TOKEN_MODEL_TYPE.normalized &&
              tokenDefinition?.name === name
              ? tokenDefinition
              : null,
          ),
      },
      vaultService: {
        supportsDelete: (vault) => deleteVaults.has(vault),
        delete: (vault, key) => {
          if (opts.vaultDeleteError) {
            return Promise.reject(opts.vaultDeleteError);
          }
          deletedSecrets.push([vault, key]);
          return Promise.resolve();
        },
      },
      modelDeleteDeps,
      libCtx: createLibSwampContext(),
      pushChanged: () => {
        h.pushes++;
        return Promise.resolve();
      },
    },
  };
  return h;
}

Deno.test("createServerTokenGcDeps: listTokens maps token-main records", async () => {
  const h = harness({ records: [tokenRecord("ci")] });
  const deps = createServerTokenGcDeps(h.input);

  const tokens = await deps.listTokens();

  assertEquals(tokens, [{
    name: "ci",
    definitionId: TOKEN_DEF_ID,
    state: "revoked",
    expiresAt: "2026-10-01T00:00:00.000Z",
    revokedAt: "2026-09-02T00:00:00.000Z",
    vaultName: TOKEN_SECRETS_VAULT_NAME,
    secretKey: "server-token-ci",
  }]);
});

Deno.test("createServerTokenGcDeps: listTokens skips records that do not parse", async () => {
  const h = harness({
    records: [tokenRecord("ci", { state: "bogus" }), tokenRecord("ok")],
  });
  const deps = createServerTokenGcDeps(h.input);

  const tokens = await deps.listTokens();

  assertEquals(tokens.map((t) => t.name), ["ok"]);
});

Deno.test("createServerTokenGcDeps: listTokens skips a record whose name differs from its model", async () => {
  const h = harness({
    records: [tokenRecord("other", {}, "ci"), tokenRecord("ok")],
  });
  const deps = createServerTokenGcDeps(h.input);

  const tokens = await deps.listTokens();

  assertEquals(tokens.map((t) => t.name), ["ok"]);
});

Deno.test("createServerTokenGcDeps: deleteTokenSecret deletes the canonical key from the token secrets vault", async () => {
  const h = harness();
  const deps = createServerTokenGcDeps(h.input);

  await deps.deleteTokenSecret(token());

  assertEquals(h.deletedSecrets, [[
    TOKEN_SECRETS_VAULT_NAME,
    "server-token-ci",
  ]]);
});

Deno.test("createServerTokenGcDeps: deleteTokenSecret never deletes a non-canonical key a record names", async () => {
  const h = harness({ deleteVaults: [TOKEN_SECRETS_VAULT_NAME, "prod"] });
  const deps = createServerTokenGcDeps(h.input);

  await deps.deleteTokenSecret(
    token({ vaultName: "prod", secretKey: "db-password" }),
  );

  assertEquals(h.deletedSecrets, [[
    TOKEN_SECRETS_VAULT_NAME,
    "server-token-ci",
  ]]);
});

Deno.test("createServerTokenGcDeps: deleteTokenSecret also clears a legacy token's canonical key from its recorded vault", async () => {
  const h = harness({ deleteVaults: [TOKEN_SECRETS_VAULT_NAME, "legacy"] });
  const deps = createServerTokenGcDeps(h.input);

  await deps.deleteTokenSecret(token({ vaultName: "legacy" }));

  assertEquals(h.deletedSecrets, [
    [TOKEN_SECRETS_VAULT_NAME, "server-token-ci"],
    ["legacy", "server-token-ci"],
  ]);
});

Deno.test("createServerTokenGcDeps: deleteTokenSecret skips a recorded vault without delete support", async () => {
  const h = harness({ deleteVaults: [TOKEN_SECRETS_VAULT_NAME] });
  const deps = createServerTokenGcDeps(h.input);

  await deps.deleteTokenSecret(token({ vaultName: "read-only" }));

  assertEquals(h.deletedSecrets, [[
    TOKEN_SECRETS_VAULT_NAME,
    "server-token-ci",
  ]]);
});

Deno.test("createServerTokenGcDeps: deleteTokenSecret fails when the token secrets vault cannot delete", async () => {
  const h = harness({ deleteVaults: [] });
  const deps = createServerTokenGcDeps(h.input);

  await assertRejects(
    () => deps.deleteTokenSecret(token()),
    Error,
    "does not support deleting secrets",
  );
});

Deno.test("createServerTokenGcDeps: deleteTokenSecret treats a missing secret as deleted", async () => {
  const h = harness({
    vaultDeleteError: new Error("Secret 'server-token-ci' not found"),
  });
  const deps = createServerTokenGcDeps(h.input);

  await deps.deleteTokenSecret(token());
});

Deno.test("createServerTokenGcDeps: deleteTokenSecret rethrows other vault errors", async () => {
  const h = harness({ vaultDeleteError: new Error("access denied") });
  const deps = createServerTokenGcDeps(h.input);

  await assertRejects(
    () => deps.deleteTokenSecret(token()),
    Error,
    "access denied",
  );
});

Deno.test("createServerTokenGcDeps: deleteOAuthAccessToken deletes the token's OAuth key", async () => {
  const h = harness();
  const deps = createServerTokenGcDeps(h.input);

  await deps.deleteOAuthAccessToken("ci");

  assertEquals(h.deletedSecrets, [
    [TOKEN_SECRETS_VAULT_NAME, "oauth-access-token-ci"],
  ]);
});

Deno.test("createServerTokenGcDeps: deleteTokenRecord deletes the server-token definition, not a same-named user model", async () => {
  const h = harness();
  const deps = createServerTokenGcDeps(h.input);

  await deps.deleteTokenRecord(TOKEN_DEF_ID, "ci");

  assertEquals(h.deletedDefinitions, [
    [SERVER_TOKEN_MODEL_TYPE.normalized, TOKEN_DEF_ID],
  ]);
});

Deno.test("createServerTokenGcDeps: deleteTokenRecord leaves a server-token definition with a different id", async () => {
  const h = harness({
    tokenDefinition: Definition.create({
      id: "00000000-0000-4000-8000-000000000003",
      name: "ci",
      version: 1,
    }),
  });
  const deps = createServerTokenGcDeps(h.input);

  await deps.deleteTokenRecord(TOKEN_DEF_ID, "ci");

  assertEquals(h.deletedDefinitions, []);
});

Deno.test("createServerTokenGcDeps: deleteTokenRecord treats an already-deleted definition as done", async () => {
  const h = harness({ tokenDefinition: null });
  const deps = createServerTokenGcDeps(h.input);

  await deps.deleteTokenRecord(TOKEN_DEF_ID, "ci");

  assertEquals(h.deletedDefinitions, []);
});

Deno.test("createServerTokenGcDeps: deleteTokenRecord surfaces other delete failures", async () => {
  const h = harness();
  h.input = {
    ...h.input,
    modelDeleteDeps: {
      ...h.input.modelDeleteDeps,
      deleteDefinition: () => Promise.reject(new Error("disk full")),
    },
  };
  const deps = createServerTokenGcDeps(h.input);

  await assertRejects(
    () => deps.deleteTokenRecord(TOKEN_DEF_ID, "ci"),
    Error,
    "disk full",
  );
});

Deno.test("createServerTokenGcDeps: deleteTokenRecord pushes the deletes to the remote datastore", async () => {
  const h = harness();
  const deps = createServerTokenGcDeps(h.input);

  await deps.deleteTokenRecord(TOKEN_DEF_ID, "ci");

  assertEquals(h.pushes, 1);
});

Deno.test("createServerTokenGcDeps: deleteTokenRecord does not push when the definition is already gone", async () => {
  const h = harness({ tokenDefinition: null });
  const deps = createServerTokenGcDeps(h.input);

  await deps.deleteTokenRecord(TOKEN_DEF_ID, "ci");

  assertEquals(h.pushes, 0);
});

Deno.test("createServerTokenGcDeps: deleteTokenRecord still pushes after a partial delete failure", async () => {
  const h = harness();
  h.input = {
    ...h.input,
    modelDeleteDeps: {
      ...h.input.modelDeleteDeps,
      deleteDefinition: () => Promise.reject(new Error("disk full")),
    },
  };
  const deps = createServerTokenGcDeps(h.input);

  await assertRejects(() => deps.deleteTokenRecord(TOKEN_DEF_ID, "ci"));

  assertEquals(h.pushes, 1);
});

Deno.test("createServerTokenGcDeps: a failed push does not fail deleteTokenRecord", async () => {
  const h = harness();
  const deps = createServerTokenGcDeps({
    ...h.input,
    pushChanged: () => Promise.reject(new Error("remote unavailable")),
  });

  await deps.deleteTokenRecord(TOKEN_DEF_ID, "ci");

  assertEquals(h.deletedDefinitions.length, 1);
});

Deno.test("createServerTokenGcDeps: deleteTokenRecord waits for the sync gate", async () => {
  const h = harness();
  const syncGate = createSyncGate();
  const deps = createServerTokenGcDeps({ ...h.input, syncGate });

  let releaseHolder!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  let holderEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    holderEntered = resolve;
  });
  const holder = withSyncGate(syncGate, async () => {
    holderEntered();
    await held;
  });
  await entered;

  const deletion = deps.deleteTokenRecord(TOKEN_DEF_ID, "ci");
  // Let the deletion run as far as it can while the gate is held.
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(h.deletedDefinitions, []);
  assertEquals(h.pushes, 0);

  releaseHolder();
  await holder;
  await deletion;
  assertEquals(h.deletedDefinitions.length, 1);
  assertEquals(h.pushes, 1);
});
