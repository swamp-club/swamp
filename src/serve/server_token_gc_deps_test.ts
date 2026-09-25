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
const OTHER_DEF_ID = "00000000-0000-4000-8000-000000000003";

type DataArtifacts = Awaited<ReturnType<ModelDeleteDeps["findDataArtifacts"]>>;

function tokenAttrs(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
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
  };
}

function tokenRecord(
  name: string,
  overrides: Record<string, unknown> = {},
  modelName = name,
): DataRecord {
  return {
    modelId: TOKEN_DEF_ID,
    modelName,
    attributes: tokenAttrs(name, overrides),
  } as unknown as DataRecord;
}

function listed(overrides: Partial<TokenGcInfo> = {}): TokenGcInfo {
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

const always = () => true;

interface Harness {
  input: ServerTokenGcDepsInput;
  /** Every mutation, in order: "secret:<vault>/<key>", "data:<id>/<name>", "definition:<id>", "push". */
  events: string[];
}

function harness(opts: {
  records?: DataRecord[];
  /** The stored token-main for TOKEN_DEF_ID; null for none. */
  stored?: Record<string, unknown> | null;
  deleteVaults?: string[];
  vaultDeleteError?: Error;
  /** The server-token definition that owns the name "ci"; null for none. */
  owner?: Definition | null;
} = {}): Harness {
  const events: string[] = [];
  const deleteVaults = new Set(opts.deleteVaults ?? [TOKEN_SECRETS_VAULT_NAME]);
  const stored = opts.stored !== undefined ? opts.stored : tokenAttrs("ci");
  const owner = opts.owner !== undefined
    ? opts.owner
    : Definition.create({ id: TOKEN_DEF_ID, name: "ci", version: 1 });

  const modelDeleteDeps: ModelDeleteDeps = {
    // modelDelete's default lookup would search every model type by name; a
    // same-named user model must never be reached.
    lookupDefinition: () =>
      Promise.reject(new Error("default lookup must not be used")),
    // The workflow reference check matches by name too; it must be skipped.
    findAllWorkflows: () =>
      Promise.reject(new Error("workflow check must not run")),
    findDataArtifacts: () =>
      Promise.resolve([{ name: "token-main" }] as unknown as DataArtifacts),
    findOutputs: () => Promise.resolve([]),
    getDefinitionPath: () => "/repo/definition.yaml",
    deleteOutput: () => Promise.resolve(),
    deleteData: (_type, id, name) => {
      events.push(`data:${id}/${name}`);
      return Promise.resolve();
    },
    deleteDefinition: (_type, id) => {
      events.push(`definition:${id}`);
      return Promise.resolve();
    },
    deleteEvaluatedDefinition: () => Promise.resolve(),
  };

  return {
    events,
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
              owner?.name === name
              ? owner
              : null,
          ),
      },
      dataRepo: {
        getContent: (_type, modelId, dataName) =>
          Promise.resolve(
            stored && modelId === TOKEN_DEF_ID && dataName === "token-main"
              ? new TextEncoder().encode(JSON.stringify(stored))
              : null,
          ),
      },
      vaultService: {
        supportsDelete: (vault) => deleteVaults.has(vault),
        delete: (vault, key) => {
          if (opts.vaultDeleteError) {
            return Promise.reject(opts.vaultDeleteError);
          }
          events.push(`secret:${vault}/${key}`);
          return Promise.resolve();
        },
      },
      modelDeleteDeps,
      libCtx: createLibSwampContext(),
      pushChanged: () => {
        events.push("push");
        return Promise.resolve();
      },
    },
  };
}

// --- listTokens ---

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

// --- collectToken: the normal path ---

Deno.test("createServerTokenGcDeps: collectToken deletes the secret, then the OAuth token, then the records, then pushes", async () => {
  const h = harness();
  const deps = createServerTokenGcDeps(h.input);

  const result = await deps.collectToken(listed(), always);

  assertEquals(result, "collected");
  assertEquals(h.events, [
    `secret:${TOKEN_SECRETS_VAULT_NAME}/server-token-ci`,
    `secret:${TOKEN_SECRETS_VAULT_NAME}/oauth-access-token-ci`,
    `data:${TOKEN_DEF_ID}/token-main`,
    `definition:${TOKEN_DEF_ID}`,
    "push",
  ]);
});

Deno.test("createServerTokenGcDeps: collectToken never consults workflows or the cross-type lookup", async () => {
  // Both would reject if called (see harness), and collection would fail.
  const h = harness();
  const deps = createServerTokenGcDeps(h.input);

  assertEquals(await deps.collectToken(listed(), always), "collected");
  assertEquals(h.events.includes(`definition:${TOKEN_DEF_ID}`), true);
});

// --- collectToken: re-reading the token ---

Deno.test("createServerTokenGcDeps: collectToken skips a token whose record is already gone", async () => {
  const h = harness({ stored: null });
  const deps = createServerTokenGcDeps(h.input);

  assertEquals(await deps.collectToken(listed(), always), "skipped");
  assertEquals(h.events, []);
});

Deno.test("createServerTokenGcDeps: collectToken re-checks eligibility against the current record", async () => {
  // Listed as revoked, but rotated back to active before collection.
  const h = harness({
    stored: tokenAttrs("ci", { state: "active", revokedAt: undefined }),
  });
  const deps = createServerTokenGcDeps(h.input);
  const seen: string[] = [];

  const result = await deps.collectToken(listed(), (current) => {
    seen.push(current.state);
    return current.state !== "active";
  });

  assertEquals(result, "skipped");
  assertEquals(seen, ["active"]);
  assertEquals(h.events, []);
});

// --- collectToken: records that outlived their definition ---

