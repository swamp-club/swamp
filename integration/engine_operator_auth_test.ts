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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  admitEngineOperator,
  EngineOperatorAuthError,
} from "../src/engine/operator_auth.ts";
import {
  generateTestSigningKey,
  mintTestProof,
} from "../src/domain/auth/proof_test_helpers.ts";
import { AuthVerificationRepository } from "../src/infrastructure/persistence/auth_verification_repository.ts";
import { AuthRepository } from "../src/infrastructure/persistence/auth_repository.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  getAuthScopes,
  setAuthenticated,
  setAuthScopes,
  setCollectiveToken,
  setScopeResolutionFailed,
} from "../src/libswamp/auth/context.ts";
import { createAuthGateDeps } from "../src/libswamp/auth/gate.ts";
import { loadClientIdentity } from "../src/infrastructure/http/load_client_identity.ts";

const COLLECTIVE_KEY = "swamp_org_engine_operator_test";
interface World {
  dir: string;
  serverUrl: string;
  calls: Headers[];
  answer(scopes: string[], apiKey?: string): Promise<void>;
  refuse(status: number): void;
  saveProof(apiKey?: string): Promise<void>;
  login(apiKey: string, scopes: string[]): Promise<void>;
}

function resetContext(): void {
  setAuthenticated(false);
  setCollectiveToken("");
  setAuthScopes(undefined);
  setScopeResolutionFailed(false);
}

