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
import { serveUpstreamHealth } from "./datastore_status.ts";
import {
  ServeAuthFailedError,
  ServeUnreachableError,
  ServeUpstreamError,
} from "../../infrastructure/datastore_v3/serve_upstream_errors.ts";
import {
  ServeFollowerBehindError,
  ServeNotLeaderError,
} from "../../domain/datastore_v3/serve_leader.ts";

const SERVE = "https://serve.example:9090";
const clock = () => {
  let t = 0;
  return () => (t += 5);
};

Deno.test("serveUpstreamHealth: serve answering is healthy, naming the address without credentials (swamp-club#4281)", async () => {
  const health = await serveUpstreamHealth(
    "https://user:secret@serve.example:9090",
    () => Promise.resolve(undefined),
    clock(),
  );
  assertEquals(health, {
    healthy: true,
    message: "Serve at https://serve.example:9090 is reachable",
    latencyMs: 5,
  });
});

Deno.test("serveUpstreamHealth: a retryable leader or follower refusal still means serve answered (swamp-club#4281)", async () => {
  for (
    const error of [
      new ServeNotLeaderError(undefined),
      new ServeFollowerBehindError(),
    ]
  ) {
    const health = await serveUpstreamHealth(
      SERVE,
      () => Promise.reject(error),
      clock(),
    );
    assertEquals(health.healthy, true, error.name);
    assertEquals(
      health.message,
      `Serve at ${SERVE} is reachable (${error.code})`,
    );
  }
});

Deno.test("serveUpstreamHealth: an unreachable serve is unhealthy (swamp-club#4281)", async () => {
  const health = await serveUpstreamHealth(
    SERVE,
    () =>
      Promise.reject(
        new ServeUnreachableError(SERVE, "never", new Error("refused")),
      ),
    clock(),
  );
  assertEquals(health.healthy, false);
  assertEquals(health.message, `Serve at ${SERVE} is unreachable`);
});

Deno.test("serveUpstreamHealth: a refusal names serve's code (swamp-club#4281)", async () => {
  for (
    const [error, code] of [
      [new ServeAuthFailedError(SERVE, "bad token"), "unauthorized"],
      [new ServeUpstreamError(403, "forbidden", "no"), "forbidden"],
      [new ServeUpstreamError(500, "internal_error", "boom"), "internal_error"],
    ] as const
  ) {
    const health = await serveUpstreamHealth(
      SERVE,
      () => Promise.reject(error),
      clock(),
    );
    assertEquals(health.healthy, false);
    assertEquals(health.message, `Serve at ${SERVE} refused (${code})`);
  }
});

Deno.test("serveUpstreamHealth: an unexpected error is thrown, never reported as health (swamp-club#4281)", async () => {
  await assertRejects(
    () =>
      serveUpstreamHealth(SERVE, () => Promise.reject(new TypeError("bug"))),
    TypeError,
    "bug",
  );
});
