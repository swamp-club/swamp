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

import { assertEquals } from "@std/assert";
import { buildPath, parseRoute, type RouteState } from "./routes.ts";

// ── parseRoute ──────────────────────────────────────────────────────────

Deno.test("parseRoute: /dashboard defaults to overview", () => {
  assertEquals(parseRoute("/dashboard"), {
    view: "overview",
    detail: null,
  });
});

Deno.test("parseRoute: /dashboard/ defaults to overview", () => {
  assertEquals(parseRoute("/dashboard/"), {
    view: "overview",
    detail: null,
  });
});

Deno.test("parseRoute: /dashboard/overview parses as overview", () => {
  assertEquals(parseRoute("/dashboard/overview"), {
    view: "overview",
    detail: null,
  });
});

Deno.test("parseRoute: top-level views parse correctly", () => {
  const views = [
    "workflows",
    "executions",
    "models",
    "schedules",
    "webhooks",
    "approvals",
    "activity",
    "data",
    "vaults",
    "extensions",
    "system",
  ] as const;

  for (const view of views) {
    assertEquals(parseRoute(`/dashboard/${view}`), {
      view,
      detail: null,
    });
  }
});

Deno.test("parseRoute: model detail", () => {
  assertEquals(parseRoute("/dashboard/models/my-model"), {
    view: "models",
    detail: { kind: "model", modelName: "my-model" },
  });
});

Deno.test("parseRoute: model detail with encoded name", () => {
  assertEquals(parseRoute("/dashboard/models/my%20model%2Fv2"), {
    view: "models",
    detail: { kind: "model", modelName: "my model/v2" },
  });
});

Deno.test("parseRoute: workflow detail", () => {
  assertEquals(parseRoute("/dashboard/workflows/deploy-pipeline"), {
    view: "workflows",
    detail: { kind: "workflow", workflowName: "deploy-pipeline" },
  });
});

Deno.test("parseRoute: run detail with runId", () => {
  assertEquals(
    parseRoute("/dashboard/workflows/deploy-pipeline/runs/abc-123"),
    {
      view: "workflows",
      detail: {
        kind: "run",
        workflowName: "deploy-pipeline",
        runId: "abc-123",
      },
    },
  );
});

Deno.test("parseRoute: unknown path falls back to overview", () => {
  assertEquals(parseRoute("/dashboard/nonexistent"), {
    view: "overview",
    detail: null,
  });
});

Deno.test("parseRoute: bare path without /dashboard prefix", () => {
  assertEquals(parseRoute("/models/my-model"), {
    view: "models",
    detail: { kind: "model", modelName: "my-model" },
  });
});

// ── buildPath ───────────────────────────────────────────────────────────

Deno.test("buildPath: overview produces /dashboard", () => {
  assertEquals(
    buildPath({ view: "overview", detail: null }),
    "/dashboard",
  );
});

Deno.test("buildPath: top-level view", () => {
  assertEquals(
    buildPath({ view: "workflows", detail: null }),
    "/dashboard/workflows",
  );
});

Deno.test("buildPath: model detail", () => {
  assertEquals(
    buildPath({
      view: "models",
      detail: { kind: "model", modelName: "my-model" },
    }),
    "/dashboard/models/my-model",
  );
});

Deno.test("buildPath: workflow detail", () => {
  assertEquals(
    buildPath({
      view: "workflows",
      detail: { kind: "workflow", workflowName: "deploy" },
    }),
    "/dashboard/workflows/deploy",
  );
});

Deno.test("buildPath: run detail", () => {
  assertEquals(
    buildPath({
      view: "workflows",
      detail: { kind: "run", workflowName: "deploy", runId: "run-1" },
    }),
    "/dashboard/workflows/deploy/runs/run-1",
  );
});

Deno.test("buildPath: encodes special characters", () => {
  assertEquals(
    buildPath({
      view: "models",
      detail: { kind: "model", modelName: "my model/v2" },
    }),
    "/dashboard/models/my%20model%2Fv2",
  );
});

// ── Round-trips ─────────────────────────────────────────────────────────

Deno.test("round-trip: overview", () => {
  const state: RouteState = { view: "overview", detail: null };
  assertEquals(parseRoute(buildPath(state)), state);
});

Deno.test("round-trip: top-level view", () => {
  const state: RouteState = { view: "data", detail: null };
  assertEquals(parseRoute(buildPath(state)), state);
});

Deno.test("round-trip: model detail", () => {
  const state: RouteState = {
    view: "models",
    detail: { kind: "model", modelName: "platform-team-plt-1834" },
  };
  assertEquals(parseRoute(buildPath(state)), state);
});

Deno.test("round-trip: workflow detail", () => {
  const state: RouteState = {
    view: "workflows",
    detail: { kind: "workflow", workflowName: "nightly-sync" },
  };
  assertEquals(parseRoute(buildPath(state)), state);
});

Deno.test("round-trip: run detail", () => {
  const state: RouteState = {
    view: "workflows",
    detail: {
      kind: "run",
      workflowName: "nightly-sync",
      runId: "a1b2c3d4",
    },
  };
  assertEquals(parseRoute(buildPath(state)), state);
});

Deno.test("round-trip: model with special characters", () => {
  const state: RouteState = {
    view: "models",
    detail: { kind: "model", modelName: "org/model name (v2)" },
  };
  assertEquals(parseRoute(buildPath(state)), state);
});
