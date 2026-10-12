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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CLUSTER_COLUMNS,
  DATA_COLUMNS,
  DataDetailSkeleton,
  DataTableSkeleton,
  DEPLOYMENT_KEYS,
  DeploymentPanelSkeleton,
  ExecutionChartSkeleton,
  EXTENSION_COLUMNS,
  ExtensionsTableSkeleton,
  KeyValuePanelSkeleton,
  LoginStartingSkeleton,
  SERVE_CONFIG_KEYS,
  TablePanelSkeleton,
  UpcomingSchedulesSkeleton,
  VaultListSkeleton,
  VaultSectionSkeleton,
  VersionsPanelSkeleton,
  WORKER_COLUMNS,
} from "./PageSkeletons.tsx";
import { serveConfigRows } from "./serve_config_rows.ts";

/** Renders a skeleton and checks what every loading state must satisfy. */
function renderBusy(node: ReactElement, label: string): string {
  const html = renderToStaticMarkup(node);
  assertStringIncludes(html, 'aria-busy="true"');
  assertStringIncludes(html, label);
  // Loading must never read as "nothing here".
  assert(!html.includes("empty-state"), "renders an empty state");
  assert(!/>No [a-z]/.test(html), "renders empty-state copy");
  assert(!html.includes("Loading…"), "renders bare loading text");
  return html;
}

function headers(columns: { header: string }[]): string {
  return columns.map((c) => `<th>${c.header}</th>`).join("");
}

Deno.test("ExecutionChartSkeleton: real title and legend over a bar silhouette", () => {
  const html = renderBusy(
    <ExecutionChartSkeleton />,
    "Loading executions chart",
  );
  assertStringIncludes(html, '<span class="chart-title">Executions</span>');
  for (
    const label of ["Succeeded", "Failed", "Cancelled", "Running / waiting"]
  ) {
    assertStringIncludes(html, label);
  }
  assertStringIncludes(html, "chart-area");
  assertStringIncludes(html, "skel-chart");
});

Deno.test("UpcomingSchedulesSkeleton: schedule-shaped rows", () => {
  const html = renderBusy(<UpcomingSchedulesSkeleton />, "Loading schedules");
  assertEquals(html.split('class="schedule-row"').length - 1, 4);
});

Deno.test("DataTableSkeleton: the data table's real headers", () => {
  const html = renderBusy(<DataTableSkeleton />, "Loading data");
  assertStringIncludes(html, headers(DATA_COLUMNS));
  assertStringIncludes(html, "<th>Content Type</th>");
});

Deno.test("ExtensionsTableSkeleton: the extensions table's real headers", () => {
  const html = renderBusy(<ExtensionsTableSkeleton />, "Loading extensions");
  assertStringIncludes(html, headers(EXTENSION_COLUMNS));
});

Deno.test("VaultListSkeleton: collapsed vault panels", () => {
  const html = renderBusy(<VaultListSkeleton count={3} />, "Loading vaults");
  assertEquals(html.split('class="panel"').length - 1, 3);
});

Deno.test("VaultSectionSkeleton: rows for an expanded vault section", () => {
  const html = renderBusy(
    <VaultSectionSkeleton label="Loading keys" rows={2} />,
    "Loading keys",
  );
  assertEquals(html.split("padding:8px 18px").length - 1, 2);
});

Deno.test("TablePanelSkeleton: System's tables keep their titles and headers", () => {
  const cluster = renderBusy(
    <TablePanelSkeleton
      title="Cluster Instances"
      columns={CLUSTER_COLUMNS}
      rows={1}
      label="Loading cluster instances"
    />,
    "Loading cluster instances",
  );
  assertStringIncludes(cluster, "Cluster Instances");
  assertStringIncludes(cluster, headers(CLUSTER_COLUMNS));
  const workers = renderBusy(
    <TablePanelSkeleton
      title="Workers"
      columns={WORKER_COLUMNS}
      rows={2}
      label="Loading workers"
    />,
    "Loading workers",
  );
  assertStringIncludes(workers, headers(WORKER_COLUMNS));
});

Deno.test("DeploymentPanelSkeleton: real title and row keys", () => {
  const html = renderBusy(
    <DeploymentPanelSkeleton />,
    "Loading deployment and component health",
  );
  assertStringIncludes(html, '<div class="panel-title">Deployment</div>');
  for (const key of DEPLOYMENT_KEYS) {
    assertStringIncludes(html, `<span class="sys-key">${key}</span>`);
  }
});

Deno.test("KeyValuePanelSkeleton: Serve Configuration shows its real keys", () => {
  const html = renderBusy(
    <KeyValuePanelSkeleton
      title="Serve Configuration"
      keys={SERVE_CONFIG_KEYS}
      label="Loading serve configuration"
    />,
    "Loading serve configuration",
  );
  assertStringIncludes(html, "Serve Configuration");
  for (const key of SERVE_CONFIG_KEYS) {
    assertStringIncludes(html, `<span class="sys-key">${key}</span>`);
  }
});

Deno.test("SERVE_CONFIG_KEYS: match the rows serveConfigRows always produces", () => {
  const rows = serveConfigRows({ config: {} }) ?? [];
  assertEquals(rows.map((r) => r.label), SERVE_CONFIG_KEYS);
});

Deno.test("KeyValuePanelSkeleton: unknown keys render as placeholders", () => {
  const html = renderBusy(
    <KeyValuePanelSkeleton
      title="Datastore"
      rows={4}
      label="Loading datastore"
    />,
    "Loading datastore",
  );
  assertStringIncludes(html, '<div class="panel-title">Datastore</div>');
  assert(!html.includes('class="sys-key"'));
});

Deno.test("DataDetailSkeleton: content, details and versions panels", () => {
  const html = renderBusy(<DataDetailSkeleton />, "Loading data");
  assertStringIncludes(html, '<div class="panel-title">Content</div>');
  assertStringIncludes(html, '<div class="panel-title">Details</div>');
  assertStringIncludes(html, '<div class="panel-title">Versions</div>');
  assertStringIncludes(html, '<span class="detail-key">Content type</span>');
});

Deno.test("DataDetailSkeleton: a run report has no versions panel", () => {
  const html = renderBusy(
    <DataDetailSkeleton versions={false} />,
    "Loading data",
  );
  assert(!html.includes("Versions"));
});

Deno.test("VersionsPanelSkeleton: a version list in a busy region", () => {
  const html = renderBusy(
    <VersionsPanelSkeleton rows={3} />,
    "Loading versions",
  );
  assertEquals(html.split("<li>").length - 1, 3);
});

Deno.test("LoginStartingSkeleton: shaped like the confirmation-code card", () => {
  const html = renderBusy(<LoginStartingSkeleton />, "Starting login");
  assertStringIncludes(html, "Confirmation code");
  assertStringIncludes(html, 'class="login-code-block"');
});
