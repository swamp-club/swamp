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

import type { ReactNode } from "react";
import type { HealthSnapshot } from "../client/useHealthStream.ts";
import { healthViewState } from "../client/health_state.ts";
import { HealthUnavailable } from "../components/HealthUnavailable.tsx";
import { useRequest } from "../client/useRequest.ts";
import { useSwamp } from "../client/SwampProvider.tsx";
import { extractArray, extractObject } from "../client/extract.ts";
import { StatusPill } from "../components/StatusPill.tsx";
import { serveConfigRows } from "./serve_config_rows.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { LoadError } from "../components/LoadError.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { loadState } from "../client/load_state.ts";
import {
  CLUSTER_COLUMNS,
  DeploymentPanelSkeleton,
  KeyValuePanelSkeleton,
  SERVE_CONFIG_KEYS,
  TablePanelSkeleton,
  WORKER_SUMMARY_KEYS,
} from "./PageSkeletons.tsx";
import { RouteLink } from "../components/RouteLink.tsx";

interface ClusterInstance {
  instanceId: string;
  hostname: string;
  startedAt: string | null;
  lastHeartbeatAt: string;
  status: string;
  address?: string;
  health?: {
    metrics: {
      throughputPerMinute: number;
      latency: { p95: number };
    };
    activeRuns: unknown[];
    workers: unknown[];
  };
}

interface WorkerInfo {
  name: string;
  status: string;
  activeDispatchIds: string[];
  capacity?: number;
}

