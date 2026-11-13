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
  serverTokenRevoke,
  type ServerTokenRevokeDeps,
  type ServerTokenRevokeEvent,
} from "./token_revoke.ts";

const DEFINITION_ID = "3f1c2a4e-8b9d-4c6e-9a7f-1b2c3d4e5f60";
const REVOKED_AT = "2026-06-20T12:00:00.000Z";

function completedEvent(
  name: string,
  artifacts: Array<{ name: string; attributes?: Record<string, unknown> }>,
): ModelMethodRunEvent {
  return {
    kind: "completed",
    run: {
      modelId: name,
      modelName: name,
      modelType: "swamp/server-token",
      methodName: "revoke",
      status: "succeeded",
      outputId: "output-1",
      dataArtifacts: artifacts.map((artifact, index) => ({
        id: `data-${index}`,
        name: artifact.name,
        path: `/data/${name}/${artifact.name}`,
        attributes: artifact.attributes,
      })),
    },
  };
}

Deno.test("serverTokenRevoke: yields revoking then completed with state", async () => {
  const deps: ServerTokenRevokeDeps = {
    findTokenDefinition: (name) => Promise.resolve({ id: DEFINITION_ID, name }),
    runRevoke: async function* ({ name }) {
      yield await Promise.resolve(
        completedEvent(name, [
          {
            name: "token-main",
            attributes: { state: "revoked", revokedAt: REVOKED_AT },
          },
        ]),
      );
    },
  };
  const events = await collect<ServerTokenRevokeEvent>(
    serverTokenRevoke(createLibSwampContext(), deps, { name: "adam-token" }),
  );

  assertEquals(events[0], { kind: "revoking", name: "adam-token" });
  const completed = events[1] as Extract<
    ServerTokenRevokeEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data, {
    name: "adam-token",
    state: "revoked",
    revokedAt: REVOKED_AT,
    alreadyRevoked: false,
  });
});

Deno.test("serverTokenRevoke: reports already-revoked tokens as a no-op", async () => {
  const deps: ServerTokenRevokeDeps = {
    findTokenDefinition: (name) => Promise.resolve({ id: DEFINITION_ID, name }),
    runRevoke: async function* ({ name }) {
      yield await Promise.resolve(completedEvent(name, []));
    },
  };
  const events = await collect<ServerTokenRevokeEvent>(
    serverTokenRevoke(createLibSwampContext(), deps, { name: "old-token" }),
  );
  const completed = events[1] as Extract<
    ServerTokenRevokeEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.alreadyRevoked, true);
  assertEquals(completed.data.state, "revoked");
});

Deno.test("serverTokenRevoke: rewrites model_not_found as token-specific error", async () => {
  const deps: ServerTokenRevokeDeps = {
    findTokenDefinition: (name) => Promise.resolve({ id: DEFINITION_ID, name }),
    runRevoke: async function* () {
      yield await Promise.resolve(
        {
          kind: "error",
          error: {
            code: "model_not_found",
            message: "Model 'missing' not found",
          },
        } satisfies ModelMethodRunEvent,
      );
    },
  };
  const events = await collect<ServerTokenRevokeEvent>(
    serverTokenRevoke(createLibSwampContext(), deps, { name: "missing" }),
  );
  const error = events[1] as Extract<
    ServerTokenRevokeEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertEquals(error.error.code, "model_not_found");
  assertStringIncludes(error.error.message, "Server token 'missing' not found");
  assertStringIncludes(error.error.message, "swamp access token list");
});

Deno.test("serverTokenRevoke: forwards non-model_not_found errors unchanged", async () => {
  const deps: ServerTokenRevokeDeps = {
    findTokenDefinition: (name) => Promise.resolve({ id: DEFINITION_ID, name }),
    runRevoke: async function* () {
      yield await Promise.resolve(
        {
          kind: "error",
          error: {
            code: "method_execution_failed",
            message: "vault unavailable",
          },
        } satisfies ModelMethodRunEvent,
      );
    },
  };
  const events = await collect<ServerTokenRevokeEvent>(
    serverTokenRevoke(createLibSwampContext(), deps, { name: "tok" }),
  );
  const error = events[1] as Extract<
    ServerTokenRevokeEvent,
    { kind: "error" }
  >;
  assertEquals(error.error.code, "method_execution_failed");
  assertStringIncludes(error.error.message, "vault unavailable");
});

Deno.test("serverTokenRevoke: errors when the stream ends without completing", async () => {
  const deps: ServerTokenRevokeDeps = {
    findTokenDefinition: (name) => Promise.resolve({ id: DEFINITION_ID, name }),
    // deno-lint-ignore require-yield
    runRevoke: async function* () {
      await Promise.resolve();
    },
  };
  const events = await collect<ServerTokenRevokeEvent>(
    serverTokenRevoke(createLibSwampContext(), deps, { name: "tok" }),
  );
  const error = events[1] as Extract<
    ServerTokenRevokeEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "without completing");
});

Deno.test("serverTokenRevoke: refuses a name with no token of its type and runs nothing", async () => {
  let ran = false;
  const deps: ServerTokenRevokeDeps = {
    findTokenDefinition: () => Promise.resolve(null),
    // deno-lint-ignore require-yield
    runRevoke: async function* () {
      ran = true;
      await Promise.resolve();
    },
  };
  const events = await collect<ServerTokenRevokeEvent>(
    serverTokenRevoke(createLibSwampContext(), deps, { name: "srv" }),
  );

  assertEquals(ran, false);
  assertEquals(events[1], {
    kind: "error",
    error: {
      code: "model_not_found",
      message: "Server token 'srv' not found. " +
        "Use 'swamp access token list' to see existing tokens.",
    },
  });
});

Deno.test("serverTokenRevoke: runs revoke on the resolved definition", async () => {
  const lookedUp: string[] = [];
  const ranWith: string[] = [];
  const deps: ServerTokenRevokeDeps = {
    findTokenDefinition: (name) => {
      lookedUp.push(name);
      return Promise.resolve({ id: DEFINITION_ID, name: "resolved-name" });
    },
    runRevoke: async function* (token) {
      ranWith.push(`${token.id}/${token.name}`);
      yield await Promise.resolve(completedEvent("ci", []));
    },
  };
  await collect<ServerTokenRevokeEvent>(
    serverTokenRevoke(createLibSwampContext(), deps, { name: "ci" }),
  );

  assertEquals(lookedUp, ["ci"]);
  assertEquals(ranWith, [`${DEFINITION_ID}/resolved-name`]);
});
