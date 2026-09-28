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
import {
  buildPath,
  type ClickLike,
  type DetailView,
  isPlainLeftClick,
  parentDetail,
  parseRoute,
  routeForDetail,
  type RouteState,
} from "./routes.ts";

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

// ── data and run deep links ─────────────────────────────────────────────

Deno.test("parseRoute: model data item (latest)", () => {
  assertEquals(parseRoute("/dashboard/models/ops/data/incident-state"), {
    view: "models",
    detail: { kind: "data", modelName: "ops", dataName: "incident-state" },
  });
});

Deno.test("parseRoute: model data item at a version", () => {
  assertEquals(
    parseRoute("/dashboard/models/ops/data/report-summary/versions/3"),
    {
      view: "models",
      detail: {
        kind: "data",
        modelName: "ops",
        dataName: "report-summary",
        version: 3,
      },
    },
  );
});

Deno.test("parseRoute: an invalid version segment means latest", () => {
  for (const bad of ["0", "-1", "1.5", "abc", "01", ""]) {
    assertEquals(
      parseRoute(`/dashboard/models/ops/data/state/versions/${bad}`),
      {
        view: "models",
        detail: { kind: "data", modelName: "ops", dataName: "state" },
      },
      `version segment ${JSON.stringify(bad)}`,
    );
  }
});

Deno.test("parseRoute: models/<name>/data without a data name stays on the model", () => {
  assertEquals(parseRoute("/dashboard/models/ops/data"), {
    view: "models",
    detail: { kind: "model", modelName: "ops" },
  });
});

Deno.test("parseRoute: run data item, with and without a version", () => {
  assertEquals(
    parseRoute("/dashboard/workflows/investigate/runs/r-1/data/result-main"),
    {
      view: "workflows",
      detail: {
        kind: "runData",
        workflowName: "investigate",
        runId: "r-1",
        dataName: "result-main",
      },
    },
  );
  assertEquals(
    parseRoute(
      "/dashboard/workflows/investigate/runs/r-1/data/result-main/versions/2",
    ),
    {
      view: "workflows",
      detail: {
        kind: "runData",
        workflowName: "investigate",
        runId: "r-1",
        dataName: "result-main",
        version: 2,
      },
    },
  );
});

Deno.test("parseRoute: run data id comes from the query string", () => {
  assertEquals(
    parseRoute(
      "/dashboard/workflows/wf/runs/r-1/data/report-x/versions/1",
      "?id=5f0c",
    ),
    {
      view: "workflows",
      detail: {
        kind: "runData",
        workflowName: "wf",
        runId: "r-1",
        dataName: "report-x",
        version: 1,
        dataId: "5f0c",
      },
    },
  );
});

Deno.test("parseRoute: run report", () => {
  assertEquals(
    parseRoute(
      "/dashboard/workflows/investigate/runs/r-1/reports/%40swamp%2Fworkflow-summary",
    ),
    {
      view: "workflows",
      detail: {
        kind: "runReport",
        workflowName: "investigate",
        runId: "r-1",
        reportName: "@swamp/workflow-summary",
      },
    },
  );
});

Deno.test("parseRoute: a run report name keeps its '/' whether or not it was encoded", () => {
  const expected: RouteState = {
    view: "workflows",
    detail: {
      kind: "runReport",
      workflowName: "wf",
      runId: "r-1",
      reportName: "@swamp/workflow-summary",
    },
  };
  for (
    const path of [
      "/dashboard/workflows/wf/runs/r-1/reports/@swamp/workflow-summary",
      "/dashboard/workflows/wf/runs/r-1/reports/%40swamp/workflow-summary",
      "/dashboard/workflows/wf/runs/r-1/reports/%40swamp%2Fworkflow-summary",
    ]
  ) {
    assertEquals(parseRoute(path), expected, path);
  }
});

Deno.test("parseRoute: an unknown segment after a run stays on the run", () => {
  assertEquals(parseRoute("/dashboard/workflows/wf/runs/r-1/other/x"), {
    view: "workflows",
    detail: { kind: "run", workflowName: "wf", runId: "r-1" },
  });
});