Deno.test("createServerTokenGcDeps: collectToken leaves the name's secret alone when another definition owns the name", async () => {
  // An orphaned revoked record (TOKEN_DEF_ID) and a re-minted live token
  // (OTHER_DEF_ID) share the name "ci" and so the secret key.
  const h = harness({
    owner: Definition.create({ id: OTHER_DEF_ID, name: "ci", version: 1 }),
  });
  const deps = createServerTokenGcDeps(h.input);

  const result = await deps.collectToken(listed(), always);

  assertEquals(result, "collected");
  assertEquals(h.events, [`data:${TOKEN_DEF_ID}/token-main`, "push"]);
});

Deno.test("createServerTokenGcDeps: collectToken deletes only the data of a record with no definition", async () => {
  const h = harness({ owner: null });
  const deps = createServerTokenGcDeps(h.input);

  const result = await deps.collectToken(listed(), always);

  assertEquals(result, "collected");
  assertEquals(h.events, [`data:${TOKEN_DEF_ID}/token-main`, "push"]);
});

// --- collectToken: secrets ---

Deno.test("createServerTokenGcDeps: collectToken never deletes a non-canonical key a record names", async () => {
  const h = harness({
    stored: tokenAttrs("ci", { vaultName: "prod", secretKey: "db-password" }),
    deleteVaults: [TOKEN_SECRETS_VAULT_NAME, "prod"],
  });
  const deps = createServerTokenGcDeps(h.input);

  await deps.collectToken(listed(), always);

  assertEquals(
    h.events.filter((e) => e.startsWith("secret:")),
    [
      `secret:${TOKEN_SECRETS_VAULT_NAME}/server-token-ci`,
      `secret:${TOKEN_SECRETS_VAULT_NAME}/oauth-access-token-ci`,
    ],
  );
});

Deno.test("createServerTokenGcDeps: collectToken also clears a legacy token's canonical key from its recorded vault", async () => {
  const h = harness({
    stored: tokenAttrs("ci", { vaultName: "legacy" }),
    deleteVaults: [TOKEN_SECRETS_VAULT_NAME, "legacy"],
  });
  const deps = createServerTokenGcDeps(h.input);

  await deps.collectToken(listed(), always);

  assertEquals(h.events.slice(0, 2), [
    `secret:${TOKEN_SECRETS_VAULT_NAME}/server-token-ci`,
    "secret:legacy/server-token-ci",
  ]);
});

Deno.test("createServerTokenGcDeps: collectToken skips a recorded vault without delete support", async () => {
  const h = harness({ stored: tokenAttrs("ci", { vaultName: "read-only" }) });
  const deps = createServerTokenGcDeps(h.input);

  assertEquals(await deps.collectToken(listed(), always), "collected");
  assertEquals(
    h.events[0],
    `secret:${TOKEN_SECRETS_VAULT_NAME}/server-token-ci`,
  );
  assertEquals(h.events.includes("secret:read-only/server-token-ci"), false);
});

Deno.test("createServerTokenGcDeps: collectToken keeps the records when the token secrets vault cannot delete", async () => {
  const h = harness({ deleteVaults: [] });
  const deps = createServerTokenGcDeps(h.input);

  await assertRejects(
    () => deps.collectToken(listed(), always),
    Error,
    "does not support deleting secrets",
  );
  assertEquals(h.events, []);
});

Deno.test("createServerTokenGcDeps: collectToken treats a missing secret as deleted", async () => {
  const h = harness({
    vaultDeleteError: new Error("Secret 'server-token-ci' not found"),
  });
  const deps = createServerTokenGcDeps(h.input);

  assertEquals(await deps.collectToken(listed(), always), "collected");
  assertEquals(h.events.includes(`definition:${TOKEN_DEF_ID}`), true);
});

Deno.test("createServerTokenGcDeps: collectToken keeps the records when the secret delete fails", async () => {
  const h = harness({ vaultDeleteError: new Error("access denied") });
  const deps = createServerTokenGcDeps(h.input);

  await assertRejects(
    () => deps.collectToken(listed(), always),
    Error,
    "access denied",
  );
  assertEquals(h.events, []);
});

Deno.test("createServerTokenGcDeps: collectToken still collects when the OAuth token delete fails", async () => {
  const h = harness();
  const deps = createServerTokenGcDeps({
    ...h.input,
    vaultService: {
      ...h.input.vaultService,
      delete: (vault, key) => {
        if (key.startsWith("oauth-access-token-")) {
          return Promise.reject(new Error("store down"));
        }
        return h.input.vaultService.delete(vault, key);
      },
    },
  });

  assertEquals(await deps.collectToken(listed(), always), "collected");
  assertEquals(h.events.includes(`definition:${TOKEN_DEF_ID}`), true);
});

// --- collectToken: pushing and the sync gate ---

Deno.test("createServerTokenGcDeps: collectToken still pushes after a partial record delete failure", async () => {
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
    () => deps.collectToken(listed(), always),
    Error,
    "disk full",
  );
  assertEquals(h.events.at(-1), "push");
});

Deno.test("createServerTokenGcDeps: a failed push does not fail collectToken", async () => {
  const h = harness();
  const deps = createServerTokenGcDeps({
    ...h.input,
    pushChanged: () => Promise.reject(new Error("remote unavailable")),
  });

  assertEquals(await deps.collectToken(listed(), always), "collected");
});

Deno.test("createServerTokenGcDeps: collectToken reads and deletes only while holding the sync gate", async () => {
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

  let checked = false;
  const collection = deps.collectToken(listed(), () => {
    checked = true;
    return true;
  });
  // Let the collection run as far as it can while the gate is held.
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(checked, false);
  assertEquals(h.events, []);

  releaseHolder();
  await holder;
  assertEquals(await collection, "collected");
  assertEquals(h.events.at(-1), "push");
});
