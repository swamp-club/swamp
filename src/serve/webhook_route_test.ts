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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  isReservedServePath,
  partitionWebhookRoutes,
  SERVE_RESERVED_ROOTS,
  skippedWebhookMessage,
  WEBHOOK_ROUTE_PREFIX,
  webhookRouteProblem,
} from "./webhook_route.ts";

Deno.test("webhookRouteProblem: accepts routes under the webhook prefix", () => {
  for (const route of ["/hooks/github", "/hooks/ci/deploy", "/hooks/a%20b"]) {
    assertEquals(webhookRouteProblem(route), undefined, route);
  }
});

Deno.test("webhookRouteProblem: accepts legacy routes outside the reserved roots", () => {
  for (
    const route of [
      "/deploy",
      "/deploy/",
      "/hooks",
      "/hooks/",
      "/apiary",
      "/healthcheck",
      "/API/v1/cancel",
      "/a/b//c",
    ]
  ) {
    assertEquals(webhookRouteProblem(route), undefined, route);
  }
});

Deno.test("webhookRouteProblem: refuses a route without a leading slash", () => {
  assertStringIncludes(
    webhookRouteProblem("hooks/ci") ?? "",
    "does not start with '/'",
  );
});

Deno.test("webhookRouteProblem: refuses each reserved root, its sub-paths and the root path", () => {
  for (const root of SERVE_RESERVED_ROOTS) {
    for (const route of [`/${root}`, `/${root}/`, `/${root}/x/y`]) {
      const problem = webhookRouteProblem(route);
      assert(problem !== undefined, route);
      assertStringIncludes(problem, `under '/${root}'`);
      assertStringIncludes(problem, WEBHOOK_ROUTE_PREFIX);
    }
  }
  assertStringIncludes(webhookRouteProblem("/") ?? "", "under '/'");
});

Deno.test("webhookRouteProblem: refuses the paths serve answers today", () => {
  for (
    const route of [
      "/api/v1/cancel",
      "/api/v1/request",
      "/api/v1/datastore/locks",
      "/auth/device/token",
      "/internal/runs",
      "/dashboard/start",
      "//data/x",
      "//api/v1/cancel",
      "//",
    ]
  ) {
    assert(webhookRouteProblem(route) !== undefined, route);
  }
});

Deno.test("webhookRouteProblem: refuses a percent-encoded reserved root", () => {
  assertStringIncludes(
    webhookRouteProblem("/%61pi/v1/cancel") ?? "",
    "under '/api'",
  );
});

Deno.test("webhookRouteProblem: refuses dot and dot-dot segments, encoded or not", () => {
  for (
    const route of [
      "/hooks/./x",
      "/hooks/../x",
      "/hooks/x/..",
      "/hooks/%2e%2e/x",
      "/hooks/%2E/x",
      "/hooks/.%2e/x",
    ]
  ) {
    assertStringIncludes(
      webhookRouteProblem(route) ?? "",
      "'.' or '..' segment",
      route,
    );
  }
});

Deno.test("webhookRouteProblem: an undecodable segment is judged as written", () => {
  assertEquals(webhookRouteProblem("/hooks/%zz"), undefined);
  assertEquals(webhookRouteProblem("/%zz/api"), undefined);
});

Deno.test("isReservedServePath: matches whole first segments only", () => {
  assert(isReservedServePath("/"));
  assert(isReservedServePath("/api"));
  assert(isReservedServePath("/data/x"));
  assertEquals(isReservedServePath("/apiary"), false);
  assertEquals(isReservedServePath("/hooks/x"), false);
  assertEquals(isReservedServePath("/HEALTH"), false);
});

Deno.test("partitionWebhookRoutes: keeps allowed routes in order and gives each refused one its reason", () => {
  const { allowed, refused } = partitionWebhookRoutes([
    { route: "/hooks/a" },
    { route: "/api/github" },
    { route: "/deploy" },
    { route: "/hooks/../x" },
  ]);
  assertEquals(allowed.map((r) => r.route), ["/hooks/a", "/deploy"]);
  assertEquals(refused.map((r) => r.item.route), [
    "/api/github",
    "/hooks/../x",
  ]);
  assertStringIncludes(refused[0].reason, "under '/api'");
  assertStringIncludes(refused[1].reason, "'.' or '..' segment");
});

Deno.test("skippedWebhookMessage: names the route and the reason", () => {
  assertEquals(
    skippedWebhookMessage("/api/github", webhookRouteProblem("/api/github")!),
    "Skipped webhook route '/api/github': it is under '/api', which serve " +
      "reserves for its own API; use a route under /hooks/ instead",
  );
});