Deno.test("buildPath: data, run data and run report encode every segment", () => {
  assertEquals(
    buildPath({
      view: "models",
      detail: {
        kind: "data",
        modelName: "org/model",
        dataName: "a/b",
        version: 4,
      },
    }),
    "/dashboard/models/org%2Fmodel/data/a%2Fb/versions/4",
  );
  assertEquals(
    buildPath({
      view: "workflows",
      detail: {
        kind: "runReport",
        workflowName: "wf",
        runId: "r 1",
        reportName: "@swamp/method-summary",
      },
    }),
    "/dashboard/workflows/wf/runs/r%201/reports/%40swamp/method-summary",
  );
});

Deno.test("round-trip: data, run data and run report", () => {
  const states: RouteState[] = [
    {
      view: "models",
      detail: { kind: "data", modelName: "org/m (v2)", dataName: "x/y" },
    },
    {
      view: "models",
      detail: { kind: "data", modelName: "m", dataName: "d", version: 12 },
    },
    {
      view: "workflows",
      detail: {
        kind: "runData",
        workflowName: "org/wf",
        runId: "r-1",
        dataName: "report-swamp-workflow-summary",
      },
    },
    {
      view: "workflows",
      detail: {
        kind: "runData",
        workflowName: "wf",
        runId: "r-1",
        dataName: "d",
        version: 3,
      },
    },
    {
      view: "workflows",
      detail: {
        kind: "runReport",
        workflowName: "wf",
        runId: "r-1",
        reportName: "@acme/cost report",
      },
    },
  ];
  states.push({
    view: "workflows",
    detail: {
      kind: "runData",
      workflowName: "wf",
      runId: "r-1",
      dataName: "d",
      version: 1,
      dataId: "550e8400-e29b-41d4-a716-446655440001",
    },
  });
  for (const state of states) {
    const [pathname, query = ""] = buildPath(state).split("?");
    assertEquals(parseRoute(pathname, query ? `?${query}` : ""), state);
  }
});

Deno.test("routeForDetail: data belongs to models, run data and reports to workflows", () => {
  assertEquals(
    routeForDetail({ kind: "data", modelName: "m", dataName: "d" }).view,
    "models",
  );
  assertEquals(
    routeForDetail({
      kind: "runData",
      workflowName: "wf",
      runId: "r",
      dataName: "d",
    }).view,
    "workflows",
  );
  assertEquals(
    routeForDetail({
      kind: "runReport",
      workflowName: "wf",
      runId: "r",
      reportName: "x",
    }).view,
    "workflows",
  );
});

Deno.test("parentDetail: data returns to its model, run data and reports to the run", () => {
  assertEquals(
    parentDetail({ kind: "data", modelName: "m", dataName: "d", version: 2 }),
    { kind: "model", modelName: "m" },
  );
  const run: DetailView = { kind: "run", workflowName: "wf", runId: "r" };
  assertEquals(
    parentDetail({
      kind: "runData",
      workflowName: "wf",
      runId: "r",
      dataName: "d",
    }),
    run,
  );
  assertEquals(
    parentDetail({
      kind: "runReport",
      workflowName: "wf",
      runId: "r",
      reportName: "x",
    }),
    run,
  );
  assertEquals(parentDetail({ kind: "model", modelName: "m" }), null);
});

// ── isPlainLeftClick ────────────────────────────────────────────────────

const PLAIN_CLICK: ClickLike = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
};

Deno.test("isPlainLeftClick: unmodified primary click is plain", () => {
  assertEquals(isPlainLeftClick(PLAIN_CLICK), true);
});

Deno.test("isPlainLeftClick: any modifier key is not plain", () => {
  for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
    assertEquals(isPlainLeftClick({ ...PLAIN_CLICK, [key]: true }), false, key);
  }
});

Deno.test("isPlainLeftClick: non-primary buttons are not plain", () => {
  assertEquals(isPlainLeftClick({ ...PLAIN_CLICK, button: 1 }), false);
  assertEquals(isPlainLeftClick({ ...PLAIN_CLICK, button: 2 }), false);
});

Deno.test("isPlainLeftClick: an already-handled click is not plain", () => {
  assertEquals(
    isPlainLeftClick({ ...PLAIN_CLICK, defaultPrevented: true }),
    false,
  );
});
