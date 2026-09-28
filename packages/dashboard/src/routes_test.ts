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
  absoluteUrl,
  buildPath,
  type ClickLike,
  encodeSegment,
  isPlainLeftClick,
  parentOf,
  parseRoute,
  type RouteState,
  viewForDetail,
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

// ── deep links: data, versions and reports ─────────────────────────────

Deno.test("parseRoute: data item latest", () => {
  assertEquals(parseRoute("/dashboard/models/incidents/data/state"), {
    view: "models",
    detail: { kind: "data", modelName: "incidents", dataName: "state" },
  });
});

Deno.test("parseRoute: data item at a version", () => {
  assertEquals(
    parseRoute("/dashboard/models/incidents/data/state/versions/3"),
    {
      view: "models",
      detail: {
        kind: "data",
        modelName: "incidents",
        dataName: "state",
        version: 3,
      },
    },
  );
});

Deno.test("parseRoute: an invalid version segment parses as the latest", () => {
  for (const bad of ["0", "-1", "1.5", "v3", "01", "99999999999999999999"]) {
    assertEquals(
      parseRoute(`/dashboard/models/m/data/d/versions/${bad}`).detail,
      { kind: "data", modelName: "m", dataName: "d" },
      bad,
    );
  }
});

Deno.test("parseRoute: model report and variant", () => {
  assertEquals(
    parseRoute("/dashboard/models/m/reports/@swamp%2Fmethod-summary"),
    {
      view: "models",
      detail: {
        kind: "report",
        modelName: "m",
        reportName: "@swamp/method-summary",
      },
    },
  );
  assertEquals(
    parseRoute("/dashboard/models/m/reports/%40acme%2Fcost/variants/us-east"),
    {
      view: "models",
      detail: {
        kind: "report",
        modelName: "m",
        reportName: "@acme/cost",
        variant: "us-east",
      },
    },
  );
});

Deno.test("parseRoute: run report", () => {
  assertEquals(
    parseRoute(
      "/dashboard/workflows/investigate/runs/run-1/reports/@swamp%2Fworkflow-summary",
    ),
    {
      view: "workflows",
      detail: {
        kind: "runReport",
        workflowName: "investigate",
        runId: "run-1",
        reportName: "@swamp/workflow-summary",
      },
    },
  );
});

Deno.test("parseRoute: a model literally named data is still a model", () => {
  assertEquals(parseRoute("/dashboard/models/data").detail, {
    kind: "model",
    modelName: "data",
  });
});

Deno.test("parseRoute: incomplete deep links fall back to the parent", () => {
  assertEquals(parseRoute("/dashboard/models/m/data").detail, {
    kind: "model",
    modelName: "m",
  });
  assertEquals(parseRoute("/dashboard/workflows/w/runs/r/reports").detail, {
    kind: "run",
    workflowName: "w",
    runId: "r",
  });
});

Deno.test("parseRoute: a malformed escape lands on the nearest valid parent", () => {
  assertEquals(parseRoute("/dashboard/models/m/data/state%E2%8").detail, {
    kind: "model",
    modelName: "m",
  });
  assertEquals(parseRoute("/dashboard/models/%E2%8"), {
    view: "models",
    detail: null,
  });
  assertEquals(parseRoute("/dashboard/%"), {
    view: "overview",
    detail: null,
  });
});

Deno.test("encodeSegment: keeps @ readable and encodes slashes", () => {
  assertEquals(
    encodeSegment("@swamp/workflow-summary"),
    "@swamp%2Fworkflow-summary",
  );
  assertEquals(encodeSegment("my model"), "my%20model");
});

Deno.test("buildPath: deep-link kinds", () => {
  assertEquals(
    buildPath({
      view: "models",
      detail: { kind: "data", modelName: "m", dataName: "d", version: 4 },
    }),
    "/dashboard/models/m/data/d/versions/4",
  );
  assertEquals(
    buildPath({
      view: "models",
      detail: {
        kind: "report",
        modelName: "m",
        reportName: "@a/b",
        variant: "x/y",
      },
    }),
    "/dashboard/models/m/reports/@a%2Fb/variants/x%2Fy",
  );
  assertEquals(
    buildPath({
      view: "workflows",
      detail: {
        kind: "runReport",
        workflowName: "@ops/investigate",
        runId: "r1",
        reportName: "@swamp/workflow-summary",
      },
    }),
    "/dashboard/workflows/@ops%2Finvestigate/runs/r1/reports/@swamp%2Fworkflow-summary",
  );
});

Deno.test("round-trip: every deep-link kind", () => {
  const states: RouteState[] = [
    {
      view: "models",
      detail: { kind: "data", modelName: "@a/m", dataName: "d x" },
    },
    {
      view: "models",
      detail: { kind: "data", modelName: "m", dataName: "d", version: 12 },
    },
    {
      view: "models",
      detail: { kind: "report", modelName: "m", reportName: "@a/r" },
    },
    {
      view: "models",
      detail: {
        kind: "report",
        modelName: "m",
        reportName: "@a/r",
        variant: "v",
      },
    },
    {
      view: "workflows",
      detail: {
        kind: "runReport",
        workflowName: "w",
        runId: "r",
        reportName: "@a/r",
      },
    },
  ];
  for (const state of states) {
    assertEquals(parseRoute(buildPath(state)), state);
  }
});

Deno.test("round-trip: legacy fully-encoded @ still parses", () => {
  assertEquals(parseRoute("/dashboard/models/%40acme%2Fm").detail, {
    kind: "model",
    modelName: "@acme/m",
  });
});

Deno.test("viewForDetail: model kinds to models, run kinds to workflows", () => {
  assertEquals(
    viewForDetail({ kind: "data", modelName: "m", dataName: "d" }),
    "models",
  );
  assertEquals(
    viewForDetail({ kind: "report", modelName: "m", reportName: "r" }),
    "models",
  );
  assertEquals(
    viewForDetail({
      kind: "runReport",
      workflowName: "w",
      runId: "r",
      reportName: "x",
    }),
    "workflows",
  );
});

Deno.test("parentOf: deep links return to their model or run", () => {
  assertEquals(parentOf({ kind: "data", modelName: "m", dataName: "d" }), {
    kind: "model",
    modelName: "m",
  });
  assertEquals(
    parentOf({ kind: "report", modelName: "m", reportName: "r" }),
    { kind: "model", modelName: "m" },
  );
  assertEquals(
    parentOf({
      kind: "runReport",
      workflowName: "w",
      runId: "r",
      reportName: "x",
    }),
    { kind: "run", workflowName: "w", runId: "r" },
  );
});

Deno.test("parentOf: existing details have no parent", () => {
  assertEquals(parentOf({ kind: "model", modelName: "m" }), null);
  assertEquals(parentOf({ kind: "run", workflowName: "w", runId: "r" }), null);
  assertEquals(parentOf(null), null);
});

Deno.test("absoluteUrl: prefixes the origin", () => {
  assertEquals(
    absoluteUrl(
      {
        view: "models",
        detail: { kind: "data", modelName: "m", dataName: "d", version: 2 },
      },
      "https://ops.example.com",
    ),
    "https://ops.example.com/dashboard/models/m/data/d/versions/2",
  );
});