async function withWorld(fn: (world: World) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "engine-operator-auth-" });
  const key = await generateTestSigningKey();
  const calls: Headers[] = [];
  let answer = () => new Response("unverified", { status: 500 });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      calls.push(new Headers(request.headers));
      return answer();
    },
  );
  const serverUrl = `http://127.0.0.1:${server.addr.port}`;
  const mint = (apiKey: string) => {
    const now = Math.floor(Date.now() / 1000);
    return mintTestProof(key, apiKey, { iat: now, exp: now + 14 * 86400 });
  };
  resetContext();
  try {
    await withMockedEnv({
      SWAMP_CONFIG_DIR: dir,
      SWAMP_HOME: undefined,
      SWAMP_API_KEY: COLLECTIVE_KEY,
      SWAMP_API_KEY_FILE: undefined,
      SWAMP_SIGNIN_TOKEN: undefined,
      SWAMP_NESTED_GATE_PASS: undefined,
      SWAMP_CLUB_URL: serverUrl,
    }, () =>
      fn({
        dir,
        serverUrl,
        calls,
        async answer(scopes, apiKey = COLLECTIVE_KEY) {
          const proof = await mint(apiKey);
          answer = () =>
            Response.json({
              authenticated: true,
              username: "operator",
              scopes,
              verificationProof: proof.proof,
              verificationSignature: proof.signature,
              publicKeys: proof.publicKeys,
            });
        },
        refuse(status) {
          answer = () =>
            status === 401
              ? Response.json({
                authenticated: false,
                error: "SECRET_PROVIDER_BODY",
              }, { status })
              : new Response("SECRET_PROVIDER_BODY", { status });
        },
        async saveProof(apiKey = COLLECTIVE_KEY) {
          const proof = await mint(apiKey);
          await new AuthVerificationRepository({ configDir: dir }).save(
            proof.proof,
            proof.signature,
            proof.publicKeys,
          );
        },
        async login(apiKey, scopes) {
          await new AuthRepository({ configDir: dir }).save({
            apiKey,
            serverUrl,
            apiKeyId: "operator",
            username: "operator",
            scopes,
          });
        },
      }));
  } finally {
    resetContext();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

Deno.test("engine operator admission: no account is refused before any network check", async () => {
  await withWorld(async (world) => {
    await withMockedEnv({ SWAMP_API_KEY: undefined }, async () => {
      const error = await assertRejects(
        () => admitEngineOperator("test"),
        EngineOperatorAuthError,
      );
      assertEquals(error.code, "auth_gate_blocked");
      assertStringIncludes(error.message, "swamp auth login");
      assertEquals(world.calls.length, 0);
    });
  });
});

Deno.test("engine operator admission: live collective scope refusal preserves the CLI decision", async () => {
  await withWorld(async (world) => {
    await world.answer(["extensions:push"]);
    const error = await assertRejects(
      () => admitEngineOperator("test"),
      EngineOperatorAuthError,
    );
    assertEquals(error.code, "missing_scope");
    assertStringIncludes(error.message, "serve:*");
    assertEquals(
      world.calls.length,
      1,
      "scope resolution reuses the verified gate response",
    );
    assertEquals(world.calls[0].get("User-Agent"), "swamp-cli/test");
    assertEquals(
      world.calls[0].get("Authorization"),
      `Bearer ${COLLECTIVE_KEY}`,
    );
    assertEquals(error.message.includes(COLLECTIVE_KEY), false);
  });
});

Deno.test("engine operator admission: key file, signed proof and scoped cache admit a later offline generation", async () => {
  await withWorld(async (world) => {
    const path = join(world.dir, "operator.key");
    await Deno.writeTextFile(path, COLLECTIVE_KEY);
    await world.answer(["serve:*"]);
    await withMockedEnv(
      { SWAMP_API_KEY: undefined, SWAMP_API_KEY_FILE: path },
      async () => {
        assertEquals((await admitEngineOperator("test")).kind, "pass");
        assertEquals(getAuthScopes(), ["serve:*"]);
        assertEquals(world.calls.length, 1);
        world.refuse(503);
        resetContext();
        assertEquals((await admitEngineOperator("test")).kind, "pass");
        assertEquals(
          world.calls.length,
          1,
          "the cached proof and matching key scope cache avoid network",
        );
      },
    );
  });
});

Deno.test("engine operator admission: stored collective credentials retain scoped refusal", async () => {
  await withWorld(async (world) => {
    await world.login(COLLECTIVE_KEY, ["extensions:push"]);
    await world.saveProof();
    await withMockedEnv({ SWAMP_API_KEY: undefined }, async () => {
      const error = await assertRejects(
        () => admitEngineOperator("test"),
        EngineOperatorAuthError,
      );
      assertEquals(error.code, "missing_scope");
      assertEquals(world.calls.length, 0);
    });
  });
});

Deno.test("engine operator admission: stored personal account keeps ordinary serve scope semantics", async () => {
  await withWorld(async (world) => {
    const personalKey = "swamp_personal_operator_test";
    await world.login(personalKey, []);
    await world.saveProof(personalKey);
    await withMockedEnv({ SWAMP_API_KEY: undefined }, async () => {
      assertEquals((await admitEngineOperator("test")).kind, "pass");
      assertEquals(world.calls.length, 0);
    });
  });
});

Deno.test("engine operator admission: unavailable uncached scopes fail closed after a valid proof", async () => {
  await withWorld(async (world) => {
    await world.saveProof();
    const error = await assertRejects(
      () => admitEngineOperator("test"),
      EngineOperatorAuthError,
    );
    assertEquals(error.code, "scope_unverified");
    assertEquals(world.calls.length, 1);
    assertEquals(error.message.includes("SECRET_PROVIDER_BODY"), false);
  });
});

Deno.test("engine operator admission: revoked account is blocked with a safe policy diagnostic", async () => {
  await withWorld(async (world) => {
    world.refuse(401);
    const error = await assertRejects(
      () => admitEngineOperator("test"),
      EngineOperatorAuthError,
    );
    assertEquals(error.code, "auth_gate_blocked");
    assertStringIncludes(error.message, "revoked");
    assertEquals(error.message.includes("SECRET_PROVIDER_BODY"), false);
  });
});

Deno.test("engine operator admission: conflicting key sources do not leak credential paths or values", async () => {
  await withWorld(async (world) => {
    const privatePath = join(world.dir, "SECRET_OPERATOR_KEY_FILE");
    await withMockedEnv({ SWAMP_API_KEY_FILE: privatePath }, async () => {
      const error = await assertRejects(
        () => admitEngineOperator("test"),
        EngineOperatorAuthError,
      );
      assertEquals(error.code, "auth_configuration_invalid");
      assertStringIncludes(error.message, "SWAMP_API_KEY_FILE");
      assertEquals(error.message.includes(privatePath), false);
      assertEquals(error.message.includes(COLLECTIVE_KEY), false);
      assertEquals(world.calls.length, 0);
    });
  });
});

Deno.test("engine operator admission: read-only config ownership keeps live scopes in memory", async () => {
  await withWorld(async (world) => {
    await world.answer(["serve:*"]);
    const loadIdentity = () => loadClientIdentity("swamp-cli/test");
    const outcome = await admitEngineOperator("test", {
      canWrite: false,
      loadIdentity,
      gate: createAuthGateDeps(
        { liveChecks: true, canWrite: false },
        loadIdentity,
      ),
    });
    assertEquals(outcome.kind, "pass");
    assertEquals(getAuthScopes(), ["serve:*"]);
    assertEquals(world.calls.length, 1);
    const entries = Array.from(Deno.readDirSync(world.dir));
    assert(
      !entries.some((entry) =>
        entry.name === "auth_verified.json" || entry.name === "scope_cache.json"
      ),
    );
  });
});

Deno.test("engine operator admission: a gate pass alone does not replace token-serve authentication", async () => {
  await withWorld(async (world) => {
    await world.saveProof();
    const loadIdentity = () => Promise.resolve({});
    const error = await assertRejects(() =>
      admitEngineOperator("test", {
        canWrite: false,
        loadIdentity,
        gate: createAuthGateDeps(
          { liveChecks: true, canWrite: false },
          loadIdentity,
        ),
      }), EngineOperatorAuthError);
    assertEquals(error.code, "auth_required");
    assertStringIncludes(error.message, "swamp serve is a team feature");
  });
});
