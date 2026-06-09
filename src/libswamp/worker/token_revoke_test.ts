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
  workerTokenRevoke,
  type WorkerTokenRevokeDeps,
  type WorkerTokenRevokeEvent,
} from "./token_revoke.ts";

const REVOKED_AT = "2026-06-09T12:00:00.000Z";

function completedEvent(
  name: string,
  artifacts: Array<{ name: string; attributes?: Record<string, unknown> }>,
): ModelMethodRunEvent {
  return {
    kind: "completed",
    run: {
      modelId: name,
      modelName: name,
      modelType: "swamp/enrollment-token",
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

Deno.test("workerTokenRevoke: yields revoking then completed with state", async () => {
  const deps: WorkerTokenRevokeDeps = {
    runRevoke: async function* (name) {
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
  const events = await collect<WorkerTokenRevokeEvent>(
    workerTokenRevoke(createLibSwampContext(), deps, { name: "ci-runner-3" }),
  );

  assertEquals(events[0], { kind: "revoking", name: "ci-runner-3" });
  const completed = events[1] as Extract<
    WorkerTokenRevokeEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data, {
    name: "ci-runner-3",
    state: "revoked",
    revokedAt: REVOKED_AT,
    alreadyRevoked: false,
  });
});

Deno.test("workerTokenRevoke: reports already-revoked tokens as a no-op", async () => {
  const deps: WorkerTokenRevokeDeps = {
    runRevoke: async function* (name) {
      yield await Promise.resolve(completedEvent(name, []));
    },
  };
  const events = await collect<WorkerTokenRevokeEvent>(
    workerTokenRevoke(createLibSwampContext(), deps, { name: "old-token" }),
  );
  const completed = events[1] as Extract<
    WorkerTokenRevokeEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.alreadyRevoked, true);
  assertEquals(completed.data.state, "revoked");
});

Deno.test("workerTokenRevoke: forwards run errors", async () => {
  const deps: WorkerTokenRevokeDeps = {
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
  const events = await collect<WorkerTokenRevokeEvent>(
    workerTokenRevoke(createLibSwampContext(), deps, { name: "missing" }),
  );
  const error = events[1] as Extract<
    WorkerTokenRevokeEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "not found");
});

Deno.test("workerTokenRevoke: errors when the stream ends without completing", async () => {
  const deps: WorkerTokenRevokeDeps = {
    // deno-lint-ignore require-yield
    runRevoke: async function* () {
      await Promise.resolve();
    },
  };
  const events = await collect<WorkerTokenRevokeEvent>(
    workerTokenRevoke(createLibSwampContext(), deps, { name: "ci" }),
  );
  const error = events[1] as Extract<
    WorkerTokenRevokeEvent,
    { kind: "error" }
  >;
  assertEquals(error.kind, "error");
  assertStringIncludes(error.error.message, "without completing");
});
