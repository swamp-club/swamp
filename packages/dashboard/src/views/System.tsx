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

import type { HealthSnapshot } from "../client/useHealthStream";
import { useRequest } from "../client/useRequest";
import { extractArray, extractObject } from "../client/extract";
import { StatusPill } from "../components/StatusPill";

interface ClusterInstance {
  instanceId: string;
  hostname: string;
  startedAt: string;
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

interface ServeConfig {
  port?: number;
  host?: string;
  tls?: boolean;
  authMode?: string;
  scheduling?: boolean;
  dashboard?: boolean;
  webhooks?: Array<{ route: string; workflow: string }>;
}

interface WorkerInfo {
  name: string;
  status: string;
  activeDispatchIds: string[];
}

export function System({ health }: { health: HealthSnapshot | null }) {
  const { data: clusterData } = useRequest("cluster.instances");
  const { data: configData } = useRequest("serve.config");
  const { data: workersData } = useRequest("worker.list");
  const { data: datastoreData } = useRequest("datastore.status");

  const instances = extractArray<ClusterInstance>(clusterData);
  const config = extractObject<ServeConfig>(configData);
  const workers = extractArray<WorkerInfo>(workersData);

  return (
    <>
      <div className="page-header">
        <h1>System</h1>
        <div className="header-right">
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

      {instances.length > 0 && (
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
                  <th>Instance</th>
                  <th>Status</th>
                  <th>Uptime</th>
                  <th>Active Runs</th>
                  <th>Throughput</th>
                  <th>P95 Latency</th>
                  <th>Workers</th>
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

      {workers.length > 0 && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-header">
            <div className="panel-title">
              Workers <span className="panel-count">{workers.length}</span>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Status</th>
                  <th>Active Dispatches</th>
                </tr>
              </thead>
              <tbody>
                {workers.map((w) => (
                  <tr key={w.name}>
                    <td style={{ fontWeight: 500 }}>{w.name}</td>
                    <td>
                      <StatusPill status={w.status} />
                    </td>
                    <td className="mono" style={{ fontSize: "0.75rem" }}>
                      {w.activeDispatchIds?.length ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Deployment + Datastore side by side */}
      <div className="panels-grid" style={{ marginBottom: 14 }}>
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

        {datastoreData && (
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
                            : String(val)}
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
      {config && (
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">Serve Configuration</div>
          </div>
          <div style={{ padding: 0 }}>
            <div className="sys-row" style={{ padding: "8px 18px" }}>
              <span className="sys-key">Port</span>
              <span className="sys-val">{config.port ?? "—"}</span>
            </div>
            <div className="sys-row" style={{ padding: "8px 18px" }}>
              <span className="sys-key">TLS</span>
              <span className={`sys-val ${config.tls ? "ok" : ""}`}>
                {config.tls ? "enabled" : "disabled"}
              </span>
            </div>
            <div className="sys-row" style={{ padding: "8px 18px" }}>
              <span className="sys-key">Auth Mode</span>
              <span className="sys-val">{config.authMode ?? "—"}</span>
            </div>
            <div className="sys-row" style={{ padding: "8px 18px" }}>
              <span className="sys-key">Scheduling</span>
              <span className={`sys-val ${config.scheduling ? "ok" : ""}`}>
                {config.scheduling ? "enabled" : "disabled"}
              </span>
            </div>
            <div className="sys-row" style={{ padding: "8px 18px" }}>
              <span className="sys-key">Dashboard</span>
              <span className="sys-val ok">enabled</span>
            </div>
            {config.webhooks && config.webhooks.length > 0 && (
              <div className="sys-row" style={{ padding: "8px 18px" }}>
                <span className="sys-key">Webhooks</span>
                <span className="sys-val">
                  {config.webhooks.length} endpoints
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