export function System(
  { health, denied }: { health: HealthSnapshot | null; denied: boolean },
) {
  const healthState = healthViewState(health, denied);
  const clusterReq = useRequest("cluster.instances");
  const { local } = useSwamp();
  // The local dashboard has no serve, so no serve configuration to show.
  const configReq = useRequest("serve.config", undefined, { enabled: !local });
  const workersReq = useRequest("worker.list");
  const datastoreReq = useRequest("datastore.status");
  const datastoreData = datastoreReq.data;

  const instances = extractArray<ClusterInstance>(clusterReq.data);
  const configRows = serveConfigRows(configReq.data);
  const workers = extractArray<WorkerInfo>(workersReq.data);
  const clusterState = loadState(clusterReq, () => instances.length === 0);
  const workersState = loadState(workersReq, () => workers.length === 0);
  const datastoreState = loadState(datastoreReq, () => false);
  const configState = loadState(configReq, () => configRows === null);

  return (
    <>
      <div className="page-header">
        <h1>System</h1>
        <div className="header-right">
          {healthState === "loading" && (
            <Skeleton width={96} height={26} radius={20} />
          )}
          {health && (
            <div className="health-pill">
              <span className="health-dot" />
              {instances.length > 0
                ? `${
                  instances.filter((i) => i.status === "healthy").length
                }/${instances.length} healthy`
                : "Connected"}
            </div>
          )}
        </div>
      </div>

      {clusterState === "loading" && (
        <TablePanelSkeleton
          title="Cluster Instances"
          columns={CLUSTER_COLUMNS}
          rows={1}
          label="Loading cluster instances"
        />
      )}
      {clusterState === "error" && (
        <LoadError
          subject="cluster instances"
          message={clusterReq.error}
          onRetry={clusterReq.refetch}
        />
      )}
      {clusterState === "ready" && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-header">
            <div className="panel-title">
              Cluster Instances{" "}
              <span className="panel-count">{instances.length}</span>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {CLUSTER_COLUMNS.map((c) => (
                    <th key={c.header}>{c.header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {instances.map((inst) => (
                  <tr key={inst.instanceId}>
                    <td style={{ fontWeight: 500 }}>
                      {inst.hostname ?? inst.instanceId.slice(0, 8)}
                    </td>
                    <td>
                      <StatusPill status={inst.status} />
                    </td>
                    <td
                      className="mono"
                      style={{ fontSize: "0.78rem", color: "var(--text-2)" }}
                    >
                      {formatUptime(inst.startedAt)}
                    </td>
                    <td className="mono" style={{ fontSize: "0.75rem" }}>
                      {inst.health?.activeRuns?.length ?? "—"}
                    </td>
                    <td
                      className="mono"
                      style={{ fontSize: "0.78rem", color: "var(--text-2)" }}
                    >
                      {inst.health?.metrics?.throughputPerMinute?.toFixed(1) ??
                        "—"}/min
                    </td>
                    <td
                      className="mono"
                      style={{ fontSize: "0.78rem", color: "var(--text-2)" }}
                    >
                      {inst.health?.metrics?.latency?.p95
                        ? `${
                          (inst.health.metrics.latency.p95 / 1000).toFixed(1)
                        }s`
                        : "—"}
                    </td>
                    <td className="mono" style={{ fontSize: "0.75rem" }}>
                      {inst.health?.workers?.length ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {workersState === "loading" && (
        <div style={{ marginBottom: 14 }}>
          <KeyValuePanelSkeleton
            title="Workers"
            keys={WORKER_SUMMARY_KEYS}
            label="Loading workers"
          />
        </div>
      )}
      {workersState === "error" && (
        <LoadError
          subject="workers"
          message={workersReq.error}
          onRetry={workersReq.refetch}
        />
      )}
      {workersState === "empty" && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-header">
            <div className="panel-title">
              Workers <span className="panel-count">0</span>
            </div>
          </div>
          <EmptyState title="No remote workers">
            Steps run on this serve. Workers that join with{" "}
            <code>swamp worker connect</code> show here with their dispatches.
          </EmptyState>
        </div>
      )}
      {workersState === "ready" && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-header">
            <div className="panel-title">
              Workers <span className="panel-count">{workers.length}</span>
            </div>
            <RouteLink to={{ view: "workers", detail: null }}>
              Open the worker map
            </RouteLink>
          </div>
          <div style={{ padding: 0 }}>
            {WORKER_SUMMARY_KEYS.map((key) => (
              <div
                className="sys-row"
                style={{ padding: "8px 18px" }}
                key={key}
              >
                <span className="sys-key">{key}</span>
                <span className="sys-val mono">
                  {key === "Slots in use"
                    ? slotSummary(workers)
                    : workers.filter((w) => w.status === key.toLowerCase())
                      .length}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {healthState === "denied" && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <HealthUnavailable
            state={healthState}
            subject="deployment and component health"
          />
        </div>
      )}

      {/* Deployment + Datastore side by side */}
      <div className="panels-grid" style={{ marginBottom: 14 }}>
        {healthState === "loading" && <DeploymentPanelSkeleton />}
        {health && (
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">Deployment</div>
              <StatusPill
                status={health.deploymentMode === "durable"
                  ? "succeeded"
                  : health.deploymentMode === "durable (limited)"
                  ? "suspended"
                  : "cancelled"}
              />
            </div>
            <div style={{ padding: 0 }}>
              <div className="sys-row" style={{ padding: "8px 18px" }}>
                <span className="sys-key">Mode</span>
                <span
                  className="sys-val"
                  style={{
                    color: health.deploymentMode === "durable"
                      ? "var(--success)"
                      : health.deploymentMode === "local"
                      ? "var(--text-3)"
                      : "var(--warning)",
                  }}
                >
                  {health.deploymentMode}
                </span>
              </div>
              <div className="sys-row" style={{ padding: "8px 18px" }}>
                <span className="sys-key">Instances</span>
                <span className="sys-val">{instances.length || 1}</span>
              </div>
              <div className="sys-row" style={{ padding: "8px 18px" }}>
                <span className="sys-key">Workers</span>
                <span className="sys-val">{workers.length}</span>
              </div>
              <div className="sys-row" style={{ padding: "8px 18px" }}>
                <span className="sys-key">Uptime</span>
                <span className="sys-val">
                  {formatUptime(
                    new Date(Date.now() - health.uptimeMs).toISOString(),
                  )}
                </span>
              </div>
              {(!health.components || health.components.length === 0) && (
                <div className="sys-row" style={{ padding: "8px 18px" }}>
                  <span className="sys-key">components</span>
                  <span className="sys-val">
                    none visible to this token (admins see component health)
                  </span>
                </div>
              )}
              {health.components && health.components.length > 0 &&
                health.components.map((c) => (
                  <div
                    className="sys-row"
                    style={{ padding: "8px 18px" }}
                    key={c.name}
                  >
                    <span className="sys-key">{c.name}</span>
                    <span className={`sys-val ${c.healthy ? "ok" : "warn"}`}>
                      {c.healthy ? "healthy" : c.message ?? "unhealthy"}
                      {c.latencyMs !== undefined && c.latencyMs > 0 && (
                        <span
                          style={{
                            color: "var(--text-3)",
                            fontWeight: 400,
                            marginLeft: 6,
                          }}
                        >
                          {c.latencyMs}ms
                        </span>
                      )}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {datastoreState === "loading" && (
          <KeyValuePanelSkeleton
            title="Datastore"
            rows={5}
            label="Loading datastore status"
          />
        )}
        {datastoreState === "error" && (
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">Datastore</div>
            </div>
            <LoadError
              subject="datastore status"
              message={datastoreReq.error}
              onRetry={datastoreReq.refetch}
              inset
            />
          </div>
        )}
        {datastoreState === "ready" && datastoreData && (
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">Datastore</div>
            </div>
            <div style={{ padding: 0 }}>
              {Object.entries(
                extractObject<Record<string, unknown>>(datastoreData) ?? {},
              ).map(([key, val]) => (
                <div key={key}>
                  {Array.isArray(val)
                    ? (
                      <>
                        <div
                          className="sys-row"
                          style={{
                            padding: "8px 18px",
                            borderBottom: "none",
                            paddingBottom: 0,
                          }}
                        >
                          <span className="sys-key">{key}</span>
                          <span
                            className="sys-val"
                            style={{ color: "var(--text-3)" }}
                          >
                            {val.length}
                          </span>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 4,
                            padding: "2px 18px 8px",
                            borderBottom: "1px solid var(--border-subtle)",
                          }}
                        >
                          {val.map((item, i) => (
                            <span className="cron-badge" key={i}>
                              {String(item)}
                            </span>
                          ))}
                        </div>
                      </>
                    )
                    : (
                      <div
                        className="sys-row"
                        style={{ padding: "8px 18px" }}
                      >
                        <span className="sys-key">{key}</span>
                        <span className="sys-val">
                          {val === true
                            ? <span className="sys-val ok">enabled</span>
                            : val === false
                            ? "disabled"
                            : withPathBreaks(String(val))}
                        </span>
                      </div>
                    )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Serve Configuration */}
      {!local && configState === "loading" && (
        <KeyValuePanelSkeleton
          title="Serve Configuration"
          keys={SERVE_CONFIG_KEYS}
          label="Loading serve configuration"
        />
      )}
      {!local && configState === "error" && (
        <LoadError
          subject="serve configuration"
          message={configReq.error}
          onRetry={configReq.refetch}
        />
      )}
      {configRows && (
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">Serve Configuration</div>
          </div>
          <div style={{ padding: 0 }}>
            {configRows.map((row) => (
              <div
                className="sys-row"
                style={{ padding: "8px 18px" }}
                key={row.label}
              >
                <span className="sys-key">{row.label}</span>
                <span className={`sys-val ${row.ok ? "ok" : ""}`}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function slotSummary(workers: readonly WorkerInfo[]): string {
  let used = 0;
  let total = 0;
  for (const w of workers) {
    if (w.status !== "idle" && w.status !== "busy") continue;
    used += w.activeDispatchIds?.length ?? 0;
    total += w.capacity ?? 1;
  }
  return `${used}/${total}`;
}

function formatUptime(startedAt: string | null): string {
  if (!startedAt) return "—";
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms)) return "—";
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Lets a long path wrap after its separators rather than mid-name: a
 * break opportunity follows each `/` and `-`.
 */
export function withPathBreaks(text: string): ReactNode[] {
  return text.split(/(?<=[/-])/).flatMap((part, i) =>
    i === 0 ? [part] : [<wbr key={i} />, part]
  );
}
