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
  serverTokenRotate,
  type ServerTokenRotateDeps,
  type ServerTokenRotateEvent,
} from "./token_rotate.ts";

const EXPIRES_AT = "2026-07-18T00:00:00.000Z";

function rotateEvents(
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
        methodName: "rotate",
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
              principalId: "user:sarah",
              principalEmail: "sarah@example.com",
              createdAt: "2026-06-19T00:00:00.000Z",
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
  overrides?: Partial<ServerTokenRotateDeps>,
): ServerTokenRotateDeps {
  return {
    listVaultNames: () => Promise.resolve(["main-vault", "backup-vault"]),
    runRotate: async function* (input) {
      for (const event of rotateEvents(input.name)) {
        yield await Promise.resolve(event);
      }
    },
    ...overrides,
  };
}

Deno.test("serverTokenRotate: rotates and yields vault ref without plaintext", async () => {
  const events = await collect<ServerTokenRotateEvent>(
    serverTokenRotate(createLibSwampContext(), makeDeps(), {
      name: "sarah-token",
    }),
  );

  assertEquals(events[0], { kind: "rotating", name: "sarah-token" });
  const completed = events[1] as Extract<
    ServerTokenRotateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data, {
    name: "sarah-token",
    principalId: "user:sarah",
    expiresAt: EXPIRES_AT,
    vaultRef: {
      vaultName: "main-vault",
      secretKey: "server-token-sarah-token",
    },
  });
});

Deno.test("serverTokenRotate: passes durationMs to the model method", async () => {
  let receivedDuration: number | undefined;
  const deps = makeDeps({
    runRotate: async function* (input) {
      receivedDuration = input.durationMs;
      for (const event of rotateEvents(input.name)) {
        yield await Promise.resolve(event);
      }
    },
  });
  await collect<ServerTokenRotateEvent>(
    serverTokenRotate(createLibSwampContext(), deps, {
      name: "tok",
      durationMs: 60_000,
    }),
  );
  assertEquals(receivedDuration, 60_000);
});

Deno.test("serverTokenRotate: enriches model_not_found error", async () => {
  const deps = makeDeps({
    runRotate: async function* () {
      await Promise.resolve();
      yield {
        kind: "error",
        error: {
          code: "model_not_found",
          message: "Model not found",
        },
      } as ModelMethodRunEvent;
    },
  });
  const events = await collect<ServerTokenRotateEvent>(
    serverTokenRotate(createLibSwampContext(), deps, { name: "missing" }),
  );
  const error = events[1] as Extract<
    ServerTokenRotateEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "Server token 'missing' not found");
  assertStringIncludes(error.error.message, "swamp access token list");
});

Deno.test("serverTokenRotate: forwards other method errors", async () => {
  const deps = makeDeps({
    runRotate: async function* () {
      await Promise.resolve();
      yield {
        kind: "error",
        error: {
          code: "method_execution_failed",
          message: "does not exist",
        },
      } as ModelMethodRunEvent;
    },
  });
  const events = await collect<ServerTokenRotateEvent>(
    serverTokenRotate(createLibSwampContext(), deps, { name: "tok" }),
  );
  const error = events[1] as Extract<
    ServerTokenRotateEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "does not exist");
});

Deno.test("serverTokenRotate: errors when token record is missing from result", async () => {
  const deps = makeDeps({
    runRotate: async function* (input) {
      yield await Promise.resolve(
        {
          kind: "completed",
          run: {
            modelId: input.name,
            modelName: input.name,
            modelType: "swamp/server-token",
            methodName: "rotate",
            status: "succeeded",
            outputId: "output-1",
            dataArtifacts: [],
          },
        } satisfies ModelMethodRunEvent,
      );
    },
  });
  const events = await collect<ServerTokenRotateEvent>(
    serverTokenRotate(createLibSwampContext(), deps, { name: "tok" }),
  );
  const error = events[1] as Extract<
    ServerTokenRotateEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "token-main");
});

Deno.test("serverTokenRotate: passes vaultName override to the model method", async () => {
  let receivedVault: string | undefined;
  const deps = makeDeps({
    runRotate: async function* (input) {
      receivedVault = input.vaultName;
      for (
        const event of rotateEvents(input.name, {
          name: input.name,
          state: "active",
          principalId: "user:sarah",
          principalEmail: "sarah@example.com",
          createdAt: "2026-06-19T00:00:00.000Z",
          expiresAt: EXPIRES_AT,
          vaultName: "backup-vault",
          secretKey: `server-token-${input.name}`,
        })
      ) {
        yield await Promise.resolve(event);
      }
    },
  });
  const events = await collect<ServerTokenRotateEvent>(
    serverTokenRotate(createLibSwampContext(), deps, {
      name: "tok",
      vaultName: "backup-vault",
    }),
  );
  assertEquals(receivedVault, "backup-vault");
  const completed = events[1] as Extract<
    ServerTokenRotateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.vaultRef.vaultName, "backup-vault");
});

Deno.test("serverTokenRotate: uses existing vault when no override provided", async () => {
  let receivedVault: string | undefined;
  const deps = makeDeps({
    runRotate: async function* (input) {
      receivedVault = input.vaultName;
      for (const event of rotateEvents(input.name)) {
        yield await Promise.resolve(event);
      }
    },
  });
  const events = await collect<ServerTokenRotateEvent>(
    serverTokenRotate(createLibSwampContext(), deps, {
      name: "tok",
    }),
  );
  assertEquals(receivedVault, undefined);
  const completed = events[1] as Extract<
    ServerTokenRotateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.vaultRef.vaultName, "main-vault");
});

Deno.test("serverTokenRotate: errors when requested vault does not exist", async () => {
  const events = await collect<ServerTokenRotateEvent>(
    serverTokenRotate(createLibSwampContext(), makeDeps(), {
      name: "tok",
      vaultName: "nonexistent-vault",
    }),
  );
  assertEquals(events.length, 1);
  const error = events[0] as Extract<
    ServerTokenRotateEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "Vault 'nonexistent-vault'");
  assertStringIncludes(error.error.message, "not configured");
  assertStringIncludes(error.error.message, "main-vault");
});
