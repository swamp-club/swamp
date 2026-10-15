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

import { applyRowFacets, type RowFacetSpec } from "../lib/row_facets.ts";
import { workflowPrefix } from "../lib/workflow_facets.ts";

import { useMemo } from "react";
import type { HealthSnapshot } from "../client/useHealthStream.ts";
import { healthViewState } from "../client/health_state.ts";
import { HealthUnavailable } from "../components/HealthUnavailable.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { SkeletonPills, SkeletonTable } from "../components/Skeleton.tsx";
import { type Stat, StatPills } from "../components/StatPills.tsx";
import {
  rowSearchFacets,
  TriggerFilterBar,
} from "../components/TriggerFilterBar.tsx";
import {
  webhookColumns,
  webhookRoute,
  type WebhookRow,
  WebhookTable,
} from "../components/TriggerTables.tsx";
import { navigateTo } from "../hooks/useRouter.ts";
import {
  asString,
  useFacetParams,
  useQueryState,
} from "../client/useQueryState.ts";
import { useTriggerRunSummaries } from "../client/trigger_runs.ts";
import { useRequest } from "../client/useRequest.ts";
import { extractArray } from "../client/extract.ts";
import { describeTimeRange, useTimeRange } from "../client/time_range.ts";
import {
  filterWebhooks,
  routesByWorkflow,
  webhookWorkflowName,
} from "../lib/triggers.ts";
import { formatCount } from "../lib/format.ts";
import "../styles/triggers.css";

/**
 * Webhook routes resolved to workflow names. Health names each route's
 * workflow as configured — an id or a name — so ids are looked up.
 */
export function useResolvedWebhooks(health: HealthSnapshot | null) {
  const webhooks = health?.webhooks;
  const needsLookup = (webhooks ?? []).some((w) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(w.workflow)
  );
  const { data } = useRequest("workflow.search", {}, {
    enabled: needsLookup,
  });
  return useMemo(() => {
    const workflows = extractArray<{ id: string; name: string }>(data);
    return (webhooks ?? []).map((w) => ({
      ...w,
      workflowName: webhookWorkflowName(w.workflow, workflows),
    }));
  }, [webhooks, data]);
}

const LAST_RUN_LABELS: Record<string, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  running: "Running",
  suspended: "Suspended",
  cancelled: "Cancelled",
  never: "No runs in range",
};

/** What the webhook table can be filtered by, beyond free text. */
const WEBHOOK_FACETS: readonly RowFacetSpec<WebhookRow>[] = [
  {
    key: "workflow",
    label: "Workflow",
    description: "Webhooks that start a given workflow",
    valueOf: (r) => r.workflowName,
  },
  {
    key: "last",
    label: "Last run",
    description: "How the latest webhook run in range ended",
    valueOf: (r) => r.recent[0]?.status ?? "never",
    labelOf: (v) => LAST_RUN_LABELS[v] ?? v,
    order: Object.keys(LAST_RUN_LABELS),
  },
  {
    key: "scheme",
    label: "Verification",
    description: "How the request signature is checked",
    valueOf: (r) => r.scheme ?? "none",
    labelOf: (v) => (v === "none" ? "Not reported" : v),
  },
  {
    key: "prefix",
    label: "Prefix",
    description: "Webhooks whose workflow name starts with a prefix",
    valueOf: (r) => workflowPrefix(r.workflowName),
  },
  {
    key: "shared",
    label: "Shared",
    description: "Whether other routes start the same workflow",
    valueOf: (r) => (r.sharedWith.length > 0 ? "shared" : "only"),
    labelOf: (v) =>
      v === "shared" ? "Workflow shared with other routes" : "Only route",
  },
];
const WEBHOOK_FACET_KEYS = WEBHOOK_FACETS.map((f) => f.key);

