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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import type { ModelMethodRunEvent } from "../models/run.ts";
import {
  serverTokenCreate,
  type ServerTokenCreateDeps,
  type ServerTokenCreateEvent,
} from "./token_create.ts";

const EXPIRES_AT = "2026-07-18T00:00:00.000Z";

function mintEvents(
  name: string,
  attributes?: Record<string, unknown>,
): ModelMethodRunEvent[] {
  return [
    { kind: "validating_inputs" },
    {
      kind: "completed",
      run: {
        modelId: name,
        modelName: name,
        modelType: "swamp/server-token",
        methodName: "mint",
        status: "succeeded",
        outputId: "output-1",
        dataArtifacts: [
          {
            id: "data-1",
            name: "token-main",
            path: `/data/${name}/token-main`,
            attributes: attributes ?? {
              name,
              state: "active",
              principalId: "user:adam",
              principalEmail: "adam@example.com",
              createdAt: "2026-06-18T00:00:00.000Z",
              expiresAt: EXPIRES_AT,
              vaultName: "main-vault",
              secretKey: `server-token-${name}`,
            },
          },
        ],
      },
    },
  ];
}

function makeDeps(
  overrides?: Partial<ServerTokenCreateDeps>,
): ServerTokenCreateDeps {
  return {
    listVaultNames: () => Promise.resolve(["main-vault"]),
    runMint: async function* (input) {
      for (const event of mintEvents(input.name)) {
        yield await Promise.resolve(event);
      }
    },
    readSecret: () => Promise.resolve("plaintext-secret"),
    ...overrides,
  };
}

Deno.test("serverTokenCreate: mints and yields the plaintext once", async () => {
  const events = await collect<ServerTokenCreateEvent>(
    serverTokenCreate(createLibSwampContext(), makeDeps(), {
      name: "adam-token",
      principalId: "user:adam",
      principalEmail: "adam@example.com",
      durationMs: 30 * 24 * 60 * 60 * 1000,
    }),
  );

  assertEquals(events[0], {
    kind: "minting",
    name: "adam-token",
    vaultName: "main-vault",
  });
  const completed = events[1] as Extract<
    ServerTokenCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data, {
    name: "adam-token",
    token: "adam-token.plaintext-secret",
    principalId: "user:adam",
    expiresAt: EXPIRES_AT,
    vaultRef: {
      vaultName: "main-vault",
      secretKey: "server-token-adam-token",
    },
  });
});

Deno.test("serverTokenCreate: defaults to the sole configured vault", async () => {
  let mintedVault: string | undefined;
  const deps = makeDeps({
    listVaultNames: () => Promise.resolve(["only-vault"]),
    runMint: async function* (input) {
      mintedVault = input.vaultName;
      for (const event of mintEvents(input.name)) {
        yield await Promise.resolve(event);
      }
    },
  });
  const events = await collect<ServerTokenCreateEvent>(
    serverTokenCreate(createLibSwampContext(), deps, {
      name: "tok",
      principalId: "user:bob",
      principalEmail: "bob@example.com",
      durationMs: 1000,
    }),
  );
  assertEquals(mintedVault, "only-vault");
  assertEquals(events[1].kind, "completed");
});

Deno.test("serverTokenCreate: errors when no vaults are configured", async () => {
  const deps = makeDeps({ listVaultNames: () => Promise.resolve([]) });
  const events = await collect<ServerTokenCreateEvent>(
    serverTokenCreate(createLibSwampContext(), deps, {
      name: "tok",
      principalId: "user:bob",
      principalEmail: "bob@example.com",
      durationMs: 1000,
    }),
  );
  assertEquals(events.length, 1);
  const error = events[0] as Extract<
    ServerTokenCreateEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "No vaults are configured");
});

Deno.test("serverTokenCreate: errors when multiple vaults and no --vault", async () => {
  const deps = makeDeps({
    listVaultNames: () => Promise.resolve(["a", "b"]),
  });
  const events = await collect<ServerTokenCreateEvent>(
    serverTokenCreate(createLibSwampContext(), deps, {
      name: "tok",
      principalId: "user:bob",
      principalEmail: "bob@example.com",
      durationMs: 1000,
    }),
  );
  const error = events[0] as Extract<
    ServerTokenCreateEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "Multiple vaults are configured");
  assertStringIncludes(error.error.message, "--vault");
});

Deno.test("serverTokenCreate: errors when the requested vault is unknown", async () => {
  const events = await collect<ServerTokenCreateEvent>(
    serverTokenCreate(createLibSwampContext(), makeDeps(), {
      name: "tok",
      principalId: "user:bob",
      principalEmail: "bob@example.com",
      durationMs: 1000,
      vaultName: "missing",
    }),
  );
  const error = events[0] as Extract<
    ServerTokenCreateEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "Vault 'missing'");
  assertStringIncludes(error.error.message, "main-vault");
});

Deno.test("serverTokenCreate: forwards mint errors", async () => {
  const deps = makeDeps({
    runMint: async function* () {
      await Promise.resolve();
      yield {
        kind: "error",
        error: {
          code: "method_execution_failed",
          message: "Server token 'tok' already exists",
        },
      } as ModelMethodRunEvent;
    },
  });
  const events = await collect<ServerTokenCreateEvent>(
    serverTokenCreate(createLibSwampContext(), deps, {
      name: "tok",
      principalId: "user:bob",
      principalEmail: "bob@example.com",
      durationMs: 1000,
    }),
  );
  const error = events[1] as Extract<
    ServerTokenCreateEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "already exists");
});

Deno.test("serverTokenCreate: errors when the token record is missing", async () => {
  const deps = makeDeps({
    runMint: async function* (input) {
      yield await Promise.resolve(
        {
          kind: "completed",
          run: {
            modelId: input.name,
            modelName: input.name,
            modelType: "swamp/server-token",
            methodName: "mint",
            status: "succeeded",
            outputId: "output-1",
            dataArtifacts: [],
          },
        } satisfies ModelMethodRunEvent,
      );
    },
  });
  const events = await collect<ServerTokenCreateEvent>(
    serverTokenCreate(createLibSwampContext(), deps, {
      name: "tok",
      principalId: "user:bob",
      principalEmail: "bob@example.com",
      durationMs: 1000,
    }),
  );
  const error = events[1] as Extract<
    ServerTokenCreateEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "token-main");
});
