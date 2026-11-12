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
  workerTokenRotate,
  type WorkerTokenRotateDeps,
  type WorkerTokenRotateEvent,
} from "./token_rotate.ts";

function completedEvent(
  name: string,
  attributes: Record<string, unknown> | undefined,
): ModelMethodRunEvent {
  return {
    kind: "completed",
    run: {
      modelId: name,
      modelName: name,
      modelType: "swamp/enrollment-token",
      methodName: "rotate",
      status: "succeeded",
      outputId: "output-1",
      dataArtifacts: attributes === undefined ? [] : [{
        id: "data-0",
        name: "token-main",
        path: `/data/${name}/token-main`,
        attributes,
      }],
    },
  };
}

const ROTATED = {
  name: "web-01",
  state: "enrolled",
  createdAt: "2026-02-01T00:00:00.000Z",
  expiresAt: "2026-03-01T00:00:00.000Z",
  vaultName: "local",
  secretKey: "worker-token-web-01.r1769904000000",
  maxEnrollments: 1,
  bindings: [{
    machineId: "m-1",
    enrolledAt: "2026-01-01T00:00:00.000Z",
    mint: "2026-01-01T00:00:00.000Z",
  }],
  predecessor: {
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-02-01T00:00:00.000Z",
    secretKey: "worker-token-web-01",
  },
};

Deno.test("workerTokenRotate: reads the successor secret and reports a local rotation as undelivered", async () => {
  const runs: Array<{ name: string; durationMs?: number }> = [];
  const reads: string[] = [];
  const deps: WorkerTokenRotateDeps = {
    runRotate: async function* (name, durationMs) {
      runs.push({ name, durationMs });
      yield await Promise.resolve(completedEvent(name, ROTATED));
    },
    readSecret: (vaultName, secretKey) => {
      reads.push(`${vaultName}/${secretKey}`);
      return Promise.resolve("succ3ssor");
    },
  };
  const events = await collect<WorkerTokenRotateEvent>(
    workerTokenRotate(createLibSwampContext(), deps, {
      name: "web-01",
      durationMs: 60_000,
    }),
  );

  assertEquals(events[0], { kind: "rotating", name: "web-01" });
  assertEquals(runs, [{ name: "web-01", durationMs: 60_000 }]);
  assertEquals(reads, ["local/worker-token-web-01.r1769904000000"]);
  assertEquals(events[1], {
    kind: "completed",
    data: {
      name: "web-01",
      token: "web-01.succ3ssor",
      expiresAt: "2026-03-01T00:00:00.000Z",
      predecessorExpiresAt: "2026-02-01T00:00:00.000Z",
      delivered: false,
      rotated: [],
      notRotated: [],
      unconnectedBindings: 1,
    },
  });
});

Deno.test("workerTokenRotate: an unknown token names the list command", async () => {
  const deps: WorkerTokenRotateDeps = {
    runRotate: async function* () {
      yield await Promise.resolve<ModelMethodRunEvent>({
        kind: "error",
        error: { code: "model_not_found", message: "nope" },
      });
    },
    readSecret: () => Promise.reject(new Error("unreachable")),
  };
  const events = await collect<WorkerTokenRotateEvent>(
    workerTokenRotate(createLibSwampContext(), deps, { name: "ghost" }),
  );
  const error = events[1] as Extract<WorkerTokenRotateEvent, { kind: "error" }>;
  assertEquals(error.error.code, "model_not_found");
  assertStringIncludes(error.error.message, "swamp worker token list");
});

Deno.test("workerTokenRotate: a run that produced no record is an error, never a credential", async () => {
  const deps: WorkerTokenRotateDeps = {
    runRotate: async function* (name) {
      yield await Promise.resolve(completedEvent(name, undefined));
    },
    readSecret: () => Promise.reject(new Error("unreachable")),
  };
  const events = await collect<WorkerTokenRotateEvent>(
    workerTokenRotate(createLibSwampContext(), deps, { name: "web-01" }),
  );
  assertEquals(events.at(-1)?.kind, "error");
});