export function Webhooks(
  { health, denied }: { health: HealthSnapshot | null; denied: boolean },
) {
  const state = healthViewState(health, denied);
  const resolved = useResolvedWebhooks(health);
  const names = useMemo(
    () => [...new Set(resolved.map((w) => w.workflowName))],
    [resolved],
  );
  const runs = useTriggerRunSummaries("webhook", names, {
    enabled: state === "ready",
  });
  const [query, setQuery] = useQueryState("q", "", asString);
  const { range } = useTimeRange();
  const now = Date.now();

  const shared = routesByWorkflow(resolved);
  const rows: WebhookRow[] = resolved
    .map((w) => {
      const summary = runs.byWorkflow.get(w.workflowName);
      return {
        route: w.route,
        workflowName: w.workflowName,
        scheme: w.scheme,
        sharedWith: (shared.get(w.workflowName) ?? []).filter((r) =>
          r !== w.route
        ),
        recent: summary?.recent ?? [],
        runs: summary?.runs ?? 0,
        failed: summary?.failed ?? 0,
      };
    })
    .sort((a, b) => a.route.localeCompare(b.route));
  const [selected, select] = useFacetParams(WEBHOOK_FACET_KEYS);
  const filtered = filterWebhooks(
    applyRowFacets(rows, WEBHOOK_FACETS, selected),
    query,
  );
  const facets = rowSearchFacets(rows, WEBHOOK_FACETS, selected, select);
  const clearFilters = () => {
    setQuery("");
    for (const key of WEBHOOK_FACET_KEYS) select(key, []);
  };

  const rangeLabel = describeTimeRange(range);
  const stats: Stat[] = [
    { label: "endpoints", value: formatCount(rows.length) },
    {
      label: "webhook runs",
      value: runs.loading ? "…" : formatCount(runs.totals.runs),
      title: rangeLabel,
    },
    {
      label: "failed",
      value: runs.loading ? "…" : formatCount(runs.totals.failed),
      tone: runs.totals.failed > 0 ? "danger" : "neutral",
      title: `Webhook runs that failed · ${rangeLabel}`,
    },
  ];

  return (
    <>
      <div className="page-header">
        <h1>Webhooks</h1>
        <div className="header-right">
          {state === "ready"
            ? <StatPills stats={stats} label="Webhook summary" />
            : state === "loading"
            ? <SkeletonPills count={3} />
            : null}
        </div>
      </div>

      {state === "ready" && rows.length > 0 && (
        <TriggerFilterBar
          query={query}
          onQuery={setQuery}
          placeholder="Search routes, or filter by workflow, last run…"
          shown={filtered.length}
          total={rows.length}
          noun="webhooks"
          facets={facets}
          onClear={clearFilters}
        />
      )}

      <div className="panel">
        {state === "denied"
          ? <HealthUnavailable state={state} subject="webhooks" />
          : state === "loading"
          ? (
            <SkeletonTable
              label="Loading webhooks"
              rows={6}
              columns={webhookColumns(false).map((header) => ({
                header,
                cell: header === "Webhook runs"
                  ? "strip"
                  : header === "Route"
                  ? "mono"
                  : header === "Last run"
                  ? "pill"
                  : header === "Runs" || header === "Failed"
                  ? 24
                  : undefined,
              }))}
            />
          )
          : rows.length === 0
          ? (
            <EmptyState title="No webhooks">
              This serve has no webhook routes visible to this token. Add one
              under <code>webhooks</code> in the serve config, or with{" "}
              <code>swamp serve --webhook</code>.
            </EmptyState>
          )
          : filtered.length === 0
          ? (
            <EmptyState
              title="No webhooks match"
              action={
                <button
                  type="button"
                  className="trig-btn"
                  onClick={clearFilters}
                >
                  Clear filters
                </button>
              }
            >
              {query
                ? <>No route or workflow matches &ldquo;{query}&rdquo;.</>
                : "Nothing matches the current search and filters."}
            </EmptyState>
          )
          : (
            <WebhookTable
              rows={filtered}
              runsLoading={runs.loading}
              now={now}
              onOpen={(route) => navigateTo(webhookRoute(route))}
            />
          )}
        {state === "ready" && runs.error && (
          <div className="trig-panel-note" role="status">
            Run history couldn't be loaded: {runs.error}
          </div>
        )}
      </div>
    </>
  );
}
