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

import { useMemo } from "react";
import type { HealthSnapshot } from "../client/useHealthStream";
import { healthViewState } from "../client/health_state";
import { HealthUnavailable } from "../components/HealthUnavailable";
import { EmptyState } from "../components/EmptyState.tsx";
import { SkeletonPills, SkeletonTable } from "../components/Skeleton.tsx";
import { type Stat, StatPills } from "../components/StatPills.tsx";
import { TriggerFilterBar } from "../components/TriggerFilterBar.tsx";
import {
  webhookColumns,
  webhookRoute,
  type WebhookRow,
  WebhookTable,
} from "../components/TriggerTables.tsx";
import { navigateTo } from "../hooks/useRouter.ts";
import { asString, useQueryState } from "../client/useQueryState.ts";
import { useTriggerRunSummaries } from "../client/trigger_runs.ts";
import { useRequest } from "../client/useRequest";
import { extractArray } from "../client/extract";
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
  const filtered = filterWebhooks(rows, query);
  const filterActive = query.trim() !== "";

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
          placeholder="Search routes and workflows"
          shown={filtered.length}
          total={rows.length}
          noun="webhooks"
          active={filterActive}
          onClear={() => setQuery("")}
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
                  onClick={() => setQuery("")}
                >
                  Clear filters
                </button>
              }
            >
              No route or workflow matches “{query}”.
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
